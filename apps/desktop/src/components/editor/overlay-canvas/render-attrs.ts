import { arrowheadMarkerId } from "@/features/rendering/core";
import { getArcDrawnAngles, getArcMidAngle, getArcRadii } from "@/features/drawing";

import { clamp, normalizePositiveAngle } from "./math";
import { getBlockArrowPolygonPoints } from "./shapes/block-arrow";
import { getRegularPolygonPoints, normalizeRegularPolygonSides } from "./shapes/regular-polygon";
import type { OverlayArrowhead, OverlayDash, OverlayPoint, OverlayRegularPolygonSides, OverlayShape, OverlayShapeId } from "./types";

export {
  overlayLabelFontSize,
  overlayStrokeWidth,
} from "@/features/rendering/core";

export function dashToStrokeDasharray(dash: OverlayDash): string | undefined {
  if (dash === "dashed") {
    return "8 6";
  }
  if (dash === "dotted") {
    return "1 6";
  }
  return undefined;
}

export function getGeoPolygonPoints(
  geo: "triangle" | "diamond" | "pentagon" | "regularPolygon" | "blockArrow",
  width: number,
  height: number,
  apexX?: number,
  headLengthRatio?: number,
  shaftRatio?: number,
  polygonSides?: OverlayRegularPolygonSides,
): string {
  if (geo === "blockArrow") {
    return getBlockArrowPolygonPoints(width, height, headLengthRatio, shaftRatio, 1)
      .map((point) => `${point.x},${point.y}`)
      .join(" ");
  }

  if (geo === "triangle") {
    return `${clamp(apexX ?? width / 2, 1, Math.max(1, width - 1))},1 ${Math.max(1, width - 1)},${Math.max(1, height - 1)} 1,${Math.max(1, height - 1)}`;
  }

  if (geo === "diamond") {
    return `${width / 2},1 ${Math.max(1, width - 1)},${height / 2} ${width / 2},${Math.max(1, height - 1)} 1,${height / 2}`;
  }

  return getRegularPolygonPoints(
    width,
    height,
    geo === "pentagon" ? 5 : normalizeRegularPolygonSides(polygonSides),
    1,
  ).map((point) => `${point.x},${point.y}`).join(" ");
}

/**
 * Where an arc's stored endpoint is, in shape-local coordinates.
 *
 * Deliberately the stored angle and never the drawn one: the angle handles and the radius handle
 * are positioned from this, and an arc trimmed for its arrow head would leave them floating off
 * the end of the ink the author is dragging.
 */
export function getArcEndpoint(shape: Extract<OverlayShape, { type: "arc" }>, endpoint: "start" | "end"): OverlayPoint {
  const angle = endpoint === "start" ? shape.props.startAngle : shape.props.endAngle;
  return getArcPointAtAngle(shape, angle);
}

export function getArcPointAtAngle(shape: Extract<OverlayShape, { type: "arc" }>, angle: number): OverlayPoint {
  const { rx, ry } = getArcRadii(shape);
  return {
    x: rx + Math.cos(angle) * rx,
    y: ry + Math.sin(angle) * ry,
  };
}

/** 半径ハンドルの表示位置(弧の中間角上の弧上の点)。shape ローカル座標。 */
export function getArcRadiusHandlePoint(shape: Extract<OverlayShape, { type: "arc" }>): OverlayPoint {
  const { rx, ry } = getArcRadii(shape);
  const angle = getArcMidAngle(shape);
  return {
    x: rx + Math.cos(angle) * rx,
    y: ry + Math.sin(angle) * ry,
  };
}

export function getArcPath(shape: Extract<OverlayShape, { type: "arc" }>): string {
  const { rx, ry } = getArcRadii(shape);
  // The drawn angles, not the stored ones: an arc that carries an arrow head stops short so the
  // head's point can sit on the stored endpoint. A sector gets its stored angles back unchanged.
  const drawn = getArcDrawnAngles(shape);
  const start = getArcPointAtAngle(shape, drawn.startAngle);
  const end = getArcPointAtAngle(shape, drawn.endAngle);
  const sweep = normalizePositiveAngle(drawn.endAngle - drawn.startAngle);
  const largeArcFlag = sweep > Math.PI ? 1 : 0;
  if (shape.props.kind === "sector") {
    return `M ${rx} ${ry} L ${start.x} ${start.y} A ${rx} ${ry} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
  }
  return `M ${start.x} ${start.y} A ${rx} ${ry} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

export function getArcFill(shape: Extract<OverlayShape, { type: "arc" }>): string {
  if (shape.props.kind !== "sector" || shape.props.fill === "none") {
    return "none";
  }
  return shape.props.fillColor ?? shape.props.color;
}

export function markerUrl(shapeId: OverlayShapeId, endpoint: "start" | "end", head: OverlayArrowhead | undefined): string | undefined {
  const id = arrowheadMarkerId(head, shapeId, endpoint);
  return id ? `url(#${id})` : undefined;
}

export function applyShapeOpacity<T extends OverlayShape>(shape: T, opacity: number | undefined): T {
  const nextOpacity = opacity === undefined ? shape.opacity : opacity;
  return {
    ...shape,
    opacity: nextOpacity === undefined || nextOpacity >= 1 ? undefined : nextOpacity,
  } as T;
}
