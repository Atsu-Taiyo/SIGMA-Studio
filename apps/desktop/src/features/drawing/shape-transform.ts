import type { OverlayBounds, OverlayShape } from "@/features/document";

import { toEffectiveCalloutPoint } from "./callout-geometry";
import {
  getGraphPlotBox,
  GRAPH_BOUNDS_MODE,
} from "./graph-layout";
import { clamp } from "./math";
import { getCalloutBodySize } from "./overlay-text-box";
import {
  getShapeBounds,
  getShapeRotation,
  getTextShapeEffectiveSize,
  MIN_TEXT_SHAPE_WIDTH,
} from "./shape-bounds";

const FULL_CIRCLE = Math.PI * 2;
const MIN_BOX_SHAPE_SIZE = 1;

/**
 * Text glyphs flow from the local top-left, but changing the box size also moves its rotation
 * pivot. Translating by the rotated half-size change minus the unrotated one keeps that glyph
 * origin at the same page point; at zero rotation the two terms cancel exactly.
 */
export function getRotatedResizeTopLeftDelta(
  previousSize: Pick<OverlayBounds, "w" | "h">,
  nextSize: Pick<OverlayBounds, "w" | "h">,
  rotation: number,
): { dx: number; dy: number } {
  const halfX = (nextSize.w - previousSize.w) / 2;
  const halfY = (nextSize.h - previousSize.h) / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    dx: halfX * cos - halfY * sin - halfX,
    dy: halfX * sin + halfY * cos - halfY,
  };
}

/**
 * Holds a rotated text box's local top-left still while its content-derived size changes.
 *
 * A shape's page position is stored twice over: `resolveShapesPosition` recomputes `x`/`y` from
 * the anchor offsets before rendering, and `reanchorShapesAgainstCanvas` recomputes those offsets
 * back from `x`/`y` on every save. Writing only one side is therefore not a partial fix but a
 * guaranteed no-op — whichever pass runs next restores what it derives. Moving every value by the
 * same delta makes the two directions agree instead of overwrite each other.
 *
 * That is also why `dy` and `line.dy` are both shifted even though rendering reads exactly one of
 * them: which one wins depends on whether the anchored line still resolves, a fact that lives in
 * measured DOM rather than in the shape. Shifting both keeps the answer right either way, and
 * keeps the two fields from drifting apart the moment a line target appears or disappears.
 */
export function preserveRotatedTextResizeTopLeft<T extends Extract<OverlayShape, { type: "text" | "callout" }>>(
  previous: T,
  next: T,
): T {
  const previousBounds = getShapeBounds(previous);
  const nextBounds = getShapeBounds(next);
  const delta = getRotatedResizeTopLeftDelta(previousBounds, nextBounds, getShapeRotation(next));
  if (delta.dx === 0 && delta.dy === 0) {
    return next;
  }

  const moved = {
    ...next,
    x: next.x + delta.dx,
    y: next.y + delta.dy,
  };
  const anchor = next.anchor;
  if (anchor?.type === "shape") {
    return {
      ...moved,
      anchor: { ...anchor, dx: anchor.dx + delta.dx, dy: anchor.dy + delta.dy },
    };
  }

  if (anchor?.type === "block") {
    return {
      ...moved,
      anchor: {
        ...anchor,
        ...(typeof anchor.dx === "number" ? { dx: anchor.dx + delta.dx } : {}),
        dy: anchor.dy + delta.dy,
        ...(anchor.line ? { line: { ...anchor.line, dy: anchor.line.dy + delta.dy } } : {}),
      },
    };
  }

  return moved;
}

export function moveShape(
  shape: OverlayShape,
  dx: number,
  dy: number,
): OverlayShape {
  return {
    ...shape,
    x: shape.x + dx,
    y: shape.y + dy,
  } as OverlayShape;
}

export function rotateShape(
  shape: OverlayShape,
  rotation: number,
): OverlayShape {
  return {
    ...shape,
    rotation: canonicalizeRotation(rotation),
  } as OverlayShape;
}

