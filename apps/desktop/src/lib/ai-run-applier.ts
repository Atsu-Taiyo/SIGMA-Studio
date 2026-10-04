import type { SigmaDocument } from "@/features/document";
import type { ProposalMergeReport } from "@/lib/ai/proposal-merge-basis";
import {
  mergeExternalDocumentChange,
  type DocumentMergeReport,
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
      /**
       * 人手の入力をAIの内容で置き換えた単位の説明 (合成結果が検証を通らずAI側を採った、人間が
       * 消した単位をAIの編集で残した、両方の並べ替えが食い違った)。空ならそうした単位は無い。
       */
      resolvedConflicts: string[];
      /**
       * 承認待ちの間の入力とAI結果の合成が決めたこと。`humanEditedUnits` は両方が変えて合成した
       * 単位 (`$` は教材全体の情報)。提案のreplayと同じ型で、`anchorRelocated`・`legacyNoBase` は
       * この合成では常に 0。重なりが無ければすべて空・0 (MISS R3)。
       */
      mergeReport: ProposalMergeReport;
    };

/**
 * 承認済みAI文書を、承認待ちの間に入った人手編集と突き合わせて「今の教材へどう反映するか」を
 * 決める。**必ず同じ教材ファイルの中で解決する** — 競合を理由に別教材へ退避したり、承認結果を
 * 取り込まずに放置したりはしない。両方が変えた単位 (段落・図形・教材全体の情報) は三者マージで
 * 合成し、同じ段落の別の位置への入力も残す (`resolution: "merge-both"`)。合成結果が検証を通らない
 * 単位だけAI側 (承認された内容) を採る。採用の直前に現在の文書をundoスタックへ積むのは呼び出し側
 * の責務で、これにより合成・置き換えで変わった入力も Ctrl+Z で戻せる。
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
    resolution: "merge-both",
  }));
  const mergeResult = merge(documentAtApprovalStart, currentDocument, normalizedApprovedDocument);
  if (!mergeResult.ok) {
    // merge-both では起きない想定。マージが諦めた場合でも教材を増やさず、承認された内容を
    // 採用する (直前の入力は呼び出し側が積むundoエントリから戻せる)。文書全体をAI側へ退避した
    // ことになるので、退避1件として数える (MISS R3)。
    return {
      kind: "merge",
      document: normalizedApprovedDocument,
      adoptedDocumentMatchesDisk: areSigmaDocumentsEquivalent(normalizedApprovedDocument, diskDocument),
      resolvedConflicts: [mergeResult.reason],
      mergeReport: { ...toProposalMergeReport(undefined), invalidAfterMerge: 1 },
    };
  }

  return {
    kind: "merge",
    document: mergeResult.merged,
    adoptedDocumentMatchesDisk: areSigmaDocumentsEquivalent(mergeResult.merged, diskDocument),
    resolvedConflicts: mergeResult.resolvedConflicts ?? [],
    mergeReport: toProposalMergeReport(mergeResult.report),
  };
}

/** 文書の三者マージの報告を、提案のreplayと同じ形にする (レンダラの計測・表示を1つの型にする)。 */
function toProposalMergeReport(report: DocumentMergeReport | undefined): ProposalMergeReport {
  return {
    overlaps: [...(report?.overlaps ?? [])],
    capped: report?.capped ?? false,
    cappedPaths: [...(report?.cappedPaths ?? [])],
    reidentified: report?.reidentified ?? 0,
    editBeatsDelete: [...(report?.editBeatsDelete ?? [])],
    duplicateIds: [...(report?.duplicateIds ?? [])],
    invalidAfterMerge: report?.invalidAfterMerge ?? 0,
    anchorRelocated: 0,
    legacyNoBase: 0,
    humanEditedUnits: [...(report?.mergedUnits ?? [])],
  };
}
