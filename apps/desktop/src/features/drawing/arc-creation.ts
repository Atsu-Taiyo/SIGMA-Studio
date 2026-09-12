import type {
  OverlayArcShape,
  OverlayArrowhead,
  OverlayDash,
  OverlayPoint,
  OverlayShapeId,
  OverlayTextSize,
} from "@/features/document";

import { angleFromCenter, normalizePositiveAngle } from "./math";
import { MIN_ARC_RADIUS } from "./shape-bounds";

const COLLINEAR_EPSILON = 0.01;

export interface ArcShapeStyle {
  color?: string;
  strokeOpacity?: number;
  fill?: "none" | "solid";
  fillColor?: string;
  fillOpacity?: number;
  dash?: OverlayDash;
  size?: OverlayTextSize;
  arrowheadStart?: OverlayArrowhead;
  arrowheadEnd?: OverlayArrowhead;
}

export type CenterDragArcKind = "arc" | "sector";

export function createArcShapeFromThreePoints(
  id: OverlayShapeId,
  start: OverlayPoint,
  through: OverlayPoint,
  end: OverlayPoint,
  style: ArcShapeStyle = {},
): OverlayArcShape | null {
  const circle = getCircleFromThreePoints(start, through, end);
  if (!circle) {
    return null;
  }

  const startAngle = angleFromCenter(circle.center, start);
  const throughAngle = angleFromCenter(circle.center, through);
  const endAngle = angleFromCenter(circle.center, end);
  const useForwardSweep = angleInPositiveSweep(throughAngle, startAngle, endAngle);
  const r = Math.max(MIN_ARC_RADIUS, circle.r);

  return {
    id,
    type: "arc",
    x: circle.center.x - r,
    y: circle.center.y - r,
    rotation: 0,
    props: {
      r,
      startAngle: useForwardSweep ? startAngle : endAngle,
      endAngle: useForwardSweep ? endAngle : startAngle,
      kind: "arc",
      arrowheadStart: style.arrowheadStart,
      arrowheadEnd: style.arrowheadEnd,
      color: style.color ?? "black",
      strokeOpacity: style.strokeOpacity,
      dash: style.dash ?? "solid",
      size: style.size ?? "m",
    },
  };
}

export function createArcShapeFromCenterDrag(
  id: OverlayShapeId,
  center: OverlayPoint,
  radiusPoint: OverlayPoint,
  kind: CenterDragArcKind,
  style: ArcShapeStyle = {},
): OverlayArcShape {
  const dx = radiusPoint.x - center.x;
  const dy = radiusPoint.y - center.y;
  const rawRx = Math.abs(dx);
  const rawRy = Math.abs(dy);
  const circularDrag = rawRx < MIN_ARC_RADIUS || rawRy < MIN_ARC_RADIUS;
  const circleRadius = Math.max(MIN_ARC_RADIUS, Math.hypot(dx, dy));
  const rx = circularDrag ? circleRadius : Math.max(MIN_ARC_RADIUS, rawRx);
  const ry = circularDrag ? circleRadius : Math.max(MIN_ARC_RADIUS, rawRy);
  const r = Math.max(rx, ry);
  const angle = Math.atan2(dy, dx);
  const sweep = Math.PI / 2;

  return {
    id,
    type: "arc",
    x: center.x - rx,
    y: center.y - ry,
    rotation: 0,
    props: {
      kind,
      r,
      rx,
      ry,
      startAngle: angle - sweep / 2,
      endAngle: angle + sweep / 2,
      arrowheadStart: kind === "arc" ? style.arrowheadStart : undefined,
      arrowheadEnd: kind === "arc" ? style.arrowheadEnd : undefined,
      fill: kind === "sector" ? style.fill ?? "solid" : style.fill,
      fillColor: kind === "sector" ? style.fillColor ?? "#e5e7eb" : style.fillColor,
      fillOpacity: kind === "sector" ? style.fillOpacity ?? 0.35 : style.fillOpacity,
      color: style.color ?? "black",
      strokeOpacity: style.strokeOpacity,
      dash: style.dash ?? "solid",
      size: style.size ?? "m",
    },
  };
}

function getCircleFromThreePoints(
  a: OverlayPoint,
  b: OverlayPoint,
  c: OverlayPoint,
): { center: OverlayPoint; r: number } | null {
  const determinant = 2 * (
    a.x * (b.y - c.y) +
    b.x * (c.y - a.y) +
    c.x * (a.y - b.y)
  );

  if (Math.abs(determinant) < COLLINEAR_EPSILON) {
    return null;
  }

  const aSq = a.x * a.x + a.y * a.y;
  const bSq = b.x * b.x + b.y * b.y;
  const cSq = c.x * c.x + c.y * c.y;
  const center = {
    x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / determinant,
    y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / determinant,
  };
  const r = Math.hypot(a.x - center.x, a.y - center.y);

  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(r) || r < MIN_ARC_RADIUS) {
    return null;
  }

  return { center, r };
}

function angleInPositiveSweep(angle: number, start: number, end: number): boolean {
  const sweep = normalizePositiveAngle(end - start);
  const delta = normalizePositiveAngle(angle - start);
  return delta <= sweep + 1e-6;
}
