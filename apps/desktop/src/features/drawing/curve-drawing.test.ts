import { describe, expect, it } from "vitest";

import type { OverlayPoint } from "@/features/document";

import {
  appendCurveDrawingPoint,
  getCurveDrawingHint,
  getCurveDrawingPreviewPoints,
  removeNearDuplicateDrawingPoints,
  shouldClosePolylineDrawing,
} from "./curve-drawing";

describe("curve drawing", () => {
  it("keeps the existing point array when the next point is less than two units away", () => {
    const points = [{ x: 10, y: 20 }];

    expect(appendCurveDrawingPoint(points, { x: 11.99, y: 20 })).toBe(points);
    expect(appendCurveDrawingPoint(points, { x: 12, y: 20 })).toEqual([
      points[0],
      { x: 12, y: 20 },
    ]);
  });

  it("builds a stable preview for empty, near, distant, and closed drawings", () => {
    const first = { x: 0, y: 0 };
    const second = { x: 5, y: 0 };
    const points = [first, second];

    expect(getCurveDrawingPreviewPoints([], first)).toBeNull();
    expect(getCurveDrawingPreviewPoints([first], { x: 1, y: 0 })).toEqual([
      first,
      { x: 1, y: 0 },
    ]);
    expect(getCurveDrawingPreviewPoints(points, { x: 6, y: 0 })).toBe(points);
    expect(getCurveDrawingPreviewPoints(points, { x: 7, y: 0 })).toEqual([
      ...points,
      { x: 7, y: 0 },
    ]);
    expect(getCurveDrawingPreviewPoints(points, { x: 30, y: 30 }, true)).toBe(points);
  });

  it("closes only a polyline with at least three points inside the hit radius", () => {
    const points = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
    ];

    expect(shouldClosePolylineDrawing({ kind: "insert", command: "curve" }, points, points[0]))
      .toBe(false);
    expect(
      shouldClosePolylineDrawing(
        { kind: "insert", command: "polyline" },
        points.slice(0, 2),
        points[0],
      ),
    ).toBe(false);
    expect(
      shouldClosePolylineDrawing(
        { kind: "insert", command: "polyline" },
        points,
        { x: 20, y: 10 },
      ),
    ).toBe(true);
    expect(
      shouldClosePolylineDrawing(
        { kind: "insert", command: "polyline" },
        points,
        { x: 20.01, y: 10 },
      ),
    ).toBe(false);
  });

  it("removes only consecutive points nearer than the requested distance", () => {
    const points: OverlayPoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 0 },
    ];

    expect(removeNearDuplicateDrawingPoints(points, 2)).toEqual([
      points[0],
      points[2],
      points[3],
    ]);
  });
});

describe("getCurveDrawingHint", () => {
  it("tells the author how to start before the first click", () => {
    expect(getCurveDrawingHint({ kind: "armed", command: "curve" })).toEqual({ id: "armed" });
  });

  it("does not offer to finish a curve that has only one point", () => {
    expect(getCurveDrawingHint({ kind: "drawing", command: "curve", pointCount: 1, canClose: false }))
      .toEqual({ id: "addPoint" });
  });

  it("names every way out once finishing is possible", () => {
    expect(getCurveDrawingHint({ kind: "drawing", command: "curve", pointCount: 3, canClose: false }))
      .toEqual({ id: "addPointOrFinish" });
  });

  it("says what a click on the first vertex will do", () => {
    // この判定は 10px の不可視の当たり判定で、案内が無いと存在に気づけない。
    expect(getCurveDrawingHint({ kind: "drawing", command: "polyline", pointCount: 3, canClose: true }))
      .toEqual({ id: "canClose" });
  });

  it("counts down the remaining clicks for a three-point arc", () => {
    expect(getCurveDrawingHint({ kind: "armed", command: "threePointArc" }))
      .toEqual({ id: "clickRemaining", values: { remaining: 3 } });
    expect(getCurveDrawingHint({ kind: "drawing", command: "threePointArc", pointCount: 1, canClose: false }))
      .toEqual({ id: "clickRemaining", values: { remaining: 2 } });
    expect(getCurveDrawingHint({ kind: "drawing", command: "threePointArc", pointCount: 2, canClose: false }))
      .toEqual({ id: "clickRemaining", values: { remaining: 1 } });
  });

  it("returns a descriptor for every phase, never a sentence", () => {
    // **文字列を返してはいけない。** `features/drawing` は `@/lib/*` を import できず
    // (architecture test の依存境界)、翻訳関数も受け取れない層なので、文言を持った
    // 時点で表示言語を選べなくなる。
    const phases = [
      { kind: "armed", command: "curve" },
      { kind: "armed", command: "polyline" },
      { kind: "armed", command: "threePointArc" },
      { kind: "drawing", command: "curve", pointCount: 2, canClose: false },
      { kind: "drawing", command: "polyline", pointCount: 3, canClose: true },
      { kind: "drawing", command: "threePointArc", pointCount: 2, canClose: false },
    ] as const;

    for (const phase of phases) {
      const hint = getCurveDrawingHint(phase);
      expect(typeof hint).toBe("object");
      expect(hint.id).toMatch(/^[a-zA-Z]+$/u);
    }
  });
});
