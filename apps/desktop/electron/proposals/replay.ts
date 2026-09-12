import { isDeepStrictEqual } from "node:util";
import {
  createAiEditSessionDocumentDraft,
  type AiEditDraft,
  type AiEditSessionDraft,
} from "@/lib/ai/sigma-doc-edit-schema";
import { deriveAppliedDocumentDiff, isOverlayAnchorSupportDraft } from "@/lib/ai/applied-document-diff";
import { rewriteAiOverlayShapeReplacementDrafts } from "@/lib/ai/overlay-shape-replacement";
import { findBlock, resolveTextFlowBlockRangeIds, type EditableBlock } from "@/lib/document-tree";
import { type ProblemNode, type SigmaDocument } from "@/features/document";
import { type LocalMcpEditProposal, selectGroupRepresentatives } from "./contracts";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export interface MergeProposalDraftsResult {
  document: SigmaDocument;
  appliedIds: string[];
  failed: { proposalId: string; error: string }[];
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
    for (const proposal of filteredReplacementBatch.proposals) {
      try {
        replacementDocument = replayProposalDraft(replacementDocument, proposal.draft).nextDocument;
      } catch (error) {
        return {
          document: baseDocument,
          appliedIds: [],
          failed: [{
            proposalId: proposal.proposalId,
            error: error instanceof Error ? error.message : te("electron.proposalStore.shapeReplacementFailed"),
          }],
        };
      }
    }
    return {
      document: replacementDocument,
      appliedIds: filteredReplacementBatch.proposals.map((proposal) => proposal.proposalId),
      failed: [],
    };
  }

  let document = baseDocument;
  const appliedIdSet = new Set<string>();
  const failedById = new Map<string, string>();
  // Whole-block replacements can overlap: update_problem_content replaces a Problem while
  // update_rich_content replaces one of its child paragraphs. Replaying the child first lets the
  // stale parent snapshot silently overwrite it. Preserve both intents by applying ancestors
  // before descendants while keeping the caller's order for unrelated proposals.
  const replayOrder = orderProposalDraftsForReplay(baseDocument, canonicalProposals);
  for (const proposal of replayOrder) {
    try {
      document = replayProposalDraft(document, proposal.draft).nextDocument;
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
  return { document, appliedIds, failed };
}

const PROBLEM_OVERLAY_ANCHOR_AREAS = ["lead", "prompt", "solution", "hints"] as const;

/**
 * Older overlay proposals may contain a whole-Problem replacement whose only
 * purpose was to create an empty body paragraph to anchor a shape. Rebase that
 * compatibility operation semantically: preserve the current Problem, merge
 * only the synthetic anchor when the area is still empty, or use the area's
 * existing first block when a human/another proposal has populated it.
 */
function normalizeLegacyOverlayAnchorSupportDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): AiEditSessionDraft {
  const insertionTargetIds = new Set(draft.operations.flatMap((operation) => (
    operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape"
      ? [operation.targetId]
      : []
  )));
  const retargetById = new Map<string, string>();

  const withCurrentProblems = draft.operations.map((operation): AiEditDraft => {
    if (!isReplaceOperation(operation)
      || !isOverlayAnchorSupportDraft(operation, draft.operations)
      || operation.replacementBlock.type !== "problem") {
      return operation;
    }
    const currentProblem = findBlock(document, operation.targetId);
    if (currentProblem?.type !== "problem") {
      return operation;
    }
    const area = PROBLEM_OVERLAY_ANCHOR_AREAS.find((candidate) => (
      operation.replacementBlock.type === "problem"
      && operation.replacementBlock[candidate].some((block) => insertionTargetIds.has(block.id))
    ));
    if (!area) {
      return operation;
    }
    const supportBlocks = operation.replacementBlock[area].filter((block) => insertionTargetIds.has(block.id));
    if (supportBlocks.length === 0) {
      return operation;
    }
    const currentAnchor = currentProblem[area][0];
    if (currentAnchor) {
      supportBlocks.forEach((block) => retargetById.set(block.id, currentAnchor.id));
      return {
        operation: "replace",
        summary: operation.summary,
        targetId: operation.targetId,
        replacementBlock: currentProblem,
      };
    }
    const replacementBlock: ProblemNode = { ...currentProblem, [area]: supportBlocks };
    return {
      operation: "replace",
      summary: operation.summary,
      targetId: operation.targetId,
      replacementBlock,
    };
  });

  if (retargetById.size === 0) {
    return withCurrentProblems.every((operation, index) => operation === draft.operations[index])
      ? draft
      : { ...draft, operations: withCurrentProblems };
  }

  const operations = withCurrentProblems.map((operation): AiEditDraft => {
    if (operation.operation !== "insertOverlayShape" && operation.operation !== "insertTableShape") {
      return operation;
    }
    const targetId = retargetById.get(operation.targetId) ?? operation.targetId;
    if (operation.operation === "insertTableShape") {
      const anchor = operation.tableShape.anchor;
      return {
        ...operation,
        targetId,
        tableShape: anchor?.type === "block" && retargetById.has(anchor.blockId)
          ? { ...operation.tableShape, anchor: { ...anchor, blockId: retargetById.get(anchor.blockId)! } }
          : operation.tableShape,
      };
    }
    const anchor = operation.overlayShape.anchor;
    return {
      ...operation,
      targetId,
      overlayShape: anchor?.type === "block" && retargetById.has(anchor.blockId)
        ? { ...operation.overlayShape, anchor: { ...anchor, blockId: retargetById.get(anchor.blockId)! } }
        : operation.overlayShape,
    };
  });
  return { ...draft, operations };
}

