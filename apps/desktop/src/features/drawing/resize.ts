import type { OverlayBounds, OverlayPoint, OverlayShape } from "@/features/document";

import type { OverlayInteractionMode, ResizeHandle } from "./interaction-mode";
import { dragSign } from "./math";

const EQUILATERAL_TRIANGLE_HEIGHT_RATIO = Math.sqrt(3) / 2;

export const CORNER_RESIZE_HANDLES = ["nw", "ne", "sw", "se"] as const satisfies readonly ResizeHandle[];
export const EDGE_RESIZE_HANDLES = ["n", "e", "s", "w"] as const satisfies readonly ResizeHandle[];

/**
 * The resize handles a selection offers.
 *
 * `visible` are drawn and draggable; `hitOnly` are draggable but not drawn — an arc's edges sit
 * under its angle handles, so the bar would collide with them while the grab area is still wanted.
 *
 * A type that cannot be resized on an axis must not offer a handle for it: a text shape's height
 * is derived from its content, so a north/south or corner drag would set a height the next
 * measurement immediately overwrites — the box would spring back under the cursor.
 */
export interface OverlayResizeHandleSet {
  hitOnly: readonly ResizeHandle[];
  visible: readonly ResizeHandle[];
}

const TEXT_RESIZE_HANDLES = ["e", "w"] as const satisfies readonly ResizeHandle[];

export function getResizeHandleSet(
  shapes: readonly Pick<OverlayShape, "type">[],
): OverlayResizeHandleSet {
  const only = shapes.length === 1 ? shapes[0] : null;

  if (only?.type === "text") {
    // Width is the only thing the author sets. No corners either: a corner drag is a width *and* a
    // height, and half of that has nowhere to go.
    return { hitOnly: [], visible: TEXT_RESIZE_HANDLES };
  }

  if (only?.type === "tableShape") {
    // The table sizes its own rows and columns; the box follows them, so only the corners scale it.
    return { hitOnly: [], visible: CORNER_RESIZE_HANDLES };
  }

  if (only?.type === "arc") {
    return { hitOnly: EDGE_RESIZE_HANDLES, visible: CORNER_RESIZE_HANDLES };
  }

  return { hitOnly: [], visible: [...EDGE_RESIZE_HANDLES, ...CORNER_RESIZE_HANDLES] };
}

export function isCornerResizeHandle(handle: ResizeHandle): boolean {
  return handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
}

export interface OverlayResizePointerResolution {
  bounds: OverlayBounds;
  isRotated: boolean;
  preserveAspect: boolean;
  targetAspect: number | null;
}

export function resolveResizePointer(
  mode: Extract<OverlayInteractionMode, { id: "overlay.resize" }>,
  point: OverlayPoint,
  modifiers: { ctrlKey: boolean; shiftKey: boolean },
): OverlayResizePointerResolution {
  const localDelta = getLocalResizeDelta(
    point.x - mode.start.x,
    point.y - mode.start.y,
    mode.rotation,
  );
  const targetAspect = modifiers.ctrlKey
    ? getRegularResizeAspect(mode.shapes)
    : null;
  const preserveAspect = targetAspect === null
    && shouldPreserveResizeAspect(mode.shapes, mode.handle, modifiers.shiftKey);

  return {
    bounds: resizeBounds(mode.bounds, mode.handle, localDelta.x, localDelta.y, {
      preserveAspect,
      targetAspect,
    }),
    isRotated: Math.abs(mode.rotation) > 1e-8,
    preserveAspect,
    targetAspect,
  };
}

export function getRegularResizeAspect(shapes: readonly OverlayShape[]): number | null {
  if (shapes.length !== 1) {
    return null;
  }

  const shape = shapes[0];
  if (shape.type !== "geo") {
    return null;
  }

  return shape.props.geo === "triangle"
    ? EQUILATERAL_TRIANGLE_HEIGHT_RATIO
    : 1;
}

export function shouldPreserveResizeAspect(
  shapes: readonly Pick<OverlayShape, "type">[],
  handle: ResizeHandle,
  shiftKey: boolean,
): boolean {
  const isSingleImageCorner = shapes.length === 1
    && shapes[0].type === "image"
    && isCornerResizeHandle(handle);
  return isSingleImageCorner ? !shiftKey : shiftKey;
}

/**
 * A rotated selection box still resizes in the shape's own horizontal and
 * vertical axes. Convert the page-space pointer movement into those axes
 * before changing its unrotated bounds.
 */
export function getLocalResizeDelta(dx: number, dy: number, rotation: number): OverlayPoint {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: dx * cos + dy * sin,
    y: -dx * sin + dy * cos,
  };
}

export function resizeBounds(
  bounds: OverlayBounds,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: { preserveAspect?: boolean; targetAspect?: number | null } = {},
): OverlayBounds {
  const resized = rawResizeBounds(bounds, handle, dx, dy);
  const aspect = isCornerResizeHandle(handle)
    ? options.targetAspect ?? (options.preserveAspect ? bounds.h / bounds.w : null)
    : null;
  if (aspect === null) {
    return resized;
  }

  return constrainResizeBoundsToAspect(bounds, handle, resized, aspect);
}

export function rawResizeBounds(bounds: OverlayBounds, handle: ResizeHandle, dx: number, dy: number): OverlayBounds {
  if (handle === "nw") {
    return { x: bounds.x + dx, y: bounds.y + dy, w: bounds.w - dx, h: bounds.h - dy };
  }

  if (handle === "n") {
    return { x: bounds.x, y: bounds.y + dy, w: bounds.w, h: bounds.h - dy };
  }

  if (handle === "ne") {
    return { x: bounds.x, y: bounds.y + dy, w: bounds.w + dx, h: bounds.h - dy };
  }

  if (handle === "e") {
    return { x: bounds.x, y: bounds.y, w: bounds.w + dx, h: bounds.h };
  }

  if (handle === "se") {
    return { x: bounds.x, y: bounds.y, w: bounds.w + dx, h: bounds.h + dy };
  }

  if (handle === "s") {
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h + dy };
  }

  if (handle === "sw") {
    return { x: bounds.x + dx, y: bounds.y, w: bounds.w - dx, h: bounds.h + dy };
  }

  return { x: bounds.x + dx, y: bounds.y, w: bounds.w - dx, h: bounds.h };
}

function constrainResizeBoundsToAspect(
  bounds: OverlayBounds,
  handle: ResizeHandle,
  resized: OverlayBounds,
  aspect: number,
): OverlayBounds {
  if (aspect <= 0) {
    return resized;
  }

  const widthSign = dragSign(resized.w);
  const heightSign = dragSign(resized.h);
  const keepWidth = Math.abs(resized.w) >= Math.abs(resized.h) / aspect;
  const width = keepWidth
    ? resized.w
    : widthSign * Math.abs(resized.h) / aspect;
  const height = keepWidth
    ? heightSign * Math.abs(resized.w) * aspect
    : resized.h;
  return resizeBoundsFromSignedSize(bounds, handle, width, height);
}

function resizeBoundsFromSignedSize(
  bounds: OverlayBounds,
  handle: ResizeHandle,
  width: number,
  height: number,
): OverlayBounds {
  if (handle === "nw") {
    return { x: bounds.x + bounds.w - width, y: bounds.y + bounds.h - height, w: width, h: height };
  }

  if (handle === "ne") {
    return { x: bounds.x, y: bounds.y + bounds.h - height, w: width, h: height };
  }

  if (handle === "sw") {
    return { x: bounds.x + bounds.w - width, y: bounds.y, w: width, h: height };
  }

  return { x: bounds.x, y: bounds.y, w: width, h: height };
}
