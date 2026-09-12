import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
} from "@/features/document";

import type { ResizeHandle } from "./interaction-mode";
import {
  boundsFromPoints,
  getBoundsCenter,
  getBoundsPageCorrection,
} from "./math";
import {
  getShapeDimensionBounds,
  getShapeRotation,
  getShapeSelectionBounds,
  getShapesBounds,
} from "./shape-bounds";
import {
  flipShape,
  moveShape,
  resizeBoxShape,
  rotateShape,
} from "./shape-transform";
import { getShapeRotationPivot } from "./shape-visual-bounds";

export type OverlayAlignAction =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom";
export type OverlayDistributeAxis = "horizontal" | "vertical";
export type OverlayFlipAxis = "horizontal" | "vertical";

type OverlayAlignAxis = "x" | "y" | "horizontal" | "vertical";

function getShapesLayoutBounds(shapes: OverlayShape[]): OverlayBounds | null {
  if (shapes.length === 0) {
    return null;
  }

  return shapes
    .map(getShapeDimensionBounds)
    .reduce((bounds, next) => unionBounds(bounds, next));
}

export function moveShapes(
  shapes: OverlayShape[],
  dx: number,
  dy: number,
): OverlayShape[] {
  return shapes.map((shape) => moveShape(shape, dx, dy));
}

/**
 * Scales a selection from one box to another, shape by shape.
 *
 * Each shape decides what a new box means for it, and a text shape takes only the horizontal
 * factor: its height is derived from its content and its type size is not geometry. Scaling a
 * group used to enlarge the glyphs inside it, which is the same "resizing changes the font"
 * behaviour the single-shape path dropped.
 */
export function resizeShapesToBounds(
  shapes: OverlayShape[],
  fromBounds: OverlayBounds,
  toBounds: OverlayBounds,
): OverlayShape[] {
  return shapes.map((shape) => {
    if (isPointShape(shape)) {
      return resizePointShapeToBounds(shape, fromBounds, toBounds);
    }

    return resizeBoxShape(
      shape,
      transformBounds(getShapeSelectionBounds(shape), fromBounds, toBounds),
    );
  });
}

/**
 * Resize one rotated shape while keeping the handle opposite the dragged
 * handle fixed on the page. The model bounds are unrotated, but the visible
 * shape rotates around its center; resizing the bounds alone would therefore
 * move that fixed handle and make the whole shape appear to jump.
 *
 * This follows the same interaction pattern as the canvas editor’s rotated resize: the
 * resize is expressed in the selection's local axes and scaled around the
 * opposite page-space handle. external canvas editors is an implementation reference only.
 *
 * `measureInFrame` must report the resized shape in the same frame `fromBounds`
 * was measured in — the fixed handle is the same corner of both rectangles, so
 * reading one of them off a different box makes the shape jump. It defaults to
 * the reference box, which is the frame every caller used before the visible
 * frame existed.
 */
export function resizeRotatedShapeToBounds(
  shape: OverlayShape,
  fromBounds: OverlayBounds,
  toBounds: OverlayBounds,
  handle: ResizeHandle,
  measureInFrame: (shape: OverlayShape) => OverlayBounds = getShapeSelectionBounds,
): OverlayShape {
  const rotation = getShapeRotation(shape);
  const fixedPagePoint = rotatePointAround(
    getOppositeResizeHandlePoint(fromBounds, handle),
    getShapeRotationPivot(shape),
    rotation,
  );
  const [resized] = resizeShapesToBounds([shape], fromBounds, toBounds);
  const resizedBounds = measureInFrame(resized);
  const resizedHandle = flipResizeHandle(
    handle,
    toBounds.w < 0,
    toBounds.h < 0,
  );
  // Measured on `resized`, not on `shape`: the pivot moves with the ink, so a resize that changes
  // an arc's radius moves the point it turns around too.
  const resizedFixedPagePoint = rotatePointAround(
    getOppositeResizeHandlePoint(resizedBounds, resizedHandle),
    getShapeRotationPivot(resized),
    rotation,
  );

  return moveShape(
    resized,
    fixedPagePoint.x - resizedFixedPagePoint.x,
    fixedPagePoint.y - resizedFixedPagePoint.y,
  );
}