export function flipShape(
  shape: OverlayShape,
  axis: "horizontal" | "vertical",
): OverlayShape {
  const key = axis === "horizontal" ? "flipX" : "flipY";
  const next = { ...shape, [key]: !shape[key] } as OverlayShape;
  if (!next[key]) {
    delete next[key];
  }
  return next;
}

export function resizeBoxShape(
  shape: OverlayShape,
  bounds: OverlayBounds,
): OverlayShape {
  const nextBounds = normalizeBounds(bounds);
  if (shape.type === "graph2dShape") {
    const plotBox = getGraphPlotBox(shape.props.spec);
    const nextSpec = shape.props.preserveSpecSize === true
      ? shape.props.spec
      : {
          ...shape.props.spec,
          width: nextBounds.w + plotBox.left + plotBox.right,
          height: nextBounds.h + plotBox.top + plotBox.bottom,
        };
    return {
      ...shape,
      x: nextBounds.x,
      y: nextBounds.y,
      props: {
        ...shape.props,
        boundsMode: GRAPH_BOUNDS_MODE,
        w: nextBounds.w,
        h: nextBounds.h,
        spec: nextSpec,
      },
    };
  }

  if (
    shape.type === "group" ||
    shape.type === "geo" ||
    shape.type === "arc" ||
    shape.type === "image" ||
    shape.type === "callout" ||
    shape.type === "graph3dShape" ||
    shape.type === "tableShape" ||
    shape.type === "chartShape"
  ) {
    if (shape.type === "arc") {
      return {
        ...shape,
        x: nextBounds.x,
        y: nextBounds.y,
        props: {
          ...shape.props,
          r: Math.max(nextBounds.w, nextBounds.h) / 2,
          rx: nextBounds.w / 2,
          ry: nextBounds.h / 2,
        },
      };
    }

    if (shape.type === "geo" && shape.props.geo === "triangle") {
      const previousApexX = getTriangleApexX(shape);
      const nextApexX =
        (previousApexX / Math.max(1, shape.props.w)) * nextBounds.w;
      return {
        ...shape,
        x: nextBounds.x,
        y: nextBounds.y,
        props: {
          ...shape.props,
          w: nextBounds.w,
          h: nextBounds.h,
          apexX: clamp(nextApexX, 0, nextBounds.w),
        },
      };
    }

    if (shape.type === "callout") {
      // `currentBounds` (from `getShapeBounds`) reflects the *effective*, content-grown body —
      // scale factors are derived from that so a drag that doesn't move the handle at all keeps
      // the box exactly as rendered. But the new `props.w`/`props.h` must be derived from the
      // effective body size (`getCalloutBodySize`), not the stored `shape.props.w`/`h`: scaling
      // the still-small stored size would visibly shrink the box back down on the very first
      // resize drag, undoing the growth this feature exists to produce.
      const currentBounds = getShapeBounds(shape);
      const body = getCalloutBodySize(shape);
      const scaleX = nextBounds.w / Math.max(1, currentBounds.w);
      const scaleY = nextBounds.h / Math.max(1, currentBounds.h);
      // Tail points are stored relative to the old `props.w`/`props.h`; map them into the
      // effective frame first (matching what was actually rendered) before scaling — otherwise
      // `scalePoint` would scale a stale, pre-growth tail position. Do NOT use `scalePoint` on
      // stored coordinates directly (see `resizeBoxShape`'s docs / `toEffectiveCalloutPoint`):
      // ratio-scaling the raw tip would send it flying the instant a small box grows a lot.
      const effectiveTail = {
        baseStart: toEffectiveCalloutPoint(shape, shape.props.tail.baseStart),
        baseEnd: toEffectiveCalloutPoint(shape, shape.props.tail.baseEnd),
        tip: toEffectiveCalloutPoint(shape, shape.props.tail.tip),
      };
      return {
        ...shape,
        x: nextBounds.x + (shape.x - currentBounds.x) * scaleX,
        y: nextBounds.y + (shape.y - currentBounds.y) * scaleY,
        props: {
          ...shape.props,
          w: body.w * scaleX,
          h: body.h * scaleY,
          tail: {
            baseStart: scalePoint(effectiveTail.baseStart, scaleX, scaleY),
            baseEnd: scalePoint(effectiveTail.baseEnd, scaleX, scaleY),
            tip: scalePoint(effectiveTail.tip, scaleX, scaleY),
          },
        },
      };
    }

    return {
      ...shape,
      x: nextBounds.x,
      y: nextBounds.y,
      props: {
        ...shape.props,
        w: nextBounds.w,
        h: nextBounds.h,
      },
    } as OverlayShape;
  }

  if (shape.type === "text") {
    return resizeTextShapeToBounds(shape, nextBounds);
  }

  return shape;
}