export function replayProposalDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): { draft: AiEditSessionDraft; nextDocument: SigmaDocument } {
  // A persisted proposal is immutable input. Clone before range/order normalization so replay can
  // never mutate the stored replacementBlock objects in-place, then retain the normalized draft
  // returned by the canonical apply function instead of discarding it.
  const compatibilityDraft = normalizeLegacyOverlayAnchorSupportDraft(document, structuredClone(draft));
  const rangeResolvedDraft = resolveLocalColumnRangesForReplay(document, compatibilityDraft);
  const replayDraft = orderDraftOperationsForReplay(document, rangeResolvedDraft);
  const replay = createAiEditSessionDocumentDraft(document, null, replayDraft);
  return {
    draft: replay.draft,
    nextDocument: replay.nextDocument,
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

function orderDraftOperationsForReplay(document: SigmaDocument, draft: AiEditSessionDraft): AiEditSessionDraft {
  const operations = orderItemsByReplacementAncestry(document, draft.operations, (operation) => (
    isReplaceOperation(operation) ? [operation.targetId] : []
  ));
  return operations.every((operation, index) => operation === draft.operations[index])
    ? draft
    : { ...draft, operations };
}

/**
 * Stable topological ordering for overlapping whole-block replacements. The only added dependency
 * is ancestor -> descendant; unrelated edits retain their original order. Applying the ancestor's
 * whole-block snapshot first lets the descendant's edit land inside it afterwards, so neither
 * intent is silently lost regardless of which proposal is newer.
 */
function orderItemsByReplacementAncestry<T>(
  document: SigmaDocument,
  items: T[],
  targetIdsOf: (item: T) => string[],
): T[] {
  if (items.length < 2) {
    return items;
  }

  const targetIds = items.map(targetIdsOf);
  const outgoing = items.map(() => new Set<number>());
  const indegree = items.map(() => 0);
  const addDependency = (before: number, after: number) => {
    if (!outgoing[before].has(after)) {
      outgoing[before].add(after);
      indegree[after] += 1;
    }
  };

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftContainsRight = hasAncestorTarget(document, targetIds[left], targetIds[right]);
      const rightContainsLeft = hasAncestorTarget(document, targetIds[right], targetIds[left]);
      if (leftContainsRight && !rightContainsLeft) {
        // Left is ancestor of right: always ensure ancestor is applied before descendant
        // to prevent the descendant's stale snapshot (based on old ancestor state) from being lost
        addDependency(left, right);
      } else if (rightContainsLeft && !leftContainsRight) {
        // Right is ancestor of left: always ensure ancestor is applied before descendant
        // to prevent the descendant's stale snapshot (based on old ancestor state) from being lost
        addDependency(right, left);
      }
    }
  }

  const remaining = new Set(items.map((_, index) => index));
  const ordered: T[] = [];
  while (remaining.size > 0) {
    const nextIndex = [...remaining].find((index) => indegree[index] === 0);
    if (nextIndex === undefined) {
      return items;
    }
    remaining.delete(nextIndex);
    ordered.push(items[nextIndex]);
    for (const dependent of outgoing[nextIndex]) {
      indegree[dependent] -= 1;
    }
  }
  return ordered;
}