/**
 * Turns a whole selection rigidly: each shape's own pivot is carried around `center`, and the
 * shape then spins that same delta about the pivot it landed on. Moving the pivot rather than the
 * reference-box centre is what makes an arc follow the group instead of swinging off to one side.
 */
export function rotateShapesAround(
  shapes: OverlayShape[],
  center: OverlayPoint,
  deltaRadians: number,
): OverlayShape[] {
  return shapes.map((shape) => {
    const pivot = getShapeRotationPivot(shape);
    const nextPivot = rotatePointAround(
      pivot,
      center,
      deltaRadians,
    );
    const moved = moveShape(
      shape,
      nextPivot.x - pivot.x,
      nextPivot.y - pivot.y,
    );
    return rotateShape(moved, getShapeRotation(shape) + deltaRadians);
  });
}

/**
 * Mirrors a selection in page space while keeping each shape's reflection in its own local
 * transform. This is the same decomposition used by mature canvas editors: reflect the pivot,
 * negate the rotation, then toggle the matching local mirror. SigmaDoc remains the source of
 * truth; external canvas editors is an interaction reference only.
 */
export function flipShapesAround(
  shapes: OverlayShape[],
  center: OverlayPoint,
  axis: OverlayFlipAxis,
): OverlayShape[] {
  return shapes.map((shape) => {
    const pivot = getShapeRotationPivot(shape);
    const nextPivot = axis === "horizontal"
      ? { x: center.x * 2 - pivot.x, y: pivot.y }
      : { x: pivot.x, y: center.y * 2 - pivot.y };
    const moved = moveShape(shape, nextPivot.x - pivot.x, nextPivot.y - pivot.y);
    return flipShape(
      rotateShape(moved, -getShapeRotation(shape)),
      axis,
    );
  });
}

export function alignShapes(
  shapes: OverlayShape[],
  action: OverlayAlignAction,
): OverlayShape[];
export function alignShapes(
  shapes: OverlayShape[],
  axis: OverlayAlignAxis,
  action: OverlayAlignAction,
): OverlayShape[];
export function alignShapes(
  shapes: OverlayShape[],
  axisOrAction: OverlayAlignAxis | OverlayAlignAction,
  maybeAction?: OverlayAlignAction,
): OverlayShape[] {
  const action = resolveAlignAction(axisOrAction, maybeAction);
  const layoutBounds = getShapesLayoutBounds(shapes);
  if (!layoutBounds) {
    return shapes;
  }

  return shapes.map((shape) => {
    const bounds = getShapeDimensionBounds(shape);
    const delta = getAlignDelta(bounds, layoutBounds, action);
    return moveShape(shape, delta.x, delta.y);
  });
}

