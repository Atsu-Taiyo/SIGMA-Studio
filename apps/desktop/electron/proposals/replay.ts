import {
  type AiEditSessionDraft,
} from "@/lib/ai/sigma-doc-edit-schema";
import { rewriteAiOverlayShapeReplacementDrafts } from "@/lib/ai/overlay-shape-replacement";
import {
  assertAppliedProposalHasRealChanges,
  collectReplaceTargetIds,
  orderItemsByReplacementAncestry,
  replayProposalDraft,
  replayProposalDraftMerging,
} from "@/lib/ai/proposal-replay";
import {
  combineProposalMergeReports,
  createEmptyProposalMergeReport,
  type ProposalMergeBasis,
  type ProposalMergeReport,
} from "@/lib/ai/proposal-merge-basis";
import { findBlock } from "@/lib/document-tree";
import { type SigmaDocument } from "@/features/document";
import { type LocalMcpEditProposal, selectGroupRepresentatives } from "./contracts";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

// The pure replay lives in `lib/ai/proposal-replay.ts` so the renderer can run the same function;
// these re-exports keep the Electron and MCP entry points (and their identity) unchanged.
export {
  assertAppliedProposalHasRealChanges,
  collectReplaceTargetIds,
  replayProposalDraft,
};

const te = createCurrentLocaleTranslator("error");

export interface MergeProposalDraftsResult {
  document: SigmaDocument;
  appliedIds: string[];
  failed: { proposalId: string; error: string }[];
  /** Per applied proposal: what its merging replay decided (legacy records count `legacyNoBase`). */
  reports: Record<string, ProposalMergeReport>;
  /** All applied proposals' reports combined (what the approval returns for counting). */
  report: ProposalMergeReport;
}

/**
 * Replays one proposal of a batch: with a merge basis through the merging replay (the human's edits
 * since the base are kept), otherwise through the legacy replay, counted as `legacyNoBase`.
 */
export function replayProposalForApproval(
  document: SigmaDocument,
  proposal: { draft: AiEditSessionDraft; mergeBasis?: ProposalMergeBasis },
): { nextDocument: SigmaDocument; report: ProposalMergeReport } {
  if (proposal.mergeBasis) {
    const merged = replayProposalDraftMerging(document, proposal.draft, proposal.mergeBasis);
    return { nextDocument: merged.nextDocument, report: merged.report };
  }
  return {
    nextDocument: replayProposalDraft(document, proposal.draft).nextDocument,
    report: { ...createEmptyProposalMergeReport(), legacyNoBase: 1 },
  };
}

