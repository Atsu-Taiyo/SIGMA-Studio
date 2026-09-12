import type { OverlayPoint, OverlayShape } from "@/features/document";

import { getBlockArrowPolygonPoints } from "./block-arrow-geometry";
import { normalizePositiveAngle } from "./math";
import { getRegularPolygonPoints, normalizeRegularPolygonSides } from "./regular-polygon-geometry";
import { getArcRadii, getShapeRotation } from "./shape-bounds";
import { getShapeRotationPivot } from "./shape-visual-bounds";

/**
 * 図形の輪郭が持つ、線端などを吸着させる意味的な点をページ座標で返す。
 * 外接矩形ではなく実際の頂点・辺中点・円弧端点を使うことで、図形種別に
 * 依存しないスナップ処理を組み立てられるようにする。
 */
export function getShapeSnapPoints(shape: OverlayShape): OverlayPoint[] | null {
  const localPoints = getLocalShapeSnapPoints(shape);
  if (!localPoints) {
    return null;
  }

  let points = localPoints.map((point) => ({ x: shape.x + point.x, y: shape.y + point.y }));
  const pivot = getShapeRotationPivot(shape);
  if (shape.flipX || shape.flipY) {
    points = points.map((point) => ({
      x: shape.flipX ? pivot.x * 2 - point.x : point.x,
      y: shape.flipY ? pivot.y * 2 - point.y : point.y,
    }));
  }
  const rotation = getShapeRotation(shape);
  if (rotation === 0) {
    return points;
  }

  return points.map((point) => rotatePointAround(point, pivot, rotation));
}

function getLocalShapeSnapPoints(shape: OverlayShape): OverlayPoint[] | null {
  if (shape.type === "line") {
    return withSegmentMidpoints(shape.props.points, shape.props.closed);
  }

  if (shape.type === "arrow") {
    return withSegmentMidpoints([shape.props.start, shape.props.end], false);
  }

  if (shape.type === "arc") {
    const { rx, ry } = getArcRadii(shape);
    const center = { x: rx, y: ry };
    const midAngle = shape.props.startAngle
      + normalizePositiveAngle(shape.props.endAngle - shape.props.startAngle) / 2;
    const points = [
      ellipsePoint(center, rx, ry, shape.props.startAngle),
      ellipsePoint(center, rx, ry, midAngle),
      ellipsePoint(center, rx, ry, shape.props.endAngle),
    ];
    return shape.props.kind === "sector" ? [...points, center] : points;
  }

  if (shape.type !== "geo") {
    return null;
  }

  const polygon = getLocalGeoPolygonPoints(shape);
  return polygon ? withSegmentMidpoints(polygon, true) : null;
}

function getLocalGeoPolygonPoints(shape: Extract<OverlayShape, { type: "geo" }>): OverlayPoint[] | null {
  const { w, h } = shape.props;
  switch (shape.props.geo) {
    case "triangle":
      return [
        { x: Math.min(w, Math.max(0, shape.props.apexX ?? w / 2)), y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
    case "diamond":
      return [
        { x: w / 2, y: 0 },
        { x: w, y: h / 2 },
        { x: w / 2, y: h },
        { x: 0, y: h / 2 },
      ];
    case "pentagon":
      return getRegularPolygonPoints(w, h, 5);
    case "regularPolygon":
      return getRegularPolygonPoints(w, h, normalizeRegularPolygonSides(shape.props.polygonSides));
    case "blockArrow":
      return getBlockArrowPolygonPoints(w, h, shape.props.headLengthRatio, shape.props.shaftRatio);
    default:
      return null;
  }
}

function withSegmentMidpoints(points: OverlayPoint[], closed: boolean): OverlayPoint[] {
  const result = [...points];
  const segmentCount = closed && points.length >= 3 ? points.length : Math.max(0, points.length - 1);
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    result.push({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  }
  return result;
}

function ellipsePoint(center: OverlayPoint, rx: number, ry: number, angle: number): OverlayPoint {
  return {
    x: center.x + Math.cos(angle) * rx,
    y: center.y + Math.sin(angle) * ry,
  };
}

function rotatePointAround(point: OverlayPoint, center: OverlayPoint, rotation: number): OverlayPoint {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}