export function distributeShapes(
  shapes: OverlayShape[],
  axis: OverlayDistributeAxis,
): OverlayShape[] {
  if (shapes.length < 3) {
    return shapes;
  }

  const horizontal = axis === "horizontal";
  const boundsById = new Map(
    shapes.map((shape) => [shape.id, getShapeDimensionBounds(shape)]),
  );
  const sorted = shapes.slice().sort((a, b) => {
    const aBounds = boundsById.get(a.id);
    const bBounds = boundsById.get(b.id);
    if (!aBounds || !bBounds) {
      return 0;
    }
    return horizontal
      ? aBounds.x - bBounds.x
      : aBounds.y - bBounds.y;
  });
  const first = boundsById.get(sorted[0].id);
  const last = boundsById.get(sorted[sorted.length - 1].id);
  if (!first || !last) {
    return shapes;
  }

  const totalSize = sorted.reduce((sum, shape) => {
    const bounds = boundsById.get(shape.id);
    return sum + (horizontal ? bounds?.w ?? 0 : bounds?.h ?? 0);
  }, 0);
  const span = horizontal
    ? last.x + last.w - first.x
    : last.y + last.h - first.y;
  const gap = (span - totalSize) / (sorted.length - 1);
  const deltas = new Map<OverlayShapeId, OverlayPoint>();
  let cursor = horizontal ? first.x : first.y;

  for (const shape of sorted) {
    const bounds = boundsById.get(shape.id);
    if (!bounds) {
      continue;
    }

    deltas.set(
      shape.id,
      horizontal
        ? { x: cursor - bounds.x, y: 0 }
        : { x: 0, y: cursor - bounds.y },
    );
    cursor += (horizontal ? bounds.w : bounds.h) + gap;
  }

  return shapes.map((shape) => {
    const delta = deltas.get(shape.id);
    return delta
      ? moveShape(shape, delta.x, delta.y)
      : shape;
  });
}

export function fitShapesWithinPage(
  shapes: OverlayShape[],
  coordWidth: number,
  coordHeight: number,
): OverlayShape[] {
  const bounds = getShapesBounds(shapes);
  if (!bounds) {
    return shapes;
  }

  const dx = getBoundsPageCorrection(bounds.x, bounds.w, coordWidth);
  const dy = getBoundsPageCorrection(bounds.y, bounds.h, coordHeight);
  if (dx === 0 && dy === 0) {
    return shapes;
  }

  return moveShapes(shapes, dx, dy);
}

function resolveAlignAction(
  axisOrAction: OverlayAlignAxis | OverlayAlignAction,
  maybeAction?: OverlayAlignAction,
): OverlayAlignAction {
  if (!maybeAction) {
    return axisOrAction as OverlayAlignAction;
  }

  if (
    (axisOrAction === "y" || axisOrAction === "vertical")
    && maybeAction === "center"
  ) {
    return "middle";
  }

  return maybeAction;
}

function getAlignDelta(
  bounds: OverlayBounds,
  selectionBounds: OverlayBounds,
  action: OverlayAlignAction,
): OverlayPoint {
  if (action === "left") {
    return { x: selectionBounds.x - bounds.x, y: 0 };
  }
  if (action === "center") {
    return {
      x: getBoundsCenter(selectionBounds).x - getBoundsCenter(bounds).x,
      y: 0,
    };
  }
  if (action === "right") {
    return {
      x: selectionBounds.x + selectionBounds.w - bounds.x - bounds.w,
      y: 0,
    };
  }
  if (action === "top") {
    return { x: 0, y: selectionBounds.y - bounds.y };
  }
  if (action === "middle") {
    return {
      x: 0,
      y: getBoundsCenter(selectionBounds).y - getBoundsCenter(bounds).y,
    };
  }
  if (action === "bottom") {
    return {
      x: 0,
      y: selectionBounds.y + selectionBounds.h - bounds.y - bounds.h,
    };
  }
  return { x: 0, y: 0 };
}

function resizePointShapeToBounds(
  shape: Extract<OverlayShape, { type: "arrow" | "line" }>,
  fromBounds: OverlayBounds,
  toBounds: OverlayBounds,
): OverlayShape {
  if (shape.type === "arrow") {
    const points = [
      transformPoint(
        absolutePoint(shape, shape.props.start),
        fromBounds,
        toBounds,
      ),
      transformPoint(
        absolutePoint(shape, shape.props.end),
        fromBounds,
        toBounds,
      ),
    ];
    const origin = getPointsOrigin(points);
    return {
      ...shape,
      x: origin.x,
      y: origin.y,
      props: {
        ...shape.props,
        start: localPoint(origin, points[0]),
        end: localPoint(origin, points[1]),
      },
    };
  }

  const points = shape.props.points.map((point) => (
    transformPoint(absolutePoint(shape, point), fromBounds, toBounds)
  ));
  if (points.length === 0) {
    return shape;
  }

  const origin = getPointsOrigin(points);
  return {
    ...shape,
    x: origin.x,
    y: origin.y,
    props: {
      ...shape.props,
      points: points.map((point) => localPoint(origin, point)),
    },
  } as OverlayShape;
}

