import type { RefObject } from "react";

import { ensurePageLayout, repairDuplicateTopLevelIds, type DocumentBlockClock, type DocumentBlockIdFactory, type SigmaDocument } from "@/features/document";
import type { EditorSaveState, EditorStateUpdate } from "@/features/editor-state/types";
import { mergeExternalDocumentChange } from "@/lib/document-block-merge";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import { findBlock } from "@/lib/document-tree";
import type { Translate } from "@/lib/i18n";
import { getAppRuntime } from "@/lib/runtime/app-runtime";
import { saveWorkspaceState } from "@/lib/storage";

import { getDefaultDocumentSelectionId } from "./document-helpers";
import type { DocumentStorageChangeEvent } from "./document-lifecycle-types";
import { decideExternalDocumentChange, nextObservedRevisionAfterQuietOutcome, type SuccessfulDocumentSave } from "./document-state-sync";
import { isDesktopStorageChangeEvent, uniqueStringIds, updateDegradedWatcherScopes, type DegradedWatcherScope } from "./workspace-request";

export interface DocumentStorageSynchronizationOptions {
  activeFileIdRef: RefObject<string>;
  documentRef: RefObject<SigmaDocument>;
  lastSyncedDocumentRef: RefObject<SigmaDocument>;
  documentObservedRevisionRef: RefObject<number | null>;
  selectedIdRef: RefObject<string | null>;
  openFileIdsRef: RefObject<string[]>;
  workspaceReadyRef: RefObject<boolean>;
  externalChangeFileIdsRef: RefObject<Set<string>>;
  pendingAutoAppliedProposalIdsByFileRef: RefObject<Map<string, string[]>>;
  inFlightSavePromiseRef: RefObject<Promise<unknown> | null>;
  successfulDocumentSavesRef: RefObject<Map<string, SuccessfulDocumentSave<SigmaDocument>>>;
  documentStorageChangeProcessorRef: RefObject<((event: DocumentStorageChangeEvent) => void) | null>;
  blockOperationPorts: DocumentBlockClock & DocumentBlockIdFactory;
  refreshDocumentMetadatas(): Promise<void>;
  refreshMcpEditProposals(): Promise<void>;
  switchAwayFromDeletedFile(fileId: string): Promise<void>;
  loadWorkspaceDocument(fileId: string): Promise<{ document: SigmaDocument; observedRevision: number } | null>;
  isCurrentDocumentDirty(): boolean;
  saveUnsavedEditBackup(): Promise<{ fileId: string } | null>;
  applyAutoApprovedExternalDocument(params: {
    nextDocument: SigmaDocument;
    syncedDocument: SigmaDocument;
    syncedRevision: number;
    proposalIds: string[];
  }): void;
  applyMergedExternalDocument(document: SigmaDocument, syncedDocument: SigmaDocument, syncedRevision: number): void;
  resetEditorDocument(document: SigmaDocument, selectedId?: string | null, revision?: number | null): void;
  setOpenFileIds(fileIds: string[]): void;
  setActiveFileId(fileId: string): void;
  setSaveState(update: EditorStateUpdate<EditorSaveState>): void;
  setStatusMessage(update: EditorStateUpdate<string>): void;
  setDegradedWatcherScopes(update: EditorStateUpdate<DegradedWatcherScope[]>): void;
  dispatchDocumentStorageChange(event: DocumentStorageChangeEvent): void;
  tEditor: Translate<"editor">;
}

