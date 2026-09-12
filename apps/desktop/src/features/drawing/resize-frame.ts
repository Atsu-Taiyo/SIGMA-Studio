import type { OverlayBounds, OverlayPoint, OverlayShape } from "@/features/document";

import type { ResizeHandle } from "./interaction-mode";
import { getBoundsCenter } from "./math";
import { resizeRotatedShapeToBounds, resizeShapesToBounds } from "./shape-arrangement";
import { getShapeRotation } from "./shape-bounds";
import {
  getShapeInkBounds,
  getShapeRotationPivot,
  getShapeVisualBounds,
  getShapesInkBounds,
  getShapesVisualBounds,
} from "./shape-visual-bounds";

/**
 * Resizing against the box the author actually sees.
 *
 * The reference box (`getShapeBounds`) is what the transform is expressed in, and it must stay
 * that way — snapping, alignment, group normalization and export ranges all read it, and some of
 * those values are persisted. But for an arc it is the whole ellipse, and a default 90° arc draws
 * only about a seventh of that width. Dragging the reference box therefore moved the visible arc
 * a fraction of the pointer distance and slid it sideways, because the "fixed" edge was the left
 * side of an ellipse with nothing drawn on it.
 *
 * So the drag is expressed in the visible frame, and mapped back by removing the one part of that
 * frame which does not scale: the stroke/arrow-head padding. Shapes that draw their own box
 * (`geo` / `image` / `text` / `tableShape` / `graph2dShape` / `callout`) have zero padding and a
 * visible frame equal to the reference box, so their resize is bit-for-bit the previous path —
 * {@link toCoreResizeBounds} returns its input unchanged in that case.
 */

