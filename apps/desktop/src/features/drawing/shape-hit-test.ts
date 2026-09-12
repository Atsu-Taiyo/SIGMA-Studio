import type { OverlayPoint, OverlayShape } from "@/features/document";

import { getBlockArrowPolygonPoints } from "./block-arrow-geometry";
import { isClosedPolyline } from "./line-geometry";
import {
  angleInSweep,
} from "./math";
import {
  getRegularPolygonPoints,
  normalizeRegularPolygonSides,
} from "./regular-polygon-geometry";
import {
  getArcRadii,
  getShapeRotation,
  getShapeSelectionBounds,
} from "./shape-bounds";
import { getShapeRotationPivot } from "./shape-visual-bounds";

export function hitTestShape(
  shape: OverlayShape,
  point: OverlayPoint,
  margin = 6,
): boolean {
  const bounds = getShapeSelectionBounds(shape);
  const effectiveMargin = shape.type === "graph2dShape" ? 0 : margin;
  const rotation = getShapeRotation(shape);
  // Un-rotate the pointer around the same point the figure is drawn turning about, so the hit area
  // lands on the ink rather than 25px away from it.
  let testPoint = rotation === 0
    ? point
    : rotatePointAround(point, getShapeRotationPivot(shape), -rotation);
  if (shape.flipX || shape.flipY) {
    const pivot = getShapeRotationPivot(shape);
    testPoint = {
      x: shape.flipX ? pivot.x * 2 - testPoint.x : testPoint.x,
      y: shape.flipY ? pivot.y * 2 - testPoint.y : testPoint.y,
    };
  }

  if (shape.type === "geo" && shape.props.geo === "ellipse") {
    const rx = Math.max(1, bounds.w / 2 + effectiveMargin);
    const ry = Math.max(1, bounds.h / 2 + effectiveMargin);
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const normalized = ((testPoint.x - cx) ** 2) / (rx ** 2) +
      ((testPoint.y - cy) ** 2) / (ry ** 2);
    return normalized <= 1;
  }

  if (
    shape.type === "geo" &&
    (
      shape.props.geo === "triangle" ||
      shape.props.geo === "diamond" ||
      shape.props.geo === "pentagon" ||
      shape.props.geo === "regularPolygon" ||
      shape.props.geo === "blockArrow"
    ) &&
    effectiveMargin === 0
  ) {
    return pointInPolygon(testPoint, getGeoPolygonPoints(shape));
  }

  if (shape.type === "arrow") {
    return distanceToSegment(
      testPoint,
      { x: shape.x + shape.props.start.x, y: shape.y + shape.props.start.y },
      { x: shape.x + shape.props.end.x, y: shape.y + shape.props.end.y },
    ) <= effectiveMargin + 5;
  }

  if (shape.type === "arc") {
    return hitTestArc(shape, testPoint, effectiveMargin + 6);
  }

  if (shape.type === "line") {
    const points = shape.props.points.map((item) => ({
      x: shape.x + item.x,
      y: shape.y + item.y,
    }));
    const closed = isClosedPolyline(
      shape.props.kind,
      points,
      shape.props.closed,
    );
    if (
      closed &&
      shape.props.fill === "solid" &&
      pointInPolygon(testPoint, points)
    ) {
      return true;
    }
    for (let index = 0; index < points.length - 1; index += 1) {
      if (
        distanceToSegment(testPoint, points[index], points[index + 1]) <=
          effectiveMargin + 5
      ) {
        return true;
      }
    }
    if (
      closed &&
      distanceToSegment(testPoint, points[points.length - 1], points[0]) <=
        effectiveMargin + 5
    ) {
      return true;
    }

    return false;
  }

  return (
    testPoint.x >= bounds.x - effectiveMargin &&
    testPoint.x <= bounds.x + bounds.w + effectiveMargin &&
    testPoint.y >= bounds.y - effectiveMargin &&
    testPoint.y <= bounds.y + bounds.h + effectiveMargin
  );
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

function getGeoPolygonPoints(
  shape: Extract<OverlayShape, { type: "geo" }>,
): OverlayPoint[] {
  if (shape.props.geo === "blockArrow") {
    return getBlockArrowPolygonPoints(
      shape.props.w,
      shape.props.h,
      shape.props.headLengthRatio,
      shape.props.shaftRatio,
    ).map((point) => ({ x: shape.x + point.x, y: shape.y + point.y }));
  }

  if (shape.props.geo === "triangle") {
    return [
      { x: shape.x + getTriangleApexX(shape), y: shape.y },
      { x: shape.x + shape.props.w, y: shape.y + shape.props.h },
      { x: shape.x, y: shape.y + shape.props.h },
    ];
  }

  if (shape.props.geo === "diamond") {
    return [
      { x: shape.x + shape.props.w / 2, y: shape.y },
      { x: shape.x + shape.props.w, y: shape.y + shape.props.h / 2 },
      { x: shape.x + shape.props.w / 2, y: shape.y + shape.props.h },
      { x: shape.x, y: shape.y + shape.props.h / 2 },
    ];
  }

  const sides = shape.props.geo === "pentagon"
    ? 5
    : normalizeRegularPolygonSides(shape.props.polygonSides);
  return getRegularPolygonPoints(shape.props.w, shape.props.h, sides)
    .map((point) => ({ x: shape.x + point.x, y: shape.y + point.y }));
}

function getTriangleApexX(
  shape: Extract<OverlayShape, { type: "geo" }>,
): number {
  return Math.min(
    shape.props.w,
    Math.max(0, shape.props.apexX ?? shape.props.w / 2),
  );
}

function hitTestArc(
  shape: Extract<OverlayShape, { type: "arc" }>,
  point: OverlayPoint,
  tolerance: number,
): boolean {
  const { rx, ry } = getArcRadii(shape);
  const center = { x: shape.x + rx, y: shape.y + ry };
  const local = { x: point.x - center.x, y: point.y - center.y };
  const normalizedDistance = Math.hypot(local.x / rx, local.y / ry);
  const angle = Math.atan2(local.y / ry, local.x / rx);
  const insideSweep = angleInSweep(
    angle,
    shape.props.startAngle,
    shape.props.endAngle,
  );

  if (shape.props.kind === "sector") {
    const start = getArcEndpoint(shape, shape.props.startAngle);
    const end = getArcEndpoint(shape, shape.props.endAngle);
    if (Math.hypot(local.x, local.y) <= tolerance) {
      return true;
    }
    if (
      distanceToSegment(point, center, start) <= tolerance ||
      distanceToSegment(point, center, end) <= tolerance
    ) {
      return true;
    }
    if (
      shape.props.fill === "solid" &&
      normalizedDistance <= 1 + tolerance / Math.max(rx, ry) &&
      insideSweep
    ) {
      return true;
    }
  }

  if (Math.abs(normalizedDistance - 1) * Math.max(rx, ry) > tolerance) {
    return false;
  }

  return insideSweep;
}

function getArcEndpoint(
  shape: Extract<OverlayShape, { type: "arc" }>,
  angle: number,
): OverlayPoint {
  const { rx, ry } = getArcRadii(shape);
  return {
    x: shape.x + rx + Math.cos(angle) * rx,
    y: shape.y + ry + Math.sin(angle) * ry,
  };
}

function pointInPolygon(
  point: OverlayPoint,
  polygon: OverlayPoint[],
): boolean {
  let inside = false;
  for (
    let index = 0, previousIndex = polygon.length - 1;
    index < polygon.length;
    previousIndex = index, index += 1
  ) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const intersects = ((current.y > point.y) !== (previous.y > point.y)) &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(
  point: OverlayPoint,
  start: OverlayPoint,
  end: OverlayPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + t * dx),
    point.y - (start.y + t * dy),
  );
}