/** 文書通知の購読から再読込・採用までを所有する。採用・履歴・保存の境界はhostへ返す。 */
export function registerDocumentStorageSynchronization({
  activeFileIdRef,
  documentRef,
  lastSyncedDocumentRef,
  documentObservedRevisionRef,
  selectedIdRef,
  openFileIdsRef,
  workspaceReadyRef,
  externalChangeFileIdsRef,
  pendingAutoAppliedProposalIdsByFileRef,
  inFlightSavePromiseRef,
  successfulDocumentSavesRef,
  documentStorageChangeProcessorRef,
  blockOperationPorts: DOCUMENT_BLOCK_OPERATION_PORTS,
  refreshDocumentMetadatas,
  refreshMcpEditProposals,
  switchAwayFromDeletedFile,
  loadWorkspaceDocument,
  isCurrentDocumentDirty,
  saveUnsavedEditBackup,
  applyAutoApprovedExternalDocument,
  applyMergedExternalDocument,
  resetEditorDocument,
  setOpenFileIds,
  setActiveFileId,
  setSaveState,
  setStatusMessage,
  setDegradedWatcherScopes,
  dispatchDocumentStorageChange,
  tEditor,
}: DocumentStorageSynchronizationOptions): () => void {
  let cancelled = false;
  let reloadRevision = 0;
  const processDocumentChange = (event: DocumentStorageChangeEvent) => {
    const eventFileId = event.fileId;
    const revision = ++reloadRevision;
    if (eventFileId === activeFileIdRef.current) {
      externalChangeFileIdsRef.current.add(eventFileId);
    }

    void (async () => {
      try {
        await refreshDocumentMetadatas();

        if (cancelled || revision !== reloadRevision || eventFileId !== activeFileIdRef.current) {
          return;
        }

        if (event.change === "deleted") {
          // 教材ごと消えたので、溜めた提案 id を持ち越す先が無い。
          pendingAutoAppliedProposalIdsByFileRef.current.delete(eventFileId);
          await switchAwayFromDeletedFile(eventFileId);
          return;
        }

        // 進行中の保存が記録されるまで分類しない。self-write 判定は
        // `successfulDocumentSavesRef` を読むが、そこへ書くのは保存完了後なので、
        // **エコーが先に来ると 1 つ前の保存を見て「外部変更」と誤判定する** —— そのまま
        // 古い lastSynced に対してマージし、衝突すれば履歴を全消しする。autosave 側
        // (`inFlightSavePromiseRef` の drain) と同じ待ち方をここでも通す。
        while (inFlightSavePromiseRef.current) {
          await inFlightSavePromiseRef.current.catch(() => undefined);
          if (cancelled || revision !== reloadRevision || eventFileId !== activeFileIdRef.current) {
            return;
          }
        }

        const loaded = await loadWorkspaceDocument(eventFileId);
        if (cancelled || revision !== reloadRevision || eventFileId !== activeFileIdRef.current) {
          return;
        }

        if (!loaded) {
          // 読めなかった以上この通知で採用は起きない。id を残すと次の書き込みへ持ち越す。
          pendingAutoAppliedProposalIdsByFileRef.current.delete(eventFileId);
          setSaveState("error");
          setStatusMessage(tEditor("status.externalLoadFailed"));
          return;
        }

        const migrated = repairDuplicateTopLevelIds(
          ensurePageLayout(loaded.document),
          DOCUMENT_BLOCK_OPERATION_PORTS,
        );

        // **読んだら消す。** 取り残すと、次の純粋な他者書き込みが own automation と誤判定され、
        // 1 手として積まれて ⌘Z + autosave で相手の変更をディスクから消す。
        // ここから分類までは await を挟まないので、読み切ってしまってよい。
        //
        // 逆に、この行より**手前**の早期 return (通知が新しい実行に追い越された / タブが
        // 変わった) では消さない —— 後続の実行が同じ蓄積を読む必要がある。
        const autoAppliedProposalIds = pendingAutoAppliedProposalIdsByFileRef.current.get(eventFileId)
          ?? event.autoAppliedProposalIds
          ?? [];
        pendingAutoAppliedProposalIdsByFileRef.current.delete(eventFileId);

        // 分類だけは純関数へ出してある (`decideExternalDocumentChange`)。この関数は 2 つの
        // await と 5 種の setState を抱えていて、そのままでは「どの入力でどこへ行くか」を
        // 誰も確かめられなかった。
        const outcome = decideExternalDocumentChange<SigmaDocument>({
          fileId: eventFileId,
          loadedDocument: migrated,
          loadedRevision: loaded.observedRevision,
          currentDocument: documentRef.current,
          lastSyncedDocument: lastSyncedDocumentRef.current,
          lastSuccessfulSave: successfulDocumentSavesRef.current.get(eventFileId),
          isDirty: isCurrentDocumentDirty(),
          // undo できるかは作者で決まる。AI 承認は自分たちの適用なので 1 手として積み、
          // 他者の書き込みは積まない (積むと ⌘Z + autosave でディスク上の変更を消す)。
          //
          // 提案 id の有無で「自分たちのものか」を判定できるのは、**次の 2 つの前提が
          // 成り立っている間だけ**:
          //
          // 1. `autoAppliedProposalIds` を付ける箇所が `electron/main.ts` の
          //    `...(options.autoApplied ? { autoAppliedProposalIds: [proposalId] } : {})`
          //    ただ 1 つで、発行元はこのアプリ自身の自動承認経路だけ。MCP 由来の書き込みも
          //    「アプリ自身の自動化が提案を適用した」ものなので own で正しい。
          // 2. `app.requestSingleInstanceLock()` と単一の `mainWindow` により、**エディタの
          //    レンダラは常に 1 つ**。だから「別ウィンドウの自動適用を自分のものと誤認する」
          //    経路が存在しない。
          //
          // **マルチウィンドウを入れるならここを見直すこと。** 他ウィンドウの自動適用が own と
          // 誤判定されると、その変更が 1 手として積まれ、⌘Z でメモリから消えたあと dirty 判定の
          // autosave が採用済み revision で書き戻して、相手の変更をディスク上から消す。
          isOwnAutomation: autoAppliedProposalIds.length > 0,
          areEquivalent: areSigmaDocumentsEquivalent,
          merge: (base, mine, theirs) => mergeExternalDocumentChange(
            base,
            mine,
            theirs,
            autoAppliedProposalIds.length > 0 ? { resolution: "prefer-theirs" } : undefined,
          ),
        });

        if (outcome.kind === "selfWrite" || outcome.kind === "alreadyInSync") {
          // 自分の保存が返ってきただけ / Payloadが正本と構造的に同一。どちらも新しい
          // revisionを採用するだけで、画面も履歴も動かさない。
          //
          // **観測 revision の採り方は結末ごとに違う** (`selfWrite` は後退させない /
          // `alreadyInSync` はディスクの言い分をそのまま採る)。理由は関数側に書いてある。
          documentObservedRevisionRef.current = nextObservedRevisionAfterQuietOutcome({
            outcome: outcome.kind,
            currentObservedRevision: documentObservedRevisionRef.current,
            loadedRevision: loaded.observedRevision,
          });
          lastSyncedDocumentRef.current = migrated;
          return;
        }

        if (outcome.kind === "adoptAsHistoryStep") {
          // 自分たちの自動適用 (AI 承認)。ユーザーから見れば自分の操作なので、現在の文書を
          // 1 手として積んでから採用する。**どの並びでも履歴は消さない。**
          const backup = outcome.backupFirst ? await saveUnsavedEditBackup() : null;
          if (cancelled || revision !== reloadRevision || eventFileId !== activeFileIdRef.current) {
            return;
          }
          applyAutoApprovedExternalDocument({
            nextDocument: outcome.document,
            syncedDocument: migrated,
            syncedRevision: loaded.observedRevision,
            proposalIds: autoAppliedProposalIds,
          });
          if (backup) {
            // 退避先を開いておかないと、逃がした未保存の編集にユーザーが辿り着けない。
            const nextOpenFileIds = uniqueStringIds([
              ...openFileIdsRef.current,
              backup.fileId,
              eventFileId,
            ]);
            setOpenFileIds(nextOpenFileIds);
            setActiveFileId(eventFileId);
            await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: eventFileId });
          }
          await refreshDocumentMetadatas();
          setSaveState("saved");
          setStatusMessage(backup
            ? tEditor("status.externalLoadedSetAside")
            : outcome.replacesWholeDocument
              ? tEditor("status.externalLoaded")
              : tEditor("status.aiMerged"));
          return;
        }

        if (outcome.kind === "adoptMergedFromForeignWrite") {
          // 他者の書き込みをマージして採用。**履歴には積みも消しもしない** (これは編集では
          // なく同期)。打鍵中に着弾するので選択やパネルにも触らない軽量経路。
          applyMergedExternalDocument(outcome.merged, migrated, loaded.observedRevision);
          await refreshDocumentMetadatas();
          setSaveState("saved");
          setStatusMessage(tEditor("status.aiMerged"));
          return;
        }

        // ここから下だけが履歴を失う経路 (他者の書き込みが未保存の編集とマージできなかった)。
        const backup = await saveUnsavedEditBackup();
        if (cancelled || revision !== reloadRevision || eventFileId !== activeFileIdRef.current) {
          return;
        }

        const currentSelectedId = selectedIdRef.current;
        const nextSelectedId = currentSelectedId && findBlock(migrated, currentSelectedId)
          ? currentSelectedId
          : getDefaultDocumentSelectionId(migrated);
        const nextOpenFileIds = uniqueStringIds([
          ...openFileIdsRef.current,
          ...(backup ? [backup.fileId] : []),
          eventFileId,
        ]);

        resetEditorDocument(migrated, nextSelectedId, loaded.observedRevision);
        setOpenFileIds(nextOpenFileIds);
        setActiveFileId(eventFileId);
        await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: eventFileId });
        await refreshDocumentMetadatas();
        setSaveState("saved");
        setStatusMessage(backup
          ? tEditor("status.externalLoadedSetAside")
          : tEditor("status.externalLoaded"));
      } finally {
        externalChangeFileIdsRef.current.delete(eventFileId);
      }
    })().catch((error) => {
      if (cancelled) {
        return;
      }
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.externalLoadFailed"));
    });
  };
  documentStorageChangeProcessorRef.current = processDocumentChange;

  // desktop は fs.watch、web は他タブからの BroadcastChannel。どちらも同じ形の
  // 変更イベントで届くので、購読側は保存先を意識しない。
  const unsubscribe = getAppRuntime().library.onChange((event) => {
    if (!isDesktopStorageChangeEvent(event) || !workspaceReadyRef.current) {
      return;
    }

    if (event.type === "workspace" || event.type === "library") {
      void refreshDocumentMetadatas();
      return;
    }

    if (event.type === "mcpProposal") {
      void refreshMcpEditProposals();
      return;
    }

    if (event.type === "watcher") {
      setDegradedWatcherScopes((current) => updateDegradedWatcherScopes(current, event));
      return;
    }

    if (event.type === "documentVersion") {
      return;
    }

    // approve/revertだけでなく、正本文書を返さないreject/rebase中にも通知は届き得る。
    // active fileの最新1件を保留し、busy解除後に通常のload/merge経路へ必ず流す。
    // approve/revert自身の通知は、返却済み正本と構造的に同一なら下の比較で自然にno-opになる。
    dispatchDocumentStorageChange(event);
  });

  return () => {
    cancelled = true;
    if (documentStorageChangeProcessorRef.current === processDocumentChange) {
      documentStorageChangeProcessorRef.current = null;
    }
    unsubscribe();
  };
}
