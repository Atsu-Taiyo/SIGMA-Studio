import { classifyBoundarySaveSafety } from "./boundary-save-policy";

export function syncDocumentRefWhenStateIsCurrent<T>(
  documentRef: { current: T },
  document: T,
  documentStateStamp: number,
  latestDocumentRevision: number,
): boolean {
  if (documentStateStamp !== latestDocumentRevision) {
    return false;
  }

  documentRef.current = document;
  return true;
}

export interface TimestampedDocumentChange {
  timestamp: number;
}

export interface DocumentSaveResult {
  ok: boolean;
  error?: string;
  code?: "revision-mismatch";
  skipped?: true;
  skippedReason?: string;
}

export interface SuccessfulDocumentSave<T> {
  fileId: string;
  document: T;
  revision: number;
  dirtyRevision: number;
}

/**
 * Records every successful per-file save, while updating active-document refs
 * only when that same file is still active.
 */
export function recordSuccessfulDocumentSave<T>(params: {
  savedByFileId: Map<string, SuccessfulDocumentSave<T>>;
  save: SuccessfulDocumentSave<T>;
  activeFileId: string;
  observedRevisionRef: { current: number | null };
  lastSavedDocumentRef: { current: T };
  lastSavedDirtyRevisionRef: { current: number };
  lastSyncedDocumentRef: { current: T };
}): boolean {
  params.savedByFileId.set(params.save.fileId, params.save);
  if (params.save.fileId !== params.activeFileId) {
    return false;
  }

  params.observedRevisionRef.current = params.save.revision;
  params.lastSavedDocumentRef.current = params.save.document;
  params.lastSavedDirtyRevisionRef.current = params.save.dirtyRevision;
  params.lastSyncedDocumentRef.current = params.save.document;
  return true;
}

/** A document replacement may continue only when the boundary leaves no unsaved edits or save failure. */
export async function saveBeforeDocumentReplacement(params: {
  save: () => Promise<DocumentSaveResult>;
  isDirtyAfterSave: () => boolean;
  onFailure: (result: DocumentSaveResult) => void | Promise<void>;
}): Promise<boolean> {
  const result = await params.save();
  const safety = classifyBoundarySaveSafety({
    saveOk: result.ok,
    skipped: result.skipped === true,
    dirty: params.isDirtyAfterSave(),
  });
  if (safety === "safe") {
    return true;
  }
  await params.onFailure(result);
  return false;
}

/** busy中に届いた文書通知を捨てず、timestampが最新の1件だけを保持する。 */
export function queueLatestDocumentChange<T extends TimestampedDocumentChange>(
  pendingRef: { current: T | null },
  event: T,
): void {
  if (
    pendingRef.current === null
    || event.timestamp >= pendingRef.current.timestamp
  ) {
    pendingRef.current = event;
  }
}

/** busy解除時に保留中の最新通知を一度だけ取り出す。 */
export function takeLatestDocumentChange<T>(
  pendingRef: { current: T | null },
): T | null {
  const pending = pendingRef.current;
  pendingRef.current = null;
  return pending;
}

/**
 * 外部変更通知をどう扱うか。**分類だけを純関数にした** —— 呼び出し元は 2 つの await と
 * 8 分岐と 5 種の setState を抱えていて、そのままでは「どの入力でどこへ行くか」を
 * 誰も確かめられない。
 *
 * **undo できるかは「誰が書いたか」で決まる。**
 *
 * - **自分たちの自動適用 (AI 承認)** → 履歴に 1 手として積む。ユーザーから見れば自分の
 *   操作の結果なので ⌘Z で戻せなければならない。
 * - **本物の外部書き込み (別ウィンドウ・MCP・git など他者の書き込み)** → 積まない。
 *   これは「編集」ではなく「同期」で、**積むとディスク上のデータを壊す**: 記録される
 *   中身は採用前の文書なので、⌘Z でその外部変更がメモリから消え、dirty 判定になった
 *   autosave が採用済み revision でそれを書き戻して、外部の書き手の変更を消す。
 *
 * `backupAndReload` だけが `resetEditorDocument` (= `documentHistory.clear()` +
 * オーバーレイ再マウント) へ行く。**履歴を全消しする権利をこの 1 ケースに絞る**のが
 * この関数の存在理由。
 */
export type ExternalDocumentChangeOutcome<T> =
  /** 自分の保存が watcher で返ってきただけ。revision だけ採用して何もしない。 */
  | { kind: "selfWrite" }
  /** 正本と構造的に同一。revision だけ採用する。 */
  | { kind: "alreadyInSync" }
  /**
   * **自分たちの自動適用**。現在の文書を 1 手として積んでから採用する。
   *
   * - `backupFirst` … 未保存の編集がマージできなかったので、採用の前に別教材へ退避する。
   * - `replacesWholeDocument` … 採用するのが文書まるごと (マージ結果ではない)。**呼び出し元が
   *   どのステータス文言を出すかだけを決める。**
   *
   *   全文差し替えでも UI の後始末 (overlay 再マウント・グラフパネル・pin 済み AI 参照の破棄) は
   *   **していない** —— 自分たちの適用でそこまでやるのは main 時点でも同じで、本 WI で挙動を
   *   広げないため。開いたままのパネルが AI 適用で消えたブロックを指し続ける件は follow-up。
   */
  | { kind: "adoptAsHistoryStep"; document: T; backupFirst: boolean; replacesWholeDocument: boolean }
  /**
   * **他者の書き込み**をマージして採用する。履歴には触らない (積みも消しもしない)。
   *
   * 打鍵中に着弾するので、選択やパネルにも触らない軽量経路。
   */
  | { kind: "adoptMergedFromForeignWrite"; merged: T }
  /**
   * **他者の書き込み**を丸ごと採用する。未保存の編集があれば退避し、**履歴は消す**。
   *
   * 履歴を残せない理由: undo は文書を丸ごと差し替えるので、採用前のスナップショットが
   * スタックに残っていると ⌘Z 1 回で外部の変更がメモリから消え、dirty 判定になった
   * autosave が採用済み revision (CAS 通過) で書き戻して**ディスク上の他者の変更を消す**。
   */
  | { kind: "backupAndReload"; reason: string };

