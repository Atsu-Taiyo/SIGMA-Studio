import type { OverlayPoint } from "@/features/document";

import type { InsertTool } from "./interaction-mode";

const CURVE_POINT_MIN_DISTANCE = 2;
const POLYLINE_CLOSE_HIT_RADIUS = 10;

export function appendCurveDrawingPoint(
  points: OverlayPoint[],
  point: OverlayPoint,
): OverlayPoint[] {
  const previous = points[points.length - 1];
  if (
    previous &&
    Math.hypot(point.x - previous.x, point.y - previous.y) < CURVE_POINT_MIN_DISTANCE
  ) {
    return points;
  }

  return [...points, point];
}

export function getCurveDrawingPreviewPoints(
  points: OverlayPoint[],
  current: OverlayPoint,
  closed = false,
): OverlayPoint[] | null {
  if (points.length === 0) {
    return null;
  }

  if (closed) {
    return points;
  }

  const previous = points[points.length - 1];
  if (
    !previous ||
    Math.hypot(current.x - previous.x, current.y - previous.y) < CURVE_POINT_MIN_DISTANCE
  ) {
    return points.length === 1 ? [points[0], current] : points;
  }

  return [...points, current];
}

export function shouldClosePolylineDrawing(
  tool: InsertTool,
  points: OverlayPoint[],
  point: OverlayPoint,
): boolean {
  if (tool.command !== "polyline" || points.length < 3) {
    return false;
  }

  const first = points[0];
  return Math.hypot(point.x - first.x, point.y - first.y) <= POLYLINE_CLOSE_HIT_RADIUS;
}

/**
 * What the author is in the middle of, as far as the on-screen hint is concerned.
 *
 * Derived from the interaction mode rather than stored: a click-to-place tool has exactly two
 * states, and giving the hint its own state would mean a `setState` per pointer move.
 */
export type CurveDrawingPhase =
  | { kind: "armed"; command: ClickPointDrawingCommand }
  | { kind: "drawing"; command: ClickPointDrawingCommand; pointCount: number; canClose: boolean };

export type ClickPointDrawingCommand = "curve" | "polyline" | "threePointArc";

/**
 * The line shown at the bottom of the screen while a click-to-place tool is active.
 *
 * These tools have no visible affordance of their own — the keys that finish, undo one point and
 * cancel were reachable but written down nowhere. One sentence, always the next thing to do.
 *
 * **文字列ではなく記述子を返す。** `features/drawing` は architecture test により
 * `@/lib/*` を一切 import できず (`architecture.test.ts` の依存境界)、翻訳関数を
 * 引数で受け取ることすらしない層なので、「何を言いたいか」だけを返して
 * 文言の解決は UI 層 (`shape.drawingHint.*`) に任せる。
 */
export type CurveDrawingHint =
  | { id: "clickRemaining"; values: { remaining: number } }
  | { id: "armed" }
  | { id: "canClose" }
  | { id: "addPoint" }
  | { id: "addPointOrFinish" };

export function getCurveDrawingHint(phase: CurveDrawingPhase): CurveDrawingHint {
  if (phase.command === "threePointArc") {
    const placed = phase.kind === "drawing" ? phase.pointCount : 0;
    const remaining = Math.max(1, THREE_POINT_ARC_POINTS - placed);
    return { id: "clickRemaining", values: { remaining } };
  }

  if (phase.kind === "armed") {
    return { id: "armed" };
  }

  if (phase.canClose) {
    return { id: "canClose" };
  }

  if (phase.pointCount <= 1) {
    return { id: "addPoint" };
  }

  return { id: "addPointOrFinish" };
}

const THREE_POINT_ARC_POINTS = 3;

export function removeNearDuplicateDrawingPoints(
  points: OverlayPoint[],
  minDistance: number,
): OverlayPoint[] {
  const next: OverlayPoint[] = [];
  for (const point of points) {
    const previous = next[next.length - 1];
    if (
      !previous ||
      Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance
    ) {
      next.push(point);
    }
  }

  return next;
}
