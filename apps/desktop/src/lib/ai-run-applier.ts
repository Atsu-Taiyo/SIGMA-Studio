import type { SigmaDocument } from "@/features/document";
import {
  mergeExternalDocumentChange,
  type MergeExternalDocumentChangeResult,
} from "@/lib/document-block-merge";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";

export type InFlightSavePromiseRef = {
  current: Promise<unknown> | null;
};

type SaveResult = {
  ok: boolean;
  error?: string;
  code?: "revision-mismatch";
};

export function trackInFlightSave<T>(
  ref: InFlightSavePromiseRef,
  task: Promise<T>,
): Promise<T> {
  const previous = ref.current;
  const tracked = Promise.allSettled(previous ? [previous, task] : [task]).then(() => undefined);
  ref.current = tracked;
  void tracked.then(() => {
    if (ref.current === tracked) {
      ref.current = null;
    }
  });
  return task;
}

export async function applyMcpEditPreview<T>(params: {
  flushOverlayChanges: () => void;
  inFlightSaveRef: InFlightSavePromiseRef;
  isCurrentDocumentDirty: () => boolean;
  saveCurrentDocumentRecord: () => Promise<SaveResult>;
  onBeforeSave: () => void;
  getDocumentAtApprovalStart: () => SigmaDocument;
  approve: () => Promise<T>;
}): Promise<
  | { ok: true; approvalResult: T; documentAtApprovalStart: SigmaDocument }
  | { ok: false; saveResult: SaveResult }
> {
  params.flushOverlayChanges();

  // 既にIPCへ渡ったautosaveを承認より先に完了させる。renderer側のbusy判定だけでは、
  // mainのrunExclusiveキューに並び済みの保存順序までは変えられないため、ここで待つ。
  await params.inFlightSaveRef.current;

  if (params.isCurrentDocumentDirty()) {
    params.onBeforeSave();
    const saveResult = await params.saveCurrentDocumentRecord();
    if (!saveResult.ok) {
      return { ok: false, saveResult };
    }
  }

  // 直前saveが実際に書いた文書をbaseにする。save中に入った打鍵はこのbaseには含まれず、
  // 承認完了時のcurrentとの差として3-way mergeされるため失われない。
  const documentAtApprovalStart = params.getDocumentAtApprovalStart();
  return {
    ok: true,
    documentAtApprovalStart,
    approvalResult: await params.approve(),
  };
}

export type AiApprovedDocumentDecision =
  | {
      kind: "adopt";
      document: SigmaDocument;
      adoptedDocumentMatchesDisk: boolean;
    }
  | {
      kind: "merge";
      document: SigmaDocument;
      adoptedDocumentMatchesDisk: boolean;
      /** prefer-theirs で解決した競合の説明。空なら競合はなかった。 */
      resolvedConflicts: string[];
    };

/**
 * 承認済みAI文書を、承認待ちの間に入った人手編集と突き合わせて「今の教材へどう反映するか」を
 * 決める。**必ず同じ教材ファイルの中で解決する** — 競合を理由に別教材へ退避したり、承認結果を
 * 取り込まずに放置したりはしない。競合した単位だけAI側 (承認された内容) を採り、競合していない
 * 人手編集はそのまま残す。採用の直前に現在の文書をundoスタックへ積むのは呼び出し側の責務で、
 * これにより競合で置き換わった入力も Ctrl+Z で戻せる。
 */
export function decideAiApprovedDocument(params: {
  documentAtApprovalStart: SigmaDocument;
  currentDocument: SigmaDocument;
  diskDocument: SigmaDocument;
  normalizedApprovedDocument: SigmaDocument;
  merge?: (
    base: SigmaDocument,
    mine: SigmaDocument,
    theirs: SigmaDocument,
  ) => MergeExternalDocumentChangeResult;
}): AiApprovedDocumentDecision {
  const {
    documentAtApprovalStart,
    currentDocument,
    diskDocument,
    normalizedApprovedDocument,
  } = params;

  // 内容の比較には updatedAt のような記録用フィールドを混ぜない。保存経路が新しい updatedAt を
  // 押した別コピーを lastSynced として覚えるため、素の構造比較では「承認のたびに人手編集あり」
  // と誤判定し、必ずマージ経路へ落ちていた。
  if (areSigmaDocumentsEquivalent(currentDocument, documentAtApprovalStart)) {
    return {
      kind: "adopt",
      document: normalizedApprovedDocument,
      adoptedDocumentMatchesDisk: areSigmaDocumentsEquivalent(normalizedApprovedDocument, diskDocument),
    };
  }

  // 承認待ちの間に実際に人手編集が入った場合だけ3-wayマージする。
  const merge = params.merge ?? ((base, mine, theirs) => mergeExternalDocumentChange(base, mine, theirs, {
    resolution: "prefer-theirs",
  }));
  const mergeResult = merge(documentAtApprovalStart, currentDocument, normalizedApprovedDocument);
  if (!mergeResult.ok) {
    // prefer-theirs では起きない想定。マージが諦めた場合でも教材を増やさず、承認された内容を
    // 採用する (直前の入力は呼び出し側が積むundoエントリから戻せる)。
    return {
      kind: "merge",
      document: normalizedApprovedDocument,
      adoptedDocumentMatchesDisk: areSigmaDocumentsEquivalent(normalizedApprovedDocument, diskDocument),
      resolvedConflicts: [mergeResult.reason],
    };
  }

  return {
    kind: "merge",
    document: mergeResult.merged,
    adoptedDocumentMatchesDisk: areSigmaDocumentsEquivalent(mergeResult.merged, diskDocument),
    resolvedConflicts: mergeResult.resolvedConflicts ?? [],
  };
}