/**
 * 「画面も履歴も動かさない」結末のあと、観測 revision に何を採るか。
 *
 * **`selfWrite` と `alreadyInSync` で答えが違う。**
 *
 * `selfWrite` は自分の保存のエコーで、述語からして `loaded <= lastSave.revision`。ここで
 * 古い watcher 読み取りをそのまま代入すると ref が後退し、次の保存が CAS 失敗する
 * (「他の変更を読み込んでいます」)。だから**後退させない**。
 *
 * `alreadyInSync` は「ディスクの中身が正本と構造的に同一」なだけで、revision の出所は
 * ディスク側。台帳の再構築やバックアップからの復元で**正当に下がる**ことがあり、そこで
 * 上に張り付けると以降の `ObservedDocumentWrite` が**すべて** CAS 失敗して、
 * **再起動するまで保存できなくなる**。ディスクの言い分をそのまま採るのが正しい。
 */
export function nextObservedRevisionAfterQuietOutcome(params: {
  outcome: "selfWrite" | "alreadyInSync";
  currentObservedRevision: number | null;
  loadedRevision: number;
}): number {
  if (params.outcome === "alreadyInSync") {
    return params.loadedRevision;
  }
  return Math.max(params.currentObservedRevision ?? params.loadedRevision, params.loadedRevision);
}

export function decideExternalDocumentChange<T>(params: {
  fileId: string;
  loadedDocument: T;
  loadedRevision: number;
  currentDocument: T;
  lastSyncedDocument: T;
  lastSuccessfulSave: SuccessfulDocumentSave<T> | undefined;
  isDirty: boolean;
  /** この変更が自分たちの自動適用 (AI 承認) 由来か。undo できるかがこれで決まる。 */
  isOwnAutomation: boolean;
  areEquivalent: (a: T, b: T) => boolean;
  merge: (base: T, mine: T, theirs: T) =>
    | { ok: true; merged: T }
    | { ok: false; reason: string };
}): ExternalDocumentChangeOutcome<T> {
  if (params.areEquivalent(params.loadedDocument, params.currentDocument)) {
    return { kind: "alreadyInSync" };
  }

  // 自分の保存が返ってきただけか。**内容の等価判定では見分けられない** —— 通知を受けてから
  // 文書を読み直すまでに 2 つの await があり、その間の打鍵で `currentDocument` が動く。
  //
  // 判定は revision だけで足りる。保存は CAS (`ObservedDocumentWrite`) で守られていて
  // revision はファイル単位で単調増加するので、外部 writer が我々のあとに書けば必ず
  // `> lastSave.revision` になる。
  //
  // **内容の一致を AND で足してはいけない。** 比べる相手は「正規化後のディスク内容」と
  // 「正規化前の自分が書いた文書」で、読み込み時の正規化ドリフトでちょうど失敗する。
  // とりわけ最上位 id が重複した文書では `repairDuplicateTopLevelIds` がリロードのたびに
  // 新しい id を振り直すので**常に不一致**になり、判定を弱めるだけになる。
  //
  // **前提**: `lastSuccessfulSave.revision` は storage 層の戻り値 (`result.revision ??
  // observedRevision + 1`) で、フォールバックは推測を含む。**過大に外すと本物の他者書き込みが
  // selfWrite として黙って握り潰され** (採用されないまま次の保存が上書きする)、過小に外すと
  // 自分の保存が外部扱いになって余計なマージが走る。storage 層が revision を単調増加で
  // 返し続けることがこの判定の前提。
  const lastSave = params.lastSuccessfulSave;
  if (
    lastSave !== undefined
    && lastSave.fileId === params.fileId
    && params.loadedRevision <= lastSave.revision
  ) {
    return { kind: "selfWrite" };
  }

  if (params.isOwnAutomation) {
    // 自分たちの適用はユーザーから見れば自分の操作。**どの並びでも履歴を消さない。**
    if (!params.isDirty) {
      return {
        kind: "adoptAsHistoryStep",
        document: params.loadedDocument,
        backupFirst: false,
        replacesWholeDocument: true,
      };
    }
    const ownMerge = params.merge(params.lastSyncedDocument, params.currentDocument, params.loadedDocument);
    return ownMerge.ok
      ? {
          kind: "adoptAsHistoryStep",
          document: ownMerge.merged,
          backupFirst: false,
          replacesWholeDocument: false,
        }
      : {
          // マージできなくても履歴は消さない。未保存の編集を退避してから 1 手として積む。
          kind: "adoptAsHistoryStep",
          document: params.loadedDocument,
          backupFirst: true,
          replacesWholeDocument: true,
        };
  }

  if (params.isDirty) {
    const mergeResult = params.merge(params.lastSyncedDocument, params.currentDocument, params.loadedDocument);
    if (mergeResult.ok) {
      // ブロック単位で安全にマージできた (同じ対象を両方が触っていない)。人間の未保存編集は
      // マージ結果にそのまま残るので、その後の自動保存で自然に永続化される。
      return { kind: "adoptMergedFromForeignWrite", merged: mergeResult.merged };
    }
    return { kind: "backupAndReload", reason: mergeResult.reason };
  }

  // 他者による全文置換。未保存の編集は無いので退避するものも無いが、履歴は消す (上記の理由)。
  return { kind: "backupAndReload", reason: "foreign whole-document replacement" };
}
