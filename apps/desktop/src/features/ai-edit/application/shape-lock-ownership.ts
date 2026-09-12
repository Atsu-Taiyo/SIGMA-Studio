import type { OverlayShape } from "@/features/document";
import {
  expandShapeIdsWithGraphOwnedLabels,
  expandShapeIdsWithGroupMembers,
} from "@/features/drawing";

/**
 * Every shape an AI lock on `ids` actually holds.
 *
 * Two ownership edges, both invisible in the id list a run or a proposal reports:
 * - a graph owns its axis, point, annotation and formula labels, which are sibling text shapes;
 * - a group owns its members, and is the *only* one of the two that draws nothing itself.
 *
 * Missing either edge leaves the lock half-applied: the shapes the user can see stay draggable
 * while AI rewrites them, and — for a group, whose id never reaches the canvas — the lock has no
 * visible shimmer at all, so a refused edit looks like a bug rather than a busy figure.
 */
export function expandShapeIdsWithAiLockOwnership(
  shapes: readonly OverlayShape[],
  ids: Iterable<string>,
): string[] {
  // The two edges cross: a grouped graph's labels are reached only after the group is expanded,
  // and a label may itself be grouped. Alternate until the set stops growing rather than fixing
  // an order that would silently drop one of those cases.
  let expanded = [...new Set(ids)];
  for (let round = 0; round < 4; round += 1) {
    const next = expandShapeIdsWithGroupMembers(
      shapes,
      expandShapeIdsWithGraphOwnedLabels(shapes, expanded),
    );
    if (next.length === expanded.length) {
      return next;
    }
    expanded = next;
  }
  return expanded;
}
