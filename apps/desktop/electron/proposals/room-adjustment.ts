import { type SigmaBlock, type SigmaDocument } from "@/features/document";
import { collectBlocksById } from "@/lib/document-tree";
import { createEmptyProposalMergeReport, type ProposalMergeBasis } from "@/lib/ai/proposal-merge-basis";
import { removeDraftEntries, type ProposalMergeReplayResult } from "@/lib/ai/proposal-replay";
import {
  resolveAiEditSessionOperationOrder,
  type AiEditDraft,
  type AiEditSessionDraft,
  type SigmaDocMutationOp,
} from "@/lib/ai/sigma-doc-edit-schema";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { type LocalMcpEditProposalConflictReason, type LocalMcpEditProposalTouchedBlock } from "./contracts";
import { replayMergeableProposal } from "./freshness";

/** An earlier change of a chat's working proposal that no longer has a place in the document. */
export interface DroppedRoomChange {
  /** The operation's own summary (what the AI said it changes). */
  summary: string;
  /** The targets that could not be found or kept. */
  ids: string[];
  reason: LocalMcpEditProposalConflictReason;
}

export interface RoomDraftAdjustment {
  /** The room's draft without the dropped changes (what the merge was replayed from). */
  draft: AiEditSessionDraft;
  /** The merge of `draft` onto the document: its working document and rebased draft. */
  result: ProposalMergeReplayResult;
  dropped: DroppedRoomChange[];
}

/**
 * Fits a chat's pending proposal to the current document when it no longer merges as a whole, instead
 * of failing every later tool call of the chat (issue #249: the AI could only report "conflict" until
 * someone discarded the proposal, and "AIに再依頼" opened the very same chat).
 *
 * The changes that have no place left are dropped from the working proposal, the rest is merged as
 * usual (`replayMergeableProposal`, the approval's merge): a replacement, update or deletion whose
 * target the human deleted, an insertion whose anchor is gone, an operation the merge never merges
 * whose target the human changed (`content-stale`: the human's value stays), and everything that
 * depends on what a dropped change would have created. Each dropped change is returned with its
 * summary so the caller tells the AI and records it on the proposal: nothing disappears silently.
 *
 * Returns null when the proposal merges as it is (nothing to adjust).
 */
export function adjustRoomDraftToDocument(
  proposal: { draft: AiEditSessionDraft; mergeBasis: ProposalMergeBasis; touchedBlocks?: LocalMcpEditProposalTouchedBlock[] },
  document: SigmaDocument,
): RoomDraftAdjustment | null {
  const currentHashes = computeDocumentBlockHashes(document);
  let draft = proposal.draft;
  const dropped: DroppedRoomChange[] = [];
  const operationCount = draft.operations.length + (draft.mutationOperations?.length ?? 0);
  for (let attempt = 0; attempt <= operationCount; attempt += 1) {
    const replay = replayMergeableProposal(
      { draft, mergeBasis: proposal.mergeBasis, touchedBlocks: proposal.touchedBlocks },
      document,
      currentHashes,
    );
    if (replay.ok) {
      return attempt === 0 ? null : { draft, result: replay.result, dropped };
    }
    const removal = dropChangesReaching(draft, new Set(replay.conflict.blockIds), replay.conflict.reason);
    if (removal.dropped.length === 0) {
      // The conflict names nothing the draft can lose: drop the whole working proposal (reported).
      return dropEverything(draft, dropped, replay.conflict.reason, document);
    }
    draft = removal.draft;
    dropped.push(...removal.dropped);
  }
  return dropEverything(draft, dropped, "replay-failed", document);
}

/** Nothing of the working proposal has a place left: it becomes empty, every change reported. */
function dropEverything(
  draft: AiEditSessionDraft,
  dropped: DroppedRoomChange[],
  reason: LocalMcpEditProposalConflictReason,
  document: SigmaDocument,
): RoomDraftAdjustment {
  const all = [
    ...draft.operations.map((operation) => ({ summary: operation.summary, ids: [operation.targetId], reason })),
    ...(draft.mutationOperations ?? []).map((mutation) => ({ summary: mutation.summary, ids: mutationIds(mutation), reason })),
  ];
  const empty: AiEditSessionDraft = { ...draft, operations: [], mutationOperations: [], operationOrder: [] };
  return {
    draft: empty,
    result: { draft: empty, rebasedDraft: empty, nextDocument: document, report: createEmptyProposalMergeReport() },
    dropped: [...dropped, ...all],
  };
}

/**
 * Removes every change that reaches one of `gone` (a target, an anchor, an id it inserts), then every
 * change that reaches what a removed change creates, until nothing else depends on a removed change.
 * Lists (deletions, alignments) only lose the unreachable ids.
 */