function hasAncestorTarget(document: SigmaDocument, possibleAncestors: string[], possibleDescendants: string[]): boolean {
  return possibleAncestors.some((ancestorId) => possibleDescendants.some((descendantId) => {
    if (ancestorId === descendantId) {
      return false;
    }
    const ancestor = findBlock(document, ancestorId);
    return ancestor ? editableBlockContainsId(ancestor, descendantId) : false;
  }));
}

function editableBlockContainsId(block: EditableBlock, targetId: string): boolean {
  if (block.id === targetId) {
    return true;
  }
  if (block.type === "problem") {
    return [...block.lead, ...block.prompt, ...block.solution, ...block.hints]
      .some((child) => editableBlockContainsId(child, targetId));
  }
  if (block.type === "layoutSection") {
    return block.children.some((child) => editableBlockContainsId(child, targetId));
  }
  if (block.type === "boxBlock") {
    return block.blocks.some((child) => editableBlockContainsId(child, targetId));
  }
  if (block.type === "list") {
    return block.items.some((item) => editableBlockContainsId(item, targetId));
  }
  if (block.type === "listItem") {
    return block.nested?.some((nested) => editableBlockContainsId(nested, targetId)) ?? false;
  }
  return false;
}

function isReplaceOperation(
  operation: AiEditDraft,
): operation is AiEditDraft & { replacementBlock: EditableBlock } {
  return operation.operation === undefined || operation.operation === "replace";
}

export function collectReplaceTargetIds(draft: AiEditSessionDraft): string[] {
  return Array.from(new Set(
    draft.operations.filter(isReplaceOperation).map((operation) => operation.targetId),
  ));
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

export function assertAppliedProposalHasRealChanges(
  before: SigmaDocument,
  after: SigmaDocument,
  draft: AiEditSessionDraft,
): void {
  const mutationOperations = draft.mutationOperations ?? [];
  if (
    draft.operations.length === 0
    || mutationOperations.length > 0
    || !draft.operations.every(isReplaceOperation)
  ) {
    return;
  }

  const diff = deriveAppliedDocumentDiff(before, after, [draft]);
  if (diff.shapes.length > 0 || diff.body.length === 0) {
    return;
  }
  const removed = new Map(
    diff.body.filter((entry) => entry.change === "removed").map((entry) => [entry.block.id, entry.block]),
  );
  const added = new Map(
    diff.body.filter((entry) => entry.change === "added").map((entry) => [entry.block.id, entry.block]),
  );
  if (
    removed.size > 0
    && removed.size === added.size
    && [...removed].every(([id, block]) => added.has(id) && isDeepStrictEqual(block, added.get(id)))
  ) {
    throw new Error(
      te("electron.proposalStore.diffLost", { ids: [...removed.keys()].join(", ") }),
    );
  }
}

/**
 * 部分段組みは内容を上書きする操作ではないため、古いblockIds列をそのまま再生せず、
 * 提案時の先頭・末尾IDを範囲アンカーとして現在の兄弟ブロック列を取り直す。
 * これにより範囲外の編集はもちろん、範囲内へ追加された段落も現在内容のまま段組みに含まれる。
 */
function resolveLocalColumnRangesForReplay(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): AiEditSessionDraft {
  const mutationOperations = draft.mutationOperations;
  if (!mutationOperations?.some((operation) => operation.operation === "wrapBlocksInColumns")) {
    return draft;
  }

  const resolvedOperations = mutationOperations.map((operation) => {
    if (operation.operation !== "wrapBlocksInColumns") {
      return operation;
    }
    const startBlockId = operation.blockIds[0];
    const endBlockId = operation.blockIds.at(-1);
    if (!startBlockId || !endBlockId) {
      throw new Error(te("electron.proposalStore.columnsRangeMissing"));
    }
    const blockIds = resolveTextFlowBlockRangeIds(document, startBlockId, endBlockId);
    if (!blockIds) {
      throw new Error(te("electron.proposalStore.columnsRangeNotFound", { startBlockId, endBlockId }));
    }
    return { ...operation, blockIds };
  });

  return { ...draft, mutationOperations: resolvedOperations };
}
