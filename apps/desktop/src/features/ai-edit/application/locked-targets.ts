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
 *   leaves those targets editable, and the resulting conflict is resolved by
 *   the per-block content-hash freshness check at approval time
 *   (`findProposalFreshnessConflictIds`) plus the stale-proposal UI.
 * - pending proposals -- the targets a finished run's draft actually rewrites,
 *   reserved until the human applies or discards it.
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
   * Everything else is a pending-proposal reservation, released by applying or
   * discarding the proposal. Only the wording of the blocked-edit message
   * differs -- both are equally read-only. */
  runBlockIds: ReadonlySet<string>;
  runShapeIds: ReadonlySet<string>;
  /** Only these fragments are reserved; ids absent here retain whole-block protection. */
  contentReservations?: ReadonlyMap<string, readonly TextContentReservation[]>;
}

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

export function useAiLockedTargets(
  documentIdentityKey: string | null | undefined,
  previewGroups: readonly AiEditPreviewState[],
  shapes: readonly OverlayShape[],
): AiLockedTargets {
  const liveBlockLocks = useAiEditingBlockLocks(documentIdentityKey);
  const liveShapeLocks = useAiEditingShapeLocks(documentIdentityKey);
  const pendingTargets = useMemo(
    () => derivePendingAiProposalLockTargets([...previewGroups]),
    [previewGroups],
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
  return heldByRun ? aiActiveRunBlockedMessage() : aiPendingProposalBlockedMessage();
}