export function canBoxResize(shape: OverlayShape): boolean {
  return shape.type === "geo" ||
    shape.type === "group" ||
    shape.type === "arc" ||
    shape.type === "image" ||
    shape.type === "callout" ||
    shape.type === "graph2dShape" ||
    shape.type === "graph3dShape" ||
    shape.type === "tableShape" ||
    shape.type === "chartShape" ||
    shape.type === "text";
}

/**
 * Resizing a text shape moves the wrap width, never the glyphs: the font size is not part of the
 * geometry, so the box takes the new width (clamped) and re-derives its height from the content.
 *
 * When the clamp bites, the edge the author is *not* dragging has to stay put. Dragging the left
 * edge past the minimum otherwise keeps sliding the box leftwards at a fixed width, because `x`
 * would follow the pointer while `w` stopped — the shape would walk away under the cursor. Which
 * edge is moving is read off the bounds themselves — a west-side drag moves the left edge and
 * leaves the right one exactly where it was — so this needs no knowledge of the handle.
 *
 * Both edges moving is a different gesture: a selection being scaled around a box the shape is
 * only part of. There the clamp must hold the left edge, or a member that scales below the
 * minimum pops out of the box the rest of the selection is following.
 */
function resizeTextShapeToBounds(
  shape: Extract<OverlayShape, { type: "text" }>,
  nextBounds: OverlayBounds,
): Extract<OverlayShape, { type: "text" }> {
  const width = Math.max(MIN_TEXT_SHAPE_WIDTH, nextBounds.w);
  const keepsRightEdge = Math.abs((nextBounds.x + nextBounds.w) - (shape.x + shape.props.w)) < 0.5;
  const movesLeftEdge = nextBounds.x !== shape.x && keepsRightEdge;
  const x = movesLeftEdge ? nextBounds.x + nextBounds.w - width : nextBounds.x;
  const resized: Extract<OverlayShape, { type: "text" }> = {
    ...shape,
    props: { ...shape.props, w: width },
  };

  return {
    ...resized,
    x,
    y: nextBounds.y,
    props: {
      ...resized.props,
      h: getTextShapeEffectiveSize(resized).h,
    },
  };
}

function canonicalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) {
    return 0;
  }

  const canonical = ((rotation % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
  return canonical > Math.PI ? canonical - FULL_CIRCLE : canonical;
}

function normalizeBounds(
  bounds: OverlayBounds,
  minSize = MIN_BOX_SHAPE_SIZE,
): OverlayBounds {
  const x = bounds.w < 0 ? bounds.x + bounds.w : bounds.x;
  const y = bounds.h < 0 ? bounds.y + bounds.h : bounds.y;
  return {
    x,
    y,
    w: Math.max(minSize, Math.abs(bounds.w)),
    h: Math.max(minSize, Math.abs(bounds.h)),
  };
}

function getTriangleApexX(
  shape: Extract<OverlayShape, { type: "geo" }>,
): number {
  return clamp(shape.props.apexX ?? shape.props.w / 2, 0, shape.props.w);
}

function scalePoint(point: { x: number; y: number }, scaleX: number, scaleY: number): { x: number; y: number } {
  return { x: point.x * scaleX, y: point.y * scaleY };
}
