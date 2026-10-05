import { useMemo } from "react";

import type { OverlayShape } from "@/features/document";
import type { TextContentReservation } from "@/features/text-editing";
import {
  useAiEditingBlockLocks,
  useAiEditingShapeLocks,
} from "@/lib/ai/ai-editing-block-locks";

import {
  aiActiveRunBlockedMessage,
  aiPendingProposalBlockedMessage,
  aiResultOnlyBlockedMessage,
  getAiTextContentReservation,
} from "../adapters/tiptap/edit-lock-adapter";
import { derivePendingAiProposalLockTargets, type AiEditPreviewState } from "../model/preview";
import { expandShapeIdsWithAiLockOwnership } from "./shape-lock-ownership";

/**
 * Every document target that AI currently owns, and that a human therefore
 * must not edit until the owning run is stopped or its proposal is decided.
 *
 * This is deliberately the ONLY definition of "what AI is holding": the editor
 * extension composition (`useAiEditorExtensions`) and the shell-level mutation
 * gates (`EditorShell`) both read it, so a block can never be visually locked
 * without also being refused at the commit choke point, or vice versa.
 *
 * Two sources, unioned:
 * - live runs -- `AiRunAnchor.blockIds` / `shapeIds`, i.e. exactly the context
 *   the user handed to the AI when they submitted the request. NOT what the run
 *   happens to read or write afterwards: a run that edits outside its anchor
 *   leaves those targets editable, and the approval reconciles them (below).
 * - pending proposals -- only the targets a finished run's draft rewrites that
 *   the approval's three-way merge cannot follow, reserved until the human
 *   applies or discards it (`derivePendingAiProposalLockTargets`): every target
 *   of a legacy record without a merge basis, and the shapes it aligns or the
 *   column section it reconfigures. Everything else a pending proposal rewrites
 *   stays editable: the approval merges the human's edit with the AI's change
 *   (`replayProposalDraftMerging`, MISS R2), and the previews show that merge.
 *
 * Both sources are then expanded through shape ownership
 * (`expandShapeIdsWithAiLockOwnership`): a graph's axis, point, annotation and formula labels are
 * sibling text shapes, and a group's members are the only part of it that is ever drawn. Reserving
 * only the owning id would leave the shapes the user can see draggable while AI rewrites them --
 * and moving one is exactly what would be lost when the proposal is applied, since the edit
 * re-lays out the whole figure.
 */
export interface AiLockedTargets {
  blockIds: ReadonlySet<string>;
  shapeIds: ReadonlySet<string>;
  /** The subset held by a live run, which the user can release by stopping it.
   * Everything else is a pending proposal's non-mergeable target, released by
   * applying or discarding the proposal. Only the wording of the blocked-edit
   * message differs -- both are equally read-only. */
  runBlockIds: ReadonlySet<string>;
  runShapeIds: ReadonlySet<string>;
  /** Only these fragments are reserved; ids absent here retain whole-block protection. */
  contentReservations?: ReadonlyMap<string, readonly TextContentReservation[]>;
  /**
   * The subsets hidden from the page while a proposal shows only its result: blocks folded out
   * of the body and shapes whose before state is hidden (`withAiResultOnlyTargets`). Not visible,
   * so a human must not edit them; released by switching the proposal back to its changes.
   */
  resultOnlyBlockIds?: ReadonlySet<string>;
  resultOnlyShapeIds?: ReadonlySet<string>;
  /** The same holds without the result-only subsets (what non-human changes are checked against). */
  withoutResultOnly?: AiLockedTargets;
}

/**
 * Where a document change comes from. The result-only hold stops only what a human does to things
 * they cannot see; an AI approval being applied, a version restore and an external replacement are
 * not edits of the hidden content and must not be blocked by a display toggle.
 */
export type AiDocumentChangeOrigin = "human-edit" | "ai-approval" | "history-restore" | "external";

export const EMPTY_AI_LOCKED_TARGETS: AiLockedTargets = {
  blockIds: new Set<string>(),
  shapeIds: new Set<string>(),
  runBlockIds: new Set<string>(),
  runShapeIds: new Set<string>(),
};

/**
 * Pure union of the two lock sources, split out from the hook for testing.
 * `shapes` is the current overlay snapshot, needed only to follow graph label
 * and group ownership; pass none and shape ids are taken literally.
 */
export function mergeAiLockedTargets(
  liveBlockIds: Iterable<string>,
  liveShapeIds: Iterable<string>,
  pending: { blockIds: Iterable<string>; shapeIds: Iterable<string> },
  shapes: readonly OverlayShape[] = [],
  liveContentReservations: ReadonlyMap<string, readonly TextContentReservation[]> = new Map(),
): AiLockedTargets {
  const runBlockIds = new Set(liveBlockIds);
  const runShapeIds = new Set(expandShapeIdsWithAiLockOwnership(shapes, liveShapeIds));
  const pendingBlockIds = [...pending.blockIds];
  const contentReservations = new Map(liveContentReservations);
  pendingBlockIds.forEach((id) => contentReservations.delete(id));
  return {
    blockIds: new Set([...runBlockIds, ...pendingBlockIds]),
    shapeIds: new Set([
      ...runShapeIds,
      ...expandShapeIdsWithAiLockOwnership(shapes, pending.shapeIds),
    ]),
    runBlockIds,
    runShapeIds,
    contentReservations,
  };
}

