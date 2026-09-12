import type { OverlayBounds, OverlayPoint, OverlayShape } from "@/features/document";

export function angleFromCenter(center: OverlayPoint, point: OverlayPoint): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}

export function getBoundsCenter(bounds: OverlayBounds): OverlayPoint {
  return {
    x: bounds.x + bounds.w / 2,
    y: bounds.y + bounds.h / 2,
  };
}

/**
 * The box a rotated rectangle occupies.
 *
 * `pivot` defaults to the rectangle's own centre, which is right whenever the rectangle *is* the
 * shape. A box that describes only part of a shape (the ink of an arc, say) turns around the
 * shape's pivot instead, and passing its own centre would leave the box behind.
 */
export function getAxisAlignedRotatedBounds(
  bounds: OverlayBounds,
  rotation: number,
  pivot?: OverlayPoint,
): OverlayBounds {
  if (!rotation) {
    return bounds;
  }

  const corners = getRotatedBoundsCorners(bounds, rotation, pivot);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

/**
 * The four corners of `bounds` after the rotation, clockwise from the top-left one.
 *
 * The turned rectangle itself, before it is flattened into an axis-aligned box: anything that
 * asks whether something *touches* the shape needs the corners, because the box around them also
 * covers four empty triangles.
 */
export function getRotatedBoundsCorners(
  bounds: OverlayBounds,
  rotation: number,
  pivot?: OverlayPoint,
): OverlayPoint[] {
  const center = pivot ?? getBoundsCenter(bounds);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
    { x: bounds.x, y: bounds.y + bounds.h },
  ].map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos,
    };
  });
}

/**
 * Does the turned rectangle overlap the axis-aligned one?
 *
 * A separating-axis test over the four edge normals the two rectangles have between them. Testing
 * the turned rectangle's own box instead would report a hit across the empty corners it leaves —
 * a marquee drawn over blank paper next to a slanted figure would catch it.
 *
 * Touching counts as a hit, as it does in {@link boundsIntersect}. No epsilon is applied: with no
 * rotation the call is handed straight to {@link boundsIntersect} so the two agree exactly, and a
 * near-miss at an odd angle is better reported as a hit than as a figure the author could not
 * catch.
 */
export function rotatedBoundsIntersectBounds(
  bounds: OverlayBounds,
  rotation: number,
  pivot: OverlayPoint | undefined,
  other: OverlayBounds,
): boolean {
  if (!rotation) {
    return boundsIntersect(bounds, other);
  }

  const corners = getRotatedBoundsCorners(bounds, rotation, pivot);
  const otherCorners = [
    { x: other.x, y: other.y },
    { x: other.x + other.w, y: other.y },
    { x: other.x + other.w, y: other.y + other.h },
    { x: other.x, y: other.y + other.h },
  ];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const axes: OverlayPoint[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: cos, y: sin },
    { x: -sin, y: cos },
  ];

  return axes.every((axis) => {
    const a = projectOntoAxis(corners, axis);
    const b = projectOntoAxis(otherCorners, axis);
    return a.max >= b.min && b.max >= a.min;
  });
}

function projectOntoAxis(
  points: readonly OverlayPoint[],
  axis: OverlayPoint,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const projection = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  return { min, max };
}

export function shapePointToSelectionLocal(shape: OverlayShape, bounds: OverlayBounds, point: OverlayPoint): OverlayPoint {
  return {
    x: shape.x + point.x - bounds.x,
    y: shape.y + point.y - bounds.y,
  };
}

/**
 * Reads a page point in the shape's own un-rotated frame.
 *
 * Takes the pivot rather than a box to derive it from: which box a shape turns around is one
 * decision, owned by `getShapeRotationPivot`, and it is not the centre of every box a caller
 * happens to hold.
 */
export function pagePointToUnrotatedShapePoint(
  point: OverlayPoint,
  pivot: OverlayPoint,
  rotation: number,
  flipX = false,
  flipY = false,
): OverlayPoint {
  let result = point;
  if (rotation) {
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const dx = point.x - pivot.x;
    const dy = point.y - pivot.y;
    result = {
      x: pivot.x + dx * cos - dy * sin,
      y: pivot.y + dx * sin + dy * cos,
    };
  }
  return {
    x: flipX ? pivot.x * 2 - result.x : result.x,
    y: flipY ? pivot.y * 2 - result.y : result.y,
  };
}