// 一括承認 (approve-mcp-edit-proposals) の中核ロジック: 作成順に並んだ複数提案の draft を、
// 現在のドキュメントへ順に累積適用する。1件が適用できなくても (対象ブロックが先行編集で
// 消えた、overlay図形削除がoverlay側の整合性検証で弾かれた、等)、全体を失敗させず適用できた
// ものだけ反映する。失敗した提案は理由つきで failed に集め、呼び出し元 (main.ts) が pending の
// まま残しつつ呼び出し元(renderer)に伝えられるようにする — 以前は catch{} で握りつぶしていて、
// 削除などが「何も起きていないように見える」まま黙って残り続けるバグがあった。
// ただし、同じ図形IDを要求した delete+insert は1つの論理置換として扱う。途中失敗で旧図形だけ
// 消える状態を作らないよう、その組を含む承認バッチは全体を原子的に適用・ロールバックする。
// テスト容易性のため、提案の読み込み・保存 (ファイルIO) から純粋な合成部分だけを切り離してある。
export function mergeProposalDraftsIntoDocument(
  baseDocument: SigmaDocument,
  orderedProposals: Array<{
    proposalId: string;
    draft: AiEditSessionDraft;
    createdAt?: string;
    source?: { toolName: string; toolArgs: unknown };
    groupId?: string;
    groupPosition?: number;
    mergeBasis?: ProposalMergeBasis;
  }>,
): MergeProposalDraftsResult {
  // グループ各レコードは、どのmemberを単体承認しても全操作を適用できるよう同じ累積draftを持つ。
  // 複数選択に全memberが含まれた場合は最後のmemberだけをreplayし、累積draftを二重適用しない。
  // Shape replacement detection must be done on orderedProposals (all group members visible)
  // before collapsing, so that deletion in one group member and insertion in another are
  // correctly recognized as a replacement pair.
  const replacementBatch = rewriteAiOverlayShapeReplacementDrafts(baseDocument, orderedProposals);
  const canonicalProposals = selectGroupRepresentatives(orderedProposals);
  // Filter the replacement batch to only include canonical proposals
  const filteredReplacementBatch = replacementBatch.pairs.length > 0
    ? {
        proposals: replacementBatch.proposals.filter((p) => canonicalProposals.some((c) => c.proposalId === p.proposalId)),
        pairs: replacementBatch.pairs,
      }
    : replacementBatch;

  if (filteredReplacementBatch.pairs.length > 0) {
    let replacementDocument = baseDocument;
    const replacementReports: Record<string, ProposalMergeReport> = {};
    for (const proposal of filteredReplacementBatch.proposals) {
      try {
        const replayed = replayProposalForApproval(replacementDocument, proposal);
        replacementDocument = replayed.nextDocument;
        replacementReports[proposal.proposalId] = replayed.report;
      } catch (error) {
        return {
          document: baseDocument,
          appliedIds: [],
          failed: [{
            proposalId: proposal.proposalId,
            error: error instanceof Error ? error.message : te("electron.proposalStore.shapeReplacementFailed"),
          }],
          reports: {},
          report: createEmptyProposalMergeReport(),
        };
      }
    }
    return {
      document: replacementDocument,
      appliedIds: filteredReplacementBatch.proposals.map((proposal) => proposal.proposalId),
      failed: [],
      reports: replacementReports,
      report: combineProposalMergeReports(Object.values(replacementReports)),
    };
  }

  let document = baseDocument;
  const appliedIdSet = new Set<string>();
  const failedById = new Map<string, string>();
  const reports: Record<string, ProposalMergeReport> = {};
  // Whole-block replacements can overlap: update_problem_content replaces a Problem while
  // update_rich_content replaces one of its child paragraphs. Replaying the child first lets the
  // stale parent snapshot silently overwrite it. Preserve both intents by applying ancestors
  // before descendants while keeping the caller's order for unrelated proposals.
  const replayOrder = orderProposalDraftsForReplay(baseDocument, canonicalProposals);
  for (const proposal of replayOrder) {
    try {
      const replayed = replayProposalForApproval(document, proposal);
      document = replayed.nextDocument;
      reports[proposal.proposalId] = replayed.report;
      appliedIdSet.add(proposal.proposalId);
    } catch (error) {
      failedById.set(
        proposal.proposalId,
        error instanceof Error ? error.message : te("electron.proposalStore.editApplyFailed"),
      );
    }
  }
  const appliedIds = canonicalProposals
    .filter((proposal) => appliedIdSet.has(proposal.proposalId))
    .map((proposal) => proposal.proposalId);
  const failed = canonicalProposals.flatMap((proposal) => {
    const error = failedById.get(proposal.proposalId);
    return error ? [{ proposalId: proposal.proposalId, error }] : [];
  });
  return {
    document,
    appliedIds,
    failed,
    reports,
    report: combineProposalMergeReports(appliedIds.map((proposalId) => reports[proposalId]!)),
  };
}

function orderProposalDraftsForReplay<T extends { draft: AiEditSessionDraft; createdAt?: string }>(
  document: SigmaDocument,
  proposals: T[],
): T[] {
  return orderItemsByReplacementAncestry(
    document,
    proposals,
    (proposal) => collectReplaceTargetIds(proposal.draft),
  );
}

export function findMissingUpdateRichContentTargetIds(
  proposal: Pick<LocalMcpEditProposal, "source" | "draft">,
  document: SigmaDocument,
): string[] {
  if (proposal.source.toolName !== "update_rich_content" && proposal.source.toolName !== "draft_update_rich_content") {
    return [];
  }
  return collectReplaceTargetIds(proposal.draft).filter((targetId) => !findBlock(document, targetId));
}