export interface BoundsPadding {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const ZERO_BOUNDS_PADDING: BoundsPadding = { left: 0, top: 0, right: 0, bottom: 0 };

export interface SelectionResizeFrame {
  /** The rectangle drawn around the selection, and the one the pointer drags. */
  readonly visual: OverlayBounds;
  /** Stroke and arrow-head reach, held out of the mapping so it cannot be scaled. */
  readonly padding: BoundsPadding;
}

/** The smallest ink box a resize may produce; below this a scale factor stops being meaningful. */
const MIN_CORE_SIZE = 1;

/**
 * The rectangle the author sees around a selection.
 *
 * A single shape keeps its *unrotated* box because the selection chrome rotates it in CSS;
 * handing back pre-rotated bounds would rotate it twice. Multi-selection has no such CSS
 * rotation, so each member's rotation is baked into the union instead.
 */
export function getSelectionVisualFrame(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
): OverlayBounds | null {
  const onlyShape = getUnrotatedSingleShape(shapes);
  if (onlyShape) {
    return getShapeVisualBounds(onlyShape);
  }
  return getShapesVisualBounds(shapes, allShapes);
}

/**
 * The point a rotate drag turns the selection around.
 *
 * One shape turns around its own pivot, so the gesture and the `transform-origin` it is drawn with
 * agree. Several shapes turn around the middle of the rectangle drawn around them — the union of
 * what they draw, not of the boxes they are stored in, which for an arc is a whole ellipse.
 */
export function getSelectionRotationPivot(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
): OverlayPoint | null {
  if (shapes.length === 1 && shapes[0].type !== "group") {
    return getShapeRotationPivot(shapes[0]);
  }

  const frame = getSelectionVisualFrame(shapes, allShapes);
  return frame ? getBoundsCenter(frame) : null;
}

export function getSelectionResizeFrame(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
): SelectionResizeFrame | null {
  const visual = getSelectionVisualFrame(shapes, allShapes);
  if (!visual) {
    return null;
  }

  const onlyShape = getUnrotatedSingleShape(shapes);
  const ink = onlyShape
    ? getShapeInkBounds(onlyShape)
    : getShapesInkBounds(shapes, allShapes) ?? visual;
  return { visual, padding: clampPadding(getBoundsPadding(visual, ink), visual) };
}

export function resizeShapesToVisualBounds(
  shapes: OverlayShape[],
  frame: SelectionResizeFrame,
  visualTo: OverlayBounds,
  handle: ResizeHandle,
): OverlayShape[] {
  return resizeShapesToBounds(
    shapes,
    deflateBounds(frame.visual, frame.padding),
    toCoreResizeBounds(visualTo, frame.padding, handle),
  );
}

export function resizeRotatedShapeToVisualBounds(
  shape: OverlayShape,
  frame: SelectionResizeFrame,
  visualTo: OverlayBounds,
  handle: ResizeHandle,
): OverlayShape {
  // `resizeRotatedShapeToBounds` has to re-measure the resized shape in the same frame it was
  // given, otherwise the handle it holds fixed is read off a different rectangle and the shape
  // jumps. With no padding that frame is the reference box, which is its own default.
  const measureInFrame = isZeroPadding(frame.padding)
    ? undefined
    : (resized: OverlayShape) => deflateBounds(getShapeVisualBounds(resized), frame.padding);
  return resizeRotatedShapeToBounds(
    shape,
    deflateBounds(frame.visual, frame.padding),
    toCoreResizeBounds(visualTo, frame.padding, handle),
    handle,
    measureInFrame,
  );
}

export function deflateBounds(bounds: OverlayBounds, padding: BoundsPadding): OverlayBounds {
  if (isZeroPadding(padding)) {
    return bounds;
  }

  return {
    x: bounds.x + padding.left,
    y: bounds.y + padding.top,
    w: bounds.w - padding.left - padding.right,
    h: bounds.h - padding.top - padding.bottom,
  };
}

export function getBoundsPadding(outer: OverlayBounds, inner: OverlayBounds): BoundsPadding {
  return {
    left: nonNegative(inner.x - outer.x),
    top: nonNegative(inner.y - outer.y),
    right: nonNegative(outer.x + outer.w - inner.x - inner.w),
    bottom: nonNegative(outer.y + outer.h - inner.y - inner.h),
  };
}

/**
 * The mapped-to box, in ink coordinates.
 *
 * `visualTo` carries the drag's orientation: its `x` is where the frame's left edge lands, so a
 * negative width means the box was dragged through its fixed edge and the shape is mirrored. The
 * padding follows the mirror (what was on the left is drawn on the right), and the floor is
 * applied at the edge the handle is not moving, so shrinking past the stroke width stops rather
 * than flipping the figure inside out.
 */
function toCoreResizeBounds(
  visualTo: OverlayBounds,
  padding: BoundsPadding,
  handle: ResizeHandle,
): OverlayBounds {
  if (isZeroPadding(padding)) {
    return visualTo;
  }

  const horizontal = toCoreAxis(
    visualTo.x,
    visualTo.w,
    padding.left,
    padding.right,
    handleKeepsOrigin(handle, "x"),
  );
  const vertical = toCoreAxis(
    visualTo.y,
    visualTo.h,
    padding.top,
    padding.bottom,
    handleKeepsOrigin(handle, "y"),
  );
  return { x: horizontal.origin, y: vertical.origin, w: horizontal.size, h: vertical.size };
}

function toCoreAxis(
  origin: number,
  size: number,
  padNear: number,
  padFar: number,
  keepsOrigin: boolean,
): { origin: number; size: number } {
  const flipped = size < 0;
  const min = flipped ? origin + size : origin;
  const extent = Math.abs(size);
  // After a mirror the padding that was drawn on the near side ends up on the far side.
  const padMin = flipped ? padFar : padNear;
  const padMax = flipped ? padNear : padFar;
  const coreExtent = Math.max(MIN_CORE_SIZE, extent - padMin - padMax);
  // The dragged edge is the one that moves, so the floor grows away from the other one.
  const coreMin = keepsOrigin !== flipped
    ? min + padMin
    : min + extent - padMax - coreExtent;

  return flipped
    ? { origin: coreMin + coreExtent, size: -coreExtent }
    : { origin: coreMin, size: coreExtent };
}

/** Which edge `resizeBounds` leaves alone: `x`/`y` stay put unless the handle names that side. */
function handleKeepsOrigin(handle: ResizeHandle, axis: "x" | "y"): boolean {
  return axis === "x"
    ? handle !== "nw" && handle !== "w" && handle !== "sw"
    : handle !== "nw" && handle !== "n" && handle !== "ne";
}

function getUnrotatedSingleShape(shapes: readonly OverlayShape[]): OverlayShape | null {
  const onlyShape = shapes.length === 1 ? shapes[0] : null;
  return onlyShape && onlyShape.type !== "group" && getShapeRotation(onlyShape) !== 0
    ? onlyShape
    : null;
}

/**
 * Keep enough of the frame outside the padding to scale.
 *
 * A flat arc with `xl` arrow heads reserves more padding than the arc itself is tall, and an
 * empty core box has no scale factor at all. Shrinking both sides by the same ratio keeps the
 * frame centred on the same ink instead of pinning it to one edge.
 */
function clampPadding(padding: BoundsPadding, visual: OverlayBounds): BoundsPadding {
  const horizontal = paddingScale(padding.left + padding.right, visual.w);
  const vertical = paddingScale(padding.top + padding.bottom, visual.h);
  if (horizontal === 1 && vertical === 1) {
    return padding;
  }

  return {
    left: padding.left * horizontal,
    right: padding.right * horizontal,
    top: padding.top * vertical,
    bottom: padding.bottom * vertical,
  };
}

function paddingScale(total: number, extent: number): number {
  const available = extent - MIN_CORE_SIZE;
  if (total <= 0 || total <= available) {
    return 1;
  }
  return available > 0 ? available / total : 0;
}

function isZeroPadding(padding: BoundsPadding): boolean {
  return padding.left === 0 && padding.top === 0 && padding.right === 0 && padding.bottom === 0;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