function dropChangesReaching(
  draft: AiEditSessionDraft,
  gone: Set<string>,
  reason: LocalMcpEditProposalConflictReason,
): { draft: AiEditSessionDraft; dropped: DroppedRoomChange[] } {
  const removedOperations = new Set<number>();
  const removedMutations = new Set<number>();
  const mutations = [...(draft.mutationOperations ?? [])];
  const dropped: DroppedRoomChange[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of resolveAiEditSessionOperationOrder({ ...draft, mutationOperations: mutations })) {
      if (entry.kind === "operation") {
        if (removedOperations.has(entry.index)) {
          continue;
        }
        const operation = draft.operations[entry.index]!;
        const reached = operationIds(operation).filter((id) => gone.has(id));
        if (reached.length > 0) {
          removedOperations.add(entry.index);
          createdIds(operation).forEach((id) => gone.add(id));
          dropped.push({ summary: operation.summary, ids: reached, reason });
          changed = true;
        }
        continue;
      }
      if (removedMutations.has(entry.index)) {
        continue;
      }
      const mutation = mutations[entry.index]!;
      const reached = mutationIds(mutation).filter((id) => gone.has(id));
      if (reached.length === 0) {
        continue;
      }
      const narrowed = narrowMutation(mutation, gone);
      if (narrowed) {
        mutations[entry.index] = narrowed;
      } else {
        removedMutations.add(entry.index);
        if (mutation.operation === "replaceOverlayShape") {
          mutation.shapes.forEach((shape) => gone.add(shape.id));
        }
      }
      dropped.push({ summary: mutation.summary, ids: reached, reason });
      changed = true;
    }
  }
  const rewritten = removeDraftEntries(
    { ...draft, ...(draft.mutationOperations ? { mutationOperations: mutations } : {}) },
    removedOperations,
    removedMutations,
  ).draft;
  return { draft: rewritten, dropped };
}

/** A list operation without the unreachable ids, or null when too little would be left of it. */
function narrowMutation(mutation: SigmaDocMutationOp, gone: ReadonlySet<string>): SigmaDocMutationOp | null {
  if (mutation.operation === "deleteBlocks") {
    const blockIds = mutation.blockIds.filter((id) => !gone.has(id));
    return blockIds.length > 0 ? { ...mutation, blockIds } : null;
  }
  if (mutation.operation === "deleteOverlayShapes") {
    const shapeIds = mutation.shapeIds.filter((id) => !gone.has(id));
    return shapeIds.length > 0 ? { ...mutation, shapeIds } : null;
  }
  if (mutation.operation === "alignOverlayShapes") {
    const shapeIds = mutation.shapeIds.filter((id) => !gone.has(id));
    return shapeIds.length >= 2 ? { ...mutation, shapeIds } : null;
  }
  return null;
}

/** The existing ids an operation needs (its target and anchors) and the id it inserts. */
function operationIds(operation: AiEditDraft): string[] {
  const ids = [operation.targetId];
  const shape = operation.operation === "insertOverlayShape"
    ? operation.overlayShape
    : operation.operation === "insertTableShape" ? operation.tableShape : null;
  if (shape) {
    ids.push(shape.id);
    const anchor = shape.anchor;
    if (anchor?.type === "block") {
      ids.push(anchor.blockId);
    } else if (anchor?.type === "shape") {
      ids.push(anchor.shapeId);
    }
  } else if (operation.operation === "insertAfter") {
    ids.push(operation.insertedBlock.id);
  }
  return ids;
}

/** What an operation creates (later changes may need it). */
function createdIds(operation: AiEditDraft): string[] {
  if (operation.operation === "insertAfter") {
    return [...collectBlocksById([operation.insertedBlock as SigmaBlock]).keys()];
  }
  if (operation.operation === "insertOverlayShape") {
    return [operation.overlayShape.id];
  }
  if (operation.operation === "insertTableShape") {
    return [operation.tableShape.id];
  }
  return [...collectBlocksById([operation.replacementBlock as SigmaBlock]).keys()].filter((id) => id !== operation.targetId);
}

function mutationIds(mutation: SigmaDocMutationOp): string[] {
  switch (mutation.operation) {
    case "deleteBlocks":
    case "wrapBlocksInColumns":
      return mutation.blockIds;
    case "moveBlocks":
      return [...mutation.blockIds, mutation.targetId];
    case "updateOverlayShape":
      return [mutation.shapeId];
    case "replaceOverlayShape":
      return [mutation.shapeId, ...mutation.shapes.map((shape) => shape.id)];
    case "alignOverlayShapes":
    case "deleteOverlayShapes":
      return mutation.shapeIds;
    case "updateLayoutSection":
      return [mutation.sectionId];
    default:
      return [];
  }
}
