import type {
  OverlayArcShape,
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
} from "@/features/document";

import { getGraphRenderLayout } from "./graph-layout";
import { getCalloutGeometry } from "./callout-geometry";
import { getBoundsCenter, getBoundsUnion } from "./math";
import { getTextShapeEffectiveSize } from "./overlay-text-box";

export * from "./text-shape-font";
export * from "./overlay-text-box";

const POINT_SHAPE_PADDING = 10;

export const MIN_ARC_RADIUS = 0.5;

export function getShapeBounds(shape: OverlayShape): OverlayBounds {
  if (shape.type === "graph2dShape") {
    if (shape.props.boundsMode === "plot") {
      return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h };
    }
    const layout = getGraphRenderLayout(shape);
    return {
      x: layout.renderBounds.x + layout.plotBox.left * layout.scaleX,
      y: layout.renderBounds.y + layout.plotBox.top * layout.scaleY,
      w: Math.max(
        1,
        shape.props.w
          - (layout.plotBox.left + layout.plotBox.right) * layout.scaleX,
      ),
      h: Math.max(
        1,
        shape.props.h
          - (layout.plotBox.top + layout.plotBox.bottom) * layout.scaleY,
      ),
    };
  }

  if (
    shape.type === "group" ||
    shape.type === "geo" ||
    shape.type === "image" ||
    shape.type === "graph3dShape" ||
    shape.type === "tableShape" ||
    shape.type === "chartShape"
  ) {
    return {
      x: shape.x,
      y: shape.y,
      w: shape.props.w,
      h: shape.props.h,
    };
  }

  if (shape.type === "callout") {
    const bounds = getCalloutGeometry(shape).bounds;
    return {
      x: shape.x + bounds.x,
      y: shape.y + bounds.y,
      w: bounds.w,
      h: bounds.h,
    };
  }

  if (shape.type === "arc") {
    const { rx, ry } = getArcRadii(shape);
    return {
      x: shape.x,
      y: shape.y,
      w: rx * 2,
      h: ry * 2,
    };
  }

  if (shape.type === "text") {
    const size = getTextShapeEffectiveSize(shape);
    return {
      x: shape.x,
      y: shape.y,
      w: size.w,
      h: size.h,
    };
  }

  if (shape.type === "arrow") {
    return getPointBounds(
      shape.x,
      shape.y,
      [shape.props.start, shape.props.end],
      POINT_SHAPE_PADDING,
    );
  }

  if (shape.type === "line") {
    return getPointBounds(
      shape.x,
      shape.y,
      shape.props.points,
      POINT_SHAPE_PADDING,
    );
  }

  return { x: 0, y: 0, w: 1, h: 1 };
}

export function getShapeSelectionBounds(shape: OverlayShape): OverlayBounds {
  return getShapeBounds(shape);
}

export function getShapeDimensionBounds(shape: OverlayShape): OverlayBounds {
  if (shape.type === "graph2dShape") {
    return getShapeSelectionBounds(shape);
  }

  if (shape.type === "arrow") {
    return getPointBounds(
      shape.x,
      shape.y,
      [shape.props.start, shape.props.end],
      0,
    );
  }

  if (shape.type === "line") {
    return getPointBounds(shape.x, shape.y, shape.props.points, 0);
  }

  return getShapeBounds(shape);
}

export function getShapesSelectionBounds(
  shapes: OverlayShape[],
): OverlayBounds | null {
  if (shapes.length === 0) {
    return null;
  }

  return shapes
    .map(getShapeSelectionBounds)
    .reduce((bounds, next) => unionBounds(bounds, next));
}

export function getShapesBounds(
  shapes: OverlayShape[],
): OverlayBounds | null {
  return getBoundsUnion(shapes.map((shape) => getShapeBounds(shape)));
}

export function getShapeRotation(shape: OverlayShape): number {
  if (shape.type === "tableShape" || shape.type === "group") {
    return 0;
  }
  return typeof shape.rotation === "number" && Number.isFinite(shape.rotation)
    ? shape.rotation
    : 0;
}

export function getShapeCenter(shape: OverlayShape): OverlayPoint {
  return getBoundsCenter(getShapeBounds(shape));
}

export function getArcRadii(
  shape: OverlayArcShape,
): { rx: number; ry: number } {
  const fallback = Math.max(MIN_ARC_RADIUS, shape.props.r);
  const rx = typeof shape.props.rx === "number" && Number.isFinite(shape.props.rx)
    ? Math.max(MIN_ARC_RADIUS, shape.props.rx)
    : fallback;
  const ry = typeof shape.props.ry === "number" && Number.isFinite(shape.props.ry)
    ? Math.max(MIN_ARC_RADIUS, shape.props.ry)
    : fallback;
  return { rx, ry };
}

/** @deprecated Prefer `getTextShapeEffectiveSize(shape).h`; kept for existing callers. */
export function getTextShapeBoundsHeight(
  shape: Extract<OverlayShape, { type: "text" }>,
): number {
  return getTextShapeEffectiveSize(shape).h;
}

function getPointBounds(
  x: number,
  y: number,
  points: OverlayPoint[],
  padding: number,
): OverlayBounds {
  if (points.length === 0) {
    return { x, y, w: 1, h: 1 };
  }

  const xs = points.map((point) => x + point.x);
  const ys = points.map((point) => y + point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX - padding,
    y: minY - padding,
    w: Math.max(1, maxX - minX + padding * 2),
    h: Math.max(1, maxY - minY + padding * 2),
  };
}

function unionBounds(a: OverlayBounds, b: OverlayBounds): OverlayBounds {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export { getOverlayTextBlocksLineCount } from "@/features/rendering/core";