/**
 * Adds what a page card hides to show only its proposal's result: the blocks it folds out of the
 * body and the shapes whose before state it hides. The page extension decides them once
 * (`collectResultOnlyCollapsedBlockIds` / `deriveAiResultOnlyShapeIds`): the same sets fold and
 * hide them, guard them in the editing surfaces, refuse cross-surface joins into them, and --
 * through this union -- refuse every human commit and history restore that would change them while
 * they cannot be seen (search & replace, boundary deletes, undo, delayed overlay commits). A folded
 * block is protected whole, even where a live run reserved only a fragment of it.
 */
export function withAiResultOnlyTargets(
  targets: AiLockedTargets,
  resultOnly: { blockIds: ReadonlySet<string>; shapeIds: ReadonlySet<string> },
): AiLockedTargets {
  if (resultOnly.blockIds.size === 0 && resultOnly.shapeIds.size === 0) {
    return targets;
  }
  const contentReservations = new Map(targets.contentReservations ?? []);
  resultOnly.blockIds.forEach((id) => contentReservations.delete(id));
  return {
    ...targets,
    blockIds: new Set([...targets.blockIds, ...resultOnly.blockIds]),
    shapeIds: new Set([...targets.shapeIds, ...resultOnly.shapeIds]),
    contentReservations,
    resultOnlyBlockIds: resultOnly.blockIds,
    resultOnlyShapeIds: resultOnly.shapeIds,
    withoutResultOnly: targets,
  };
}

/**
 * The holds a change from `origin` is checked against: everything for a human edit, everything
 * but the result-only subsets otherwise. The one place that tells the two apart.
 */
export function aiLockedTargetsForOrigin(targets: AiLockedTargets, origin: AiDocumentChangeOrigin): AiLockedTargets {
  return origin === "human-edit" ? targets : targets.withoutResultOnly ?? targets;
}

export function useAiLockedTargets(
  documentIdentityKey: string | null | undefined,
  previewGroups: readonly AiEditPreviewState[],
  shapes: readonly OverlayShape[],
): AiLockedTargets {
  const liveBlockLocks = useAiEditingBlockLocks(documentIdentityKey);
  const liveShapeLocks = useAiEditingShapeLocks(documentIdentityKey);
  const pendingTargets = useMemo(
    () => derivePendingAiProposalLockTargets([...previewGroups], shapes),
    [previewGroups, shapes],
  );

  return useMemo(
    () => mergeAiLockedTargets(
      liveBlockLocks.map((lock) => lock.blockId),
      liveShapeLocks.map((lock) => lock.shapeId),
      pendingTargets,
      shapes,
      collectAiTextContentReservations(liveBlockLocks),
    ),
    [liveBlockLocks, liveShapeLocks, pendingTargets, shapes],
  );
}

export function collectAiTextContentReservations(
  locks: readonly { blockId: string; blockLockText?: string; blockShimmerScopes?: Parameters<typeof getAiTextContentReservation>[0]["blockShimmerScopes"] }[],
): Map<string, readonly TextContentReservation[]> {
  const reservations = new Map<string, readonly TextContentReservation[]>();
  const wholeBlocks = new Set<string>();
  for (const lock of locks) {
    const reservation = getAiTextContentReservation(lock);
    if (!reservation) {
      wholeBlocks.add(lock.blockId);
      reservations.delete(lock.blockId);
    } else if (!wholeBlocks.has(lock.blockId)) {
      reservations.set(lock.blockId, [...(reservations.get(lock.blockId) ?? []), reservation]);
    }
  }
  return reservations;
}

export function isAiLockedBlock(targets: AiLockedTargets, blockId: string | null | undefined): boolean {
  // Toolbar availability is block-wide. Fragment edits are checked against the
  // actual selection by the transaction/commit guards instead of disabling it.
  return !!blockId && targets.blockIds.has(blockId) && !targets.contentReservations?.has(blockId);
}

export function isAiLockedShapeSelection(
  targets: AiLockedTargets,
  shapeIds: readonly string[] | null | undefined,
): boolean {
  return !!shapeIds && shapeIds.some((shapeId) => targets.shapeIds.has(shapeId));
}

/**
 * Why a refused edit was refused, in the user's terms. A live run offers the
 * "AIを停止して編集" escape hatch; a pending proposal is released by deciding on
 * it. When a change straddles both, the stoppable run is reported since that is
 * the action the user can take right now.
 */
export function describeAiLockedTargets(
  targets: AiLockedTargets,
  touched: { blockIds: readonly string[]; shapeIds: readonly string[] },
): string {
  const heldByRun = touched.blockIds.some((id) => targets.runBlockIds.has(id))
    || touched.shapeIds.some((id) => targets.runShapeIds.has(id));
  if (heldByRun) {
    return aiActiveRunBlockedMessage();
  }
  return touched.blockIds.some((id) => targets.resultOnlyBlockIds?.has(id))
    || touched.shapeIds.some((id) => targets.resultOnlyShapeIds?.has(id))
    ? aiResultOnlyBlockedMessage()
    : aiPendingProposalBlockedMessage();
}