export function boundsFromPoints(points: OverlayPoint[]): OverlayBounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

export function getCenterDragBounds(center: OverlayPoint, point: OverlayPoint, regular: boolean): OverlayBounds {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (regular) {
    const r = Math.max(1, Math.hypot(dx, dy));
    return {
      x: center.x - r,
      y: center.y - r,
      w: r * 2,
      h: r * 2,
    };
  }

  const rx = Math.max(1, Math.abs(dx));
  const ry = Math.max(1, Math.abs(dy));
  return {
    x: center.x - rx,
    y: center.y - ry,
    w: rx * 2,
    h: ry * 2,
  };
}

export function boundsIntersect(a: OverlayBounds, b: OverlayBounds): boolean {
  return a.x <= b.x + b.w &&
    a.x + a.w >= b.x &&
    a.y <= b.y + b.h &&
    a.y + a.h >= b.y;
}

export function getBoundsUnion(bounds: readonly OverlayBounds[]): OverlayBounds | null {
  if (bounds.length === 0) {
    return null;
  }

  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.w));
  const bottom = Math.max(...bounds.map((item) => item.y + item.h));

  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

export function constrainPointToAspectFromStart(
  start: OverlayPoint,
  point: OverlayPoint,
  aspect: number,
): OverlayPoint {
  if (aspect <= 0) {
    return point;
  }

  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const widthFromX = Math.abs(dx);
  const widthFromY = Math.abs(dy) / aspect;
  const width = Math.max(widthFromX, widthFromY);
  return {
    x: start.x + dragSign(dx) * width,
    y: start.y + dragSign(dy) * width * aspect,
  };
}

export function getBoundsPageCorrection(start: number, size: number, pageSize: number): number {
  if (size >= pageSize) {
    return -start;
  }

  if (start < 0) {
    return -start;
  }

  const end = start + size;
  return end > pageSize ? pageSize - end : 0;
}

/**
 * Does `angle` fall inside the sweep that runs from `start` to `end` counter-clockwise?
 *
 * Shared so the drawn arc, the hit test and the selection box all agree on where the arc is:
 * they disagreed before, which is why a 90° arc could be clicked only along its own curve but was
 * boxed as a whole circle.
 */
export function angleInSweep(angle: number, start: number, end: number): boolean {
  const normalizedAngle = normalizePositiveAngle(angle);
  const normalizedStart = normalizePositiveAngle(start);
  const normalizedEnd = normalizePositiveAngle(end);
  if (normalizedStart <= normalizedEnd) {
    return normalizedAngle >= normalizedStart &&
      normalizedAngle <= normalizedEnd;
  }

  return normalizedAngle >= normalizedStart ||
    normalizedAngle <= normalizedEnd;
}

export function normalizePositiveAngle(angle: number): number {
  const fullCircle = Math.PI * 2;
  return ((angle % fullCircle) + fullCircle) % fullCircle;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function dragSign(value: number): 1 | -1 {
  return value < 0 ? -1 : 1;
}

/** 図形が小さいときにリサイズハンドルと重なって掴めなくなるのを避けるための閾値(px)。 */
const POINT_HANDLE_MIN_SHORT_AXIS = 24;
const ARC_RADIUS_HANDLE_MIN_SHORT_AXIS = 40;

export function getSelectionShortAxis(bounds: OverlayBounds): number {
  return Math.max(1, Math.min(bounds.w, bounds.h));
}

/** 選択枠が小さすぎる場合、全kindの点ハンドルを非表示にする。 */
export function shouldShowPointHandles(bounds: OverlayBounds): boolean {
  return getSelectionShortAxis(bounds) >= POINT_HANDLE_MIN_SHORT_AXIS;
}

/** arc の半径ハンドルは角度ハンドルより一回り大きい閾値で非表示にする。 */
export function shouldShowArcRadiusHandle(bounds: OverlayBounds): boolean {
  return getSelectionShortAxis(bounds) >= ARC_RADIUS_HANDLE_MIN_SHORT_AXIS;
}