function isPointShape(
  shape: OverlayShape,
): shape is Extract<OverlayShape, { type: "arrow" | "line" }> {
  return shape.type === "arrow" || shape.type === "line";
}

function unionBounds(
  a: OverlayBounds,
  b: OverlayBounds,
): OverlayBounds {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.w, b.x + b.w);
  const maxY = Math.max(a.y + a.h, b.y + b.h);
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function transformBounds(
  bounds: OverlayBounds,
  fromBounds: OverlayBounds,
  toBounds: OverlayBounds,
): OverlayBounds {
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
    { x: bounds.x, y: bounds.y + bounds.h },
  ].map((point) => transformPoint(point, fromBounds, toBounds));
  return boundsFromPoints(corners);
}

function transformPoint(
  point: OverlayPoint,
  fromBounds: OverlayBounds,
  toBounds: OverlayBounds,
): OverlayPoint {
  const scaleX = fromBounds.w === 0
    ? 1
    : toBounds.w / fromBounds.w;
  const scaleY = fromBounds.h === 0
    ? 1
    : toBounds.h / fromBounds.h;
  return {
    x: toBounds.x + (point.x - fromBounds.x) * scaleX,
    y: toBounds.y + (point.y - fromBounds.y) * scaleY,
  };
}

function rotatePointAround(
  point: OverlayPoint,
  center: OverlayPoint,
  rotation: number,
): OverlayPoint {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

function getOppositeResizeHandlePoint(
  bounds: OverlayBounds,
  handle: ResizeHandle,
): OverlayPoint {
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;

  if (handle === "nw") {
    return { x: bounds.x + bounds.w, y: bounds.y + bounds.h };
  }
  if (handle === "n") {
    return { x: centerX, y: bounds.y + bounds.h };
  }
  if (handle === "ne") {
    return { x: bounds.x, y: bounds.y + bounds.h };
  }
  if (handle === "e") {
    return { x: bounds.x, y: centerY };
  }
  if (handle === "se") {
    return { x: bounds.x, y: bounds.y };
  }
  if (handle === "s") {
    return { x: centerX, y: bounds.y };
  }
  if (handle === "sw") {
    return { x: bounds.x + bounds.w, y: bounds.y };
  }
  return { x: bounds.x + bounds.w, y: centerY };
}

function flipResizeHandle(
  handle: ResizeHandle,
  flipX: boolean,
  flipY: boolean,
): ResizeHandle {
  let next = handle;
  if (flipX) {
    const horizontalFlips: Record<ResizeHandle, ResizeHandle> = {
      nw: "ne",
      n: "n",
      ne: "nw",
      e: "w",
      se: "sw",
      s: "s",
      sw: "se",
      w: "e",
    };
    next = horizontalFlips[next];
  }
  if (flipY) {
    const verticalFlips: Record<ResizeHandle, ResizeHandle> = {
      nw: "sw",
      n: "s",
      ne: "se",
      e: "e",
      se: "ne",
      s: "n",
      sw: "nw",
      w: "w",
    };
    next = verticalFlips[next];
  }
  return next;
}

function absolutePoint(
  shape: OverlayShape,
  point: OverlayPoint,
): OverlayPoint {
  return {
    x: shape.x + point.x,
    y: shape.y + point.y,
  };
}

function localPoint(
  origin: OverlayPoint,
  point: OverlayPoint,
): OverlayPoint {
  return {
    x: point.x - origin.x,
    y: point.y - origin.y,
  };
}

function getPointsOrigin(points: OverlayPoint[]): OverlayPoint {
  return {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
  };
}
