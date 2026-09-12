"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { getDefaultDocumentSelectionId } from "@/components/editor/editor-shell/document-helpers";
import type { DocumentStorageChangeEvent } from "@/components/editor/editor-shell/document-lifecycle-types";
import {
  ensurePageLayout,
  repairDuplicateTopLevelIds,
  type DocumentBlockClock,
  type DocumentBlockIdFactory,
  type SigmaDocument,
} from "@/features/document";
import type { EditorSaveState, EditorStateUpdate } from "@/features/editor-state/types";
import {
  applyMcpEditPreview as runSerializedMcpEditPreview,
  type AiApprovedDocumentDecision,
} from "@/lib/ai-run-applier";
import { submitRejectionFeedback } from "@/lib/ai/ai-run-controller";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { findBlock } from "@/lib/document-tree";
import { createId } from "@/lib/id";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { DocumentMetadata } from "@/lib/runtime/types";
import { parseSigmaDocument, type SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";

import { aiDocumentWriteInProgressMessage } from "../adapters/tiptap/edit-lock-adapter";
import {
  deriveAiEditPreviewDiff,
  derivePostApplyHighlightIds,
  type AiApplyAnimationState,
  type AiEditPreviewState,
  type StaleMcpProposalGroup,
} from "../model/preview";
import type { AiProposalPresentationState } from "../model/proposal-presentation-model";
import { AI_APPLY_ADD_FLASH_MS, AI_APPLY_REMOVE_ANIMATION_MS } from "./proposal-feedback";
import {
  buildAiProposalApplyContext,
  deriveAiProposalApplyDecision,
  deriveAiProposalApprovedFileFeedback,
  deriveAiProposalBusyGuardFeedback,
  deriveAiProposalDismissEffects,
  deriveAiProposalResolutionTargets,
  deriveAiStaleProposalDiscardEffects,
  findAiProposalGroupByIds,
  normalizeAiProposalIds,
  selectSequentialAiRevertProposalIds,
  type AiProposalRejectEffect,
  type RejectProposalsOutcome,
} from "./proposal-action-model";

interface ApprovedDocumentAdoption {
  diskDocument: SigmaDocument;
  normalizedApprovedDocument: SigmaDocument;
  documentAtApprovalStart: SigmaDocument;
  appliedProposalIds: string[];
  approvedRevision: number;
}

export interface AiProposalActionsDependencies {
  document: SigmaDocument;
  activeFileId: string;
  activeDocumentRevision: number | null;
  activeFileIdRef: RefObject<string>;
  selectedIdRef: RefObject<string | null>;
  lastSyncedDocumentRef: RefObject<SigmaDocument>;
  metadataByFileId: ReadonlyMap<string, DocumentMetadata>;
  aiEditPreviewGroups: AiEditPreviewState[];
  staleProposalGroups: StaleMcpProposalGroup[];
  aiProposalPresentation: AiProposalPresentationState;
  mcpProposalCitations: DesktopMcpEditProposalSummary[];
  locallyResolvedProposalIdsRef: RefObject<Set<string>>;
  mcpPreviewBusyRef: RefObject<boolean>;
  setMcpPreviewBusy(value: boolean): void;
  finishMcpPreviewBusy(): void;
  flushOverlayChanges(): void;
  inFlightSavePromiseRef: RefObject<Promise<unknown> | null>;
  isCurrentDocumentDirty(): boolean;
  saveCurrentDocumentRecord: Parameters<typeof runSerializedMcpEditPreview>[0]["saveCurrentDocumentRecord"];
  setSaveState(update: EditorStateUpdate<EditorSaveState>): void;
  setStatusMessage(update: EditorStateUpdate<string>): void;
  refreshDocumentMetadatas(): Promise<void>;
  refreshMcpEditProposals(): Promise<void>;
  dispatchDocumentStorageChange(event: DocumentStorageChangeEvent): void;
  updateVersionHistoryCaptureStatus(fileId: string, result: { ok: boolean; versionCaptureError?: string }): void;
  applyAiApprovedDocument(params: ApprovedDocumentAdoption): AiApprovedDocumentDecision;
  resetEditorDocument(document: SigmaDocument, selectedId?: string | null, revision?: number | null): void;
  scheduleAutosaveRetry(): void;
  announceRecovery(issues: SigmaDocumentRecoveryIssue[], recoveryBackupPath?: string): void;
  t: Translate<"chrome">;
}

const tEditor = createCurrentLocaleTranslator("editor");
const tAi = createCurrentLocaleTranslator("ai");
const DOCUMENT_BLOCK_OPERATION_PORTS: DocumentBlockClock & DocumentBlockIdFactory = {
  now: () => new Date().toISOString(),
  createId,
};

/**
 * AI提案の決定操作と、その進行・解決・適用表示を所有する。
 * 文書の採用、Undo、autosave、外部変更の待機はhostが供給する既存の境界へ戻す。
 * render時の提案一覧と、操作中に読み直すfile/refを区別して保持する。
 */
export function useAiProposalActions({
  document,
  activeFileId,
  activeDocumentRevision,
  activeFileIdRef,
  selectedIdRef,
  lastSyncedDocumentRef,
  metadataByFileId,
  aiEditPreviewGroups,
  staleProposalGroups,
  aiProposalPresentation,
  mcpProposalCitations,
  locallyResolvedProposalIdsRef,
  mcpPreviewBusyRef,
  setMcpPreviewBusy,
  finishMcpPreviewBusy,
  flushOverlayChanges,
  inFlightSavePromiseRef,
  isCurrentDocumentDirty,
  saveCurrentDocumentRecord,
  setSaveState,
  setStatusMessage,
  refreshDocumentMetadatas,
  refreshMcpEditProposals,
  dispatchDocumentStorageChange,
  updateVersionHistoryCaptureStatus,
  applyAiApprovedDocument,
  resetEditorDocument,
  scheduleAutosaveRetry,
  announceRecovery,
  t,
}: AiProposalActionsDependencies) {
  // AiEditPanel が保持する assistant turn の 適用済み/破棄済み バッジは、この request が
  // 変化するたびに outcome に応じて確定する (applied: 適用成功, dismissed: 却下・キャンセル)。
  // targets は解決された提案グループのroom/turn帰属先。複数グループ/複数ルームが
  // 同時に存在しても、他の未解決ターンを誤って確定させないため。
  const [aiEditPreviewClearRequest, setAiEditPreviewClearRequest] = useState<{
    seq: number;
    outcome: "applied" | "dismissed";
    targets?: Array<{ roomId?: string; turnId?: string }>;
    includeResolved?: boolean;
  }>({
    seq: 0,
    outcome: "dismissed",
  });
  // Apply feedback is derived from the document that was actually returned by
  // the approval IPC. The old content is never held on screen for a pre-apply
  // exit animation; after the authoritative swap, the written nodes briefly
  // flash to show exactly what landed.
  const [aiApplyAnimation, setAiApplyAnimation] = useState<AiApplyAnimationState | null>(null);
  const aiApplyAnimationClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (aiApplyAnimationClearTimerRef.current) {
      clearTimeout(aiApplyAnimationClearTimerRef.current);
    }
  }, []);

  const clearAiEditPreview = useCallback((
    outcome: "applied" | "dismissed" = "dismissed",
    targets?: Array<{ roomId?: string; turnId?: string }>,
    includeResolved = false,
  ) => {
    setAiEditPreviewClearRequest((current) => ({ seq: current.seq + 1, outcome, targets, includeResolved }));
  }, []);

  // W2: `options.force` は「AIの提案で上書き」(競合stale提案の強制承認) から使う。承認IPC
  // 自体が force:true のとき鮮度確認(baseRevision一致・conflict無し)を丸ごとスキップするため、
  // 呼び出し元にはこの関数の戻り値 (ok/reason) を返し、AiStaleProposalNotice が group単位の
  // busy/エラー表示をできるようにする (rebaseStaleProposals と同じ形)。
  // `options.skipBusyGuard` は「復元→即承認」の1クリック合成フロー (restoreProposalFromHistory)
  // 専用: 呼び出し元がすでに busy を握っている (復元IPC実行中) 状態から続けて承認まで進めるため、
  // ここで busy を一旦解除→再取得する隙間 (他操作が割り込める窓) を作らないようにする。
  const handleMcpEditPreview = async (
    proposalIds: string[],
    options?: {
      force?: boolean;
      skipBusyGuard?: boolean;
      resolutionTargets?: Array<{ roomId?: string; turnId?: string }>;
      includeResolvedTurns?: boolean;
      disableLegacyResolutionFallback?: boolean;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const bridge = getDesktopBridge();
    if (!bridge?.storage.approveMcpEditProposals || proposalIds.length === 0) {
      setStatusMessage(tEditor("status.applyFailed"));
      return { ok: false, reason: tEditor("status.applyFailed") };
    }
    // Capture the tab that owned the clicked proposal. Some compatible desktop
    // bridges omit the optional `file` metadata even though they return the
    // approved document. The proposal surface is already scoped to this tab,
    // so this id is the safe fallback; the second equality below still prevents
    // a slow approval from being painted into a tab the user switched to.
    const requestedFileId = activeFileIdRef.current;
    if (!options?.skipBusyGuard) {
      const busyFeedback = deriveAiProposalBusyGuardFeedback(
        mcpPreviewBusyRef.current,
        aiDocumentWriteInProgressMessage(),
        setStatusMessage,
        tAi,
      );
      if (busyFeedback) {
        return busyFeedback.outcome;
      }
      mcpPreviewBusyRef.current = true;
      setMcpPreviewBusy(true);
    }
    if (aiApplyAnimationClearTimerRef.current) {
      clearTimeout(aiApplyAnimationClearTimerRef.current);
      aiApplyAnimationClearTimerRef.current = null;
    }
    // 決定B: 1プレビュー単位 = 1 apply/dismiss。ここで対応する AiEditPreviewState を
    // 引き当てられれば、その提案が実際に変更する id からアニメーション対象を導ける
    // (dismissAiEditPreviewGroup と同じ proposalIds 一致判定)。見つからなくても
    // apply自体は続行し、アニメーションだけスキップする。
    const applyContext = buildAiProposalApplyContext(
      proposalIds,
      aiEditPreviewGroups,
      staleProposalGroups,
    );
    const group = applyContext.previewGroup;
    // 削除/置換されるブロック・図形の「消える」アニメーションは、下の
    // resetEditorDocument による同期的な全文書差し替えより前に、まだ画面に
    // 残っている旧内容に対して再生する必要がある — 差し替え後では対象がもう存在しない。
    if (group) {
      const diff = deriveAiEditPreviewDiff([group]);
      const removingBlockIds = [...diff.removedBlockIds];
      const removingShapeIds = [...diff.removedShapeIds];
      if (removingBlockIds.length > 0 || removingShapeIds.length > 0) {
        setAiApplyAnimation({ removingBlockIds, removingShapeIds, addedBlockIds: [], addedShapeIds: [] });
        await new Promise((resolve) => setTimeout(resolve, AI_APPLY_REMOVE_ANIMATION_MS));
      }
    }
    try {
      const serializedApply = await runSerializedMcpEditPreview({
        // overlay canvasは250ms debounceでEditorShellへ反映するため、承認直前に同期flushする。
        // 直後に既存autosaveを待ってからdirty save→承認IPCの順に固定する。
        flushOverlayChanges,
        inFlightSaveRef: inFlightSavePromiseRef,
        isCurrentDocumentDirty,
        saveCurrentDocumentRecord,
        onBeforeSave: () => setSaveState("saving"),
        getDocumentAtApprovalStart: () => lastSyncedDocumentRef.current,
        approve: () => bridge.storage.approveMcpEditProposals!(
          proposalIds,
          options?.force ? { force: true } : undefined,
        ),
      });
      if (!serializedApply.ok) {
        if (serializedApply.saveResult.code === "revision-mismatch") {
          await refreshDocumentMetadatas();
          const message = tEditor("status.saveInFlight");
          setStatusMessage(message);
          setAiApplyAnimation(null);
          dispatchDocumentStorageChange({
            type: "document",
            fileId: requestedFileId,
            change: "changed",
            timestamp: Date.now(),
          });
          return { ok: false, reason: message };
        }
        const saveResult = serializedApply.saveResult;
        const message = saveResult.error ?? tEditor("status.preApprovalSaveFailed");
        setSaveState("error");
        setStatusMessage(message);
        setAiApplyAnimation(null);
        return { ok: false, reason: message };
      }
      const { approvalResult: result, documentAtApprovalStart } = serializedApply;
      if (!result.ok) {
        setSaveState("error");
        // 競合(強制上書き失敗)は「対象ブロックが承認前に変更されている」といった生の
        // エラー文言をそのまま出さず、競合UI(AiStaleProposalNotice)へ誘導する文言にする —
        // refreshMcpEditProposals() 後もこの提案は pending のまま (conflict付きで) 残り、
        // 下の競合バナーから引き続き選択できる。
        const message = options?.force
          ? tEditor("status.aiOverwriteFailed")
          : result.error;
        setStatusMessage(message);
        await refreshMcpEditProposals();
        setAiApplyAnimation(null);
        return { ok: false, reason: message };
      }
      // 一部が failed で pending に残った場合、それらは確定していない — 楽観的除去(Issue 2)と
      // undoエントリ(Issue 3)には実際に適用されたIDだけを記録する。
      const applyDecision = deriveAiProposalApplyDecision(
        proposalIds,
        result.failed ?? [],
        applyContext,
        {
          force: options?.force,
          resolutionTargets: options?.resolutionTargets,
          disableLegacyResolutionFallback: options?.disableLegacyResolutionFallback,
        },
        tAi,
      );
      const appliedIds = applyDecision.appliedProposalIds;
      appliedIds.forEach((proposalId) => locallyResolvedProposalIdsRef.current.add(proposalId));
      const approvedFileId = result.file?.fileId ?? requestedFileId;
      updateVersionHistoryCaptureStatus(approvedFileId, result);
      let approvedDocument = result.document;
      let approvedRevision = result.file?.revision ?? null;
      if (
        (!approvedDocument || approvedRevision === null)
        && approvedFileId === requestedFileId
        && requestedFileId === activeFileIdRef.current
      ) {
        // Never pair an approval payload with a revision inferred from an old
        // renderer cache. Recovery load returns document + observed revision as
        // one authoritative snapshot.
        const recoveryLoad = await bridge.storage.loadDocumentWithRecovery?.(approvedFileId);
        if (recoveryLoad?.ok) {
          approvedDocument = recoveryLoad.document;
          approvedRevision = recoveryLoad.revision;
        }
      }
      const approvedDocumentTitle = result.file?.title
        ?? metadataByFileId.get(approvedFileId)?.title
        ?? mcpProposalCitations.find((proposal) => (
          proposal.fileId === approvedFileId && proposalIds.includes(proposal.proposalId)
      ))?.title;
      let approvedDocumentStayedDirty = false;
      let approvedDocumentWarning: string | null = null;
      if (
        approvedDocument
        && approvedRevision !== null
        && approvedFileId === requestedFileId
        && requestedFileId === activeFileIdRef.current
      ) {
        // diskDocumentはrepair前の承認IPC保存内容。正本基準をrepair後へずらすと、
        // normalizeで生じた差分を保存済み扱いして二度とディスクへ書けなくなる。
        const diskDocument = parseSigmaDocument(approvedDocument);
        const normalizedApprovedDocument = repairDuplicateTopLevelIds(
          ensurePageLayout(diskDocument),
          DOCUMENT_BLOCK_OPERATION_PORTS,
        );
        // Issue 3: resetEditorDocument (undo/redoスタック全消し) ではなく、undo可能な1手として反映する。
        const adoption = applyAiApprovedDocument({
          diskDocument,
          normalizedApprovedDocument,
          documentAtApprovalStart,
          appliedProposalIds: appliedIds,
          approvedRevision,
        });
        approvedDocumentStayedDirty = !adoption.adoptedDocumentMatchesDisk;
        if (adoption.kind === "merge" && adoption.resolvedConflicts.length > 0) {
          // 承認待ちの間の入力とAIの変更が同じ対象で食い違った場合も、教材ファイルは増やさず
          // この1ファイルの中で解決する — 競合した単位だけ承認された内容を採る。直前の入力は
          // applyAiApprovedDocument が積んだundoエントリ (Ctrl+Z) から戻せる。
          console.warn(tEditor("status.aiMergedPreferringAi"), adoption.resolvedConflicts);
          approvedDocumentWarning = tEditor("status.aiMergedPreferringAi");
        }
        if (approvedDocumentStayedDirty) {
          scheduleAutosaveRetry();
        }
      }
      await refreshDocumentMetadatas();
      await refreshMcpEditProposals();
      if (applyDecision.resolvedTargets.length > 0) {
        clearAiEditPreview(
          "applied",
          applyDecision.resolvedTargets,
          options?.includeResolvedTurns ?? true,
        );
      } else if (applyDecision.shouldUseLegacyResolutionFallback) {
        // 帰属情報を持たない旧提案だけはactive room全体へfallbackする。
        clearAiEditPreview("applied");
      }
      setSaveState(approvedDocumentStayedDirty
        ? "saving"
        : result.versionCaptureError
          ? "warning"
          : "saved");
      const approvedFileFeedback = deriveAiProposalApprovedFileFeedback({
        approvedFileId,
        currentFileId: activeFileIdRef.current,
        approvedDocumentTitle,
        activeDocumentStatusMessage: result.versionCaptureError
          ? t("versionHistory.captureWarning")
          : approvedDocumentWarning ?? applyDecision.statusMessage,
        t: tAi,
        tEditor,
      });
      setStatusMessage(approvedFileFeedback.statusMessage);
      // Now that the new content actually exists in the (just swapped-in)
      // document, flash it green briefly instead of leaving the removal state on.
      const highlight = (
        approvedFileFeedback.kind === "paint-active-document"
        && approvedFileId === requestedFileId
        && group
      )
        ? derivePostApplyHighlightIds(group)
        : null;
      if (highlight && (highlight.blockIds.length > 0 || highlight.shapeIds.length > 0)) {
        setAiApplyAnimation({
          removingBlockIds: [],
          removingShapeIds: [],
          addedBlockIds: highlight.blockIds,
          addedShapeIds: highlight.shapeIds,
        });
        aiApplyAnimationClearTimerRef.current = setTimeout(() => {
          setAiApplyAnimation(null);
          aiApplyAnimationClearTimerRef.current = null;
        }, AI_APPLY_ADD_FLASH_MS);
      } else {
        setAiApplyAnimation(null);
      }
      return applyDecision.outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : tEditor("status.applyFailed");
      setSaveState("error");
      setStatusMessage(reason);
      setAiApplyAnimation(null);
      return { ok: false, reason };
    } finally {
      if (!options?.skipBusyGuard) {
        finishMcpPreviewBusy();
      }
    }
  };

  // 決定B: N個のプレビュー単位それぞれが自分の proposalIds で適用/破棄する。
  const applyAiEditPreviewGroup = (proposalIds: string[]) => handleMcpEditPreview(proposalIds);

  // W2: 競合stale提案の「AIの提案で上書き」。承認IPCへforce:trueを渡し、鮮度確認(選択範囲の
  // 内容一致・conflict無し)を丸ごとスキップして人間の編集を上書きする。破壊的操作なので、
  // AiStaleProposalNoticeの二次アクション(誤クリックしにくいスタイル)からしか呼ばない。
  const forceApplyStaleProposals = (proposalIds: string[]) => handleMcpEditPreview(proposalIds, { force: true });

  // 「すべて適用」: この教材の pending 提案 (全run) を1操作でまとめて承認する。run跨ぎでも
  // batch承認IPCが現在docへ順にreplayして適用し、衝突した提案だけが failed (pendingのまま
  // stale notice行き) として残る (partial success)。
  const applyAllAiEditPreviewGroups = async () => {
    const allProposalIds = aiProposalPresentation.allVisibleProposalIds;
    if (allProposalIds.length === 0) {
      return;
    }
    await handleMcpEditPreview(allProposalIds);
  };

  // 却下の結果。呼び出し側はこれを見て正しいメッセージ選択・状態更新をする責任を持つ:
  // - "empty": 却下対象がそもそも無かった (no-op)。
  // - "busy": 別のapply/dismissが進行中で何も実行しなかった (no-op)。
  // - { rejectedCount, failedCount }: 実行結果。1件の失敗で残りを取りこぼさないよう、
  //   各提案を独立に却下しており、部分失敗もあり得る。
  const rejectProposals = async (proposalIds: string[], reason?: string): Promise<RejectProposalsOutcome> => {
    if (proposalIds.length === 0) {
      return "empty";
    }
    const bridge = getDesktopBridge();
    if (!bridge) {
      return "busy";
    }
    const busyFeedback = deriveAiProposalBusyGuardFeedback(
      mcpPreviewBusyRef.current,
      aiDocumentWriteInProgressMessage(),
      setStatusMessage,
      tAi,
    );
    if (busyFeedback) {
      return "busy";
    }
    mcpPreviewBusyRef.current = true;
    setMcpPreviewBusy(true);
    try {
      // 新API (理由つき・一括) を優先し、古いpreloadビルドでは単体版にフォールバックする。
      if (bridge.storage.rejectMcpEditProposals) {
        const result = await bridge.storage.rejectMcpEditProposals(proposalIds, reason);
        if (result.ok) {
          // Issue 2: 却下も承認と同様に楽観的に確定させ、watcherの遅延再取得で復活して見えるレースを潰す。
          const failedIds = new Set(result.failed.map((failure) => failure.proposalId));
          proposalIds
            .filter((proposalId) => !failedIds.has(proposalId))
            .forEach((proposalId) => locallyResolvedProposalIdsRef.current.add(proposalId));
        }
        await refreshMcpEditProposals();
        if (!result.ok) {
          return { rejectedCount: 0, failedCount: proposalIds.length };
        }
        return { rejectedCount: result.proposals.length, failedCount: result.failed.length };
      }
      if (!bridge.storage.rejectMcpEditProposal) {
        return "busy";
      }
      const results = await Promise.allSettled(
        proposalIds.map((proposalId) => bridge.storage.rejectMcpEditProposal(proposalId)),
      );
      proposalIds
        .filter((_, index) => results[index]?.status === "fulfilled")
        .forEach((proposalId) => locallyResolvedProposalIdsRef.current.add(proposalId));
      const failedCount = results.filter((result) => result.status === "rejected").length;
      await refreshMcpEditProposals();
      return { rejectedCount: results.length - failedCount, failedCount };
    } finally {
      finishMcpPreviewBusy();
    }
  };

  const applyAiProposalRejectEffects = (effects: AiProposalRejectEffect[]) => {
    for (const effect of effects) {
      if (effect.type === "status") {
        setStatusMessage(effect.message);
        continue;
      }
      if (effect.type === "clearPreview") {
        clearAiEditPreview(effect.outcome, effect.targets);
        continue;
      }
      submitRejectionFeedback({
        roomId: effect.roomId,
        turnId: effect.turnId,
        reason: effect.reason,
        proposalSummaries: effect.proposalSummaries,
        documentIdentityKey: activeFileId,
        document,
      });
    }
  };

  const dismissAiEditPreviewGroup = async (proposalIds: string[], reason?: string) => {
    const group = findAiProposalGroupByIds(aiEditPreviewGroups, proposalIds);
    const outcome = proposalIds.length > 0 ? await rejectProposals(proposalIds, reason) : "empty";
    applyAiProposalRejectEffects(
      deriveAiProposalDismissEffects(group, outcome, reason, tAi),
    );
  };

  const discardStaleProposals = async (proposalIds: string[]) => {
    const group = findAiProposalGroupByIds(staleProposalGroups, proposalIds);
    const outcome = await rejectProposals(proposalIds);
    applyAiProposalRejectEffects(
      deriveAiStaleProposalDiscardEffects(group, outcome, tAi),
    );
  };

  const rebaseStaleProposals = async (proposalIds: string[]): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const bridge = getDesktopBridge();
    if (!bridge?.storage.rebaseMcpEditProposal || proposalIds.length === 0) {
      return { ok: false, reason: tEditor("status.regenerateUnsupported") };
    }
    if (mcpPreviewBusyRef.current) {
      return { ok: false, reason: tEditor("status.otherOperationRunning") };
    }
    mcpPreviewBusyRef.current = true;
    setMcpPreviewBusy(true);
    try {
      const results = await Promise.all(proposalIds.map((proposalId) => bridge.storage.rebaseMcpEditProposal!(proposalId)));
      await refreshMcpEditProposals();
      const failure = results.find((result): result is { ok: false; reason: string } => !result.ok);
      if (failure) {
        return { ok: false, reason: failure.reason };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : tEditor("status.regenerateFailed") };
    } finally {
      finishMcpPreviewBusy();
    }
  };

  // AIチャット履歴 / AIタスクDockの「復元」ボタン共通の1クリック合成フロー: 却下・差し戻し
  // 済みの提案を承認可否に関わらずワンクリックで本文へ戻す。復元IPC (pendingへ戻す) が成功
  // したら、そのままこの提案だけを承認IPC (handleMcpEditPreview、既存の承認導線と共通) に
  // 渡して適用まで進める。承認側で鮮度衝突が検出された場合は復元自体は成功済み(pendingに
  // 戻っている)なのでレコードはそのまま残し、既存のstale提案UIが後続で表面化するのに任せ、
  // ここでは理由だけ呼び出し元に返す。busyは復元→承認の間ずっと1つのガードで保持し続ける
  // (handleMcpEditPreviewにはskipBusyGuardを渡し、二重ガード/隙間を作らない)。
  const restoreProposalFromHistory = async (
    proposalIdsInput: string | string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const bridge = getDesktopBridge();
    if (!bridge?.storage.restoreMcpEditProposal) {
      return { ok: false, reason: tEditor("status.reproposeUnsupported") };
    }
    const busyFeedback = deriveAiProposalBusyGuardFeedback(
      mcpPreviewBusyRef.current,
      aiDocumentWriteInProgressMessage(),
      setStatusMessage,
      tAi,
    );
    if (busyFeedback) {
      return busyFeedback.outcome;
    }
    mcpPreviewBusyRef.current = true;
    setMcpPreviewBusy(true);
    try {
      const proposalIds = normalizeAiProposalIds(proposalIdsInput);
      if (proposalIds.length === 0) {
        return { ok: false, reason: tEditor("status.noEditToRestore") };
      }
      const resolutionTargets = deriveAiProposalResolutionTargets(
        mcpProposalCitations,
        proposalIds,
      );
      const restoredProposalIds: string[] = [];
      for (const proposalId of proposalIds) {
        const restored = await bridge.storage.restoreMcpEditProposal(proposalId);
        if (!restored.ok) {
          if (restoredProposalIds.length > 0) {
            if (bridge.storage.rejectMcpEditProposals) {
              await bridge.storage.rejectMcpEditProposals(restoredProposalIds);
            } else if (bridge.storage.rejectMcpEditProposal) {
              await Promise.all(restoredProposalIds.map((restoredId) => (
                bridge.storage.rejectMcpEditProposal!(restoredId)
              )));
            }
          }
          await refreshMcpEditProposals();
          return { ok: false, reason: restored.error };
        }
        restoredProposalIds.push(proposalId);
      }
      const approved = await handleMcpEditPreview(proposalIds, {
        skipBusyGuard: true,
        resolutionTargets,
        includeResolvedTurns: true,
        disableLegacyResolutionFallback: true,
      });
      if (!approved.ok) {
        return { ok: false, reason: approved.reason };
      }
      setStatusMessage(tEditor("status.editRestored"));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : tEditor("status.reproposeFailed") };
    } finally {
      finishMcpPreviewBusy();
    }
  };

  // AIチャットの適用済みウィジェット / AIタスクDock共通の「元に戻す」。提案群は一括承認時に
  // 同じrevertDocumentとappliedRevisionを共有するため、main側は1件のIDからそのバッチ全体を
  // 引いて巻き戻す (getRevertPlan)。1つのturnが複数回の保存にまたがっている場合は、バッチを
  // 新しい保存revisionから順に巻き戻す — buildSelectiveRevertDocument は「後から積んだ変更を
  // 先に剥がす」合成でしか元の教材へ戻らないため、この順序は必須。
  const revertAppliedProposals = async (
    proposalIdsInput: string | string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const bridge = getDesktopBridge();
    if (!bridge?.storage.revertMcpEditProposal) {
      const reason = tEditor("status.revertUnsupported");
      setStatusMessage(reason);
      return { ok: false, reason };
    }
    if (mcpPreviewBusyRef.current) {
      return { ok: false, reason: tEditor("status.otherOperationRunning") };
    }
    const proposalIds = normalizeAiProposalIds(proposalIdsInput);
    if (proposalIds.length === 0) {
      return { ok: false, reason: tEditor("status.noEditToRevert") };
    }
    // revert no longer requires the document to still be at the exact appliedRevision —
    // main resolves the actual revert plan (full vs. selective) and the shared batch itself
    // (see getRevertPlan). We only pick one still-approved entry point per saved batch.
    const revertTargets = selectSequentialAiRevertProposalIds(
      mcpProposalCitations,
      proposalIds,
      activeDocumentRevision,
    );
    // 排他は run 全体に一度だけ取る (反復ごとに取り直すと、途中で別の適用が割り込んで
    // 部分的に巻き戻した教材の上に保存されうる)。
    mcpPreviewBusyRef.current = true;
    setMcpPreviewBusy(true);
    try {
      let revertedBatches = 0;
      let failureReason: string | null = null;
      for (const targetProposalId of revertTargets) {
        const result = await bridge.storage.revertMcpEditProposal(targetProposalId);
        if (!result.ok) {
          failureReason = result.reason;
          break;
        }
        revertedBatches += 1;
      }
      // 多重防御: main側は巻き戻した保存バッチ全員を reverted にしているので通常は no-op
      // だが、要求IDにグループの一部だけが含まれていた場合の取りこぼしをここで揃える
      // (markMcpEditProposalsReverted は group を展開する)。全バッチを戻せたときだけ実行する
      // — 途中で失敗した状態で全IDをrevertedにすると、本文が戻っていない提案まで終端状態へ
      // 落としてしまう。
      if (failureReason === null && bridge.storage.markMcpEditProposalsReverted) {
        await bridge.storage.markMcpEditProposalsReverted(proposalIds);
      }
      const recoveryLoad = revertedBatches > 0
        ? await bridge.storage.loadDocumentWithRecovery?.(activeFileIdRef.current)
        : undefined;
      if (revertedBatches > 0) {
        const reloaded = recoveryLoad
          ? recoveryLoad.ok ? recoveryLoad.document : null
          : await bridge.storage.loadDocument(activeFileIdRef.current);
        const reloadedRevision = recoveryLoad?.ok
          ? recoveryLoad.revision
          : (await bridge.storage.listFiles())
            .find((file) => file.fileId === activeFileIdRef.current)?.revision ?? null;
        if (reloaded) {
          const nextDocument = repairDuplicateTopLevelIds(
            ensurePageLayout(parseSigmaDocument(reloaded)),
            DOCUMENT_BLOCK_OPERATION_PORTS,
          );
          const currentSelectedId = selectedIdRef.current;
          resetEditorDocument(
            nextDocument,
            currentSelectedId && findBlock(nextDocument, currentSelectedId)
              ? currentSelectedId
              : getDefaultDocumentSelectionId(nextDocument),
            reloadedRevision,
          );
        }
        await refreshDocumentMetadatas();
        setSaveState("saved");
      }
      await refreshMcpEditProposals();
      // 復旧のお知らせは、途中で失敗していても必ず出す (バックアップが取られたことを
      // 失敗メッセージで押し流さない)。announceRecovery 自身が statusMessage を上書きする
      // ので、通常メッセージを設定した「後」に呼ぶ順序は変えない。
      const announceRecoveryIfNeeded = () => {
        if (recoveryLoad?.ok) {
          announceRecovery(recoveryLoad.recoveryIssues, recoveryLoad.recoveryBackupPath);
        }
      };
      if (failureReason !== null) {
        const reason = revertedBatches > 0
          ? tEditor("status.revertPartial", { reason: failureReason, batches: revertedBatches })
          : failureReason;
        setStatusMessage(reason);
        announceRecoveryIfNeeded();
        return { ok: false, reason };
      }
      setStatusMessage(tEditor("status.editReverted"));
      announceRecoveryIfNeeded();
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : tEditor("status.revertFailed");
      setStatusMessage(reason);
      return { ok: false, reason };
    } finally {
      finishMcpPreviewBusy();
    }
  };

  return {
    aiApplyAnimation,
    aiEditPreviewClearRequest,
    clearAiEditPreview,
    applyAiEditPreviewGroup,
    forceApplyStaleProposals,
    applyAllAiEditPreviewGroups,
    dismissAiEditPreviewGroup,
    discardStaleProposals,
    rebaseStaleProposals,
    restoreProposalFromHistory,
    revertAppliedProposals,
  };
}
