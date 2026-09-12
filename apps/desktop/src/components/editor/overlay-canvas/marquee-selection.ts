import { shapeVisualBoundsIntersect } from "@/features/drawing";

import { getRenderableShapesInVisualStackOrder, getShapeSelectionIds } from "./grouping";
import type { OverlayBounds, OverlayShape, OverlayShapeId } from "./types";

/**
 * What a marquee drag catches: the box the author can see.
 *
 * `getShapeSelectionBounds` is the *reference* box that resize, align, snap and group
 * normalization read, and it is deliberately not the drawn one — an arc stores `x = centre - r`
 * so its reference box is the whole ellipse, a line/arrow carries a fixed 10px padding, and
 * neither reflects rotation. Dragging over the empty space where the arc's circle would have been
 * therefore selected the arc. `shape-visual-bounds.ts` is the canon for what is drawn (the same
 * source the selection rectangle is painted from), so the marquee reads it too. The reference box
 * itself must stay as it is; changing it would move existing figures.
 *
 * A turned figure is tested against the rectangle the author can see rather than against the
 * axis-aligned box around it: that box adds four empty triangles at the corners, and a drag over
 * blank paper in one of them used to count as a hit.
 */
export interface MarqueeSelectionInput {
  readonly shapes: OverlayShape[];
  readonly marquee: OverlayBounds;
  readonly focusedGroupId: OverlayShapeId | null;
  readonly currentIds: readonly OverlayShapeId[];
  readonly additive: boolean;
}

/**
 * Groups never reach the filter (`getRenderableShapesInVisualStackOrder` drops them); a caught
 * leaf is promoted to its outermost group by `getShapeSelectionIds` unless the drag runs inside a
 * focused group. `additive` (Cmd/Shift) is a union, not a toggle.
 */
export function getMarqueeSelectionIds(input: MarqueeSelectionInput): OverlayShapeId[] {
  const { shapes, marquee, focusedGroupId, currentIds, additive } = input;
  const hitIds = getRenderableShapesInVisualStackOrder(shapes)
    .filter((shape) => shapeVisualBoundsIntersect(shape, marquee))
    .flatMap((shape) => getShapeSelectionIds(shapes, shape.id, focusedGroupId));

  return [...new Set(additive ? [...currentIds, ...hitIds] : hitIds)];
}
