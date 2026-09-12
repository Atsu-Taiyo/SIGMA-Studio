import { describe, expect, it } from "vitest";

import type { OverlayPoint } from "@/features/document";

import {
  canRemoveLinePointAt,
  getLineInsertHandlePoints,
  getLineSvgPath,
  insertLinePointAt,
  removeLinePointAt,
} from "./line-geometry";

/**
 * Adding and removing control points after a line is drawn.
 *
 * The rules that matter are all about what must *not* happen: `points[0]` is the shape's origin
 * (`shape.x/y` are stored relative to it), a closed polygon needs three points to stay a polygon,
 * and a midpoint handle that lands under a vertex handle is worse than no handle at all.
 */

const OPEN_THREE: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }];

describe("getLineInsertHandlePoints", () => {
  it("offers one handle per segment, and never at the origin", () => {
    const handles = getLineInsertHandlePoints(OPEN_THREE, "polyline", false);

    expect(handles.map((handle) => handle.index)).toEqual([1, 2]);
    expect(handles[0].point).toEqual({ x: 50, y: 0 });
    expect(handles[1].point).toEqual({ x: 100, y: 40 });
  });

  it("includes the closing edge of a closed polygon", () => {
    const handles = getLineInsertHandlePoints(OPEN_THREE, "polyline", true);

    // The closing edge's new point belongs after the last one.
    expect(handles.map((handle) => handle.index)).toEqual([1, 2, 3]);
    expect(handles[2].point).toEqual({ x: 50, y: 40 });
  });

  it("puts a curve's interior handle exactly on the drawn join", () => {
    // `getLineSvgPath` joins consecutive quadratics at the midpoint of the control polygon, so an
    // interior handle really is on the ink.
    const points: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 60, y: -60 }, { x: 120, y: 0 }, { x: 180, y: -60 }];
    const handles = getLineInsertHandlePoints(points, "curve", false);

    expect(handles.map((handle) => handle.index)).toEqual([1, 2, 3]);
    expect(getLineSvgPath(points, "curve")).toContain("Q 60 -60 90 -30");
    expect(handles[1].point).toEqual({ x: 90, y: -30 });
  });

  it("keeps the end handles on the control polygon, where the curve bows away from them", () => {
    // 端のセグメントだけは曲線が中点から離れる。ハンドルは制御点の中点に置くという規約なので、
    // ここは「曲線上にある」と言ってはいけない。
    const points: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 60, y: -60 }, { x: 120, y: 0 }, { x: 180, y: -60 }];
    const handles = getLineInsertHandlePoints(points, "curve", false);

    expect(handles[0].point).toEqual({ x: 30, y: -30 });
    expect(handles[2].point).toEqual({ x: 150, y: -30 });
    // The path starts at the first point and its first join is the *second* midpoint.
    expect(getLineSvgPath(points, "curve")).not.toContain("30 -30");
  });

  it("skips a segment too short to hold a handle of its own", () => {
    // 頂点ハンドルは ±10px、この中点ハンドルは ±9px の当たり判定を持ち、頂点の方が上に描かれる。
    // 短いセグメントに中点を出すと頂点に覆われて、どちらも狙って掴めなくなる。
    const cramped: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 200, y: 0 }];

    expect(getLineInsertHandlePoints(cramped, "polyline", false).map((handle) => handle.index)).toEqual([2]);
  });

  it("pins the threshold on both sides", () => {
    // 値そのものを固定する。これが無いと 8px と 192px しか試していないテストになり、
    // どんな閾値でも通ってしまう。
    const justUnder: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 39.9, y: 0 }];
    const justOver: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 40.1, y: 0 }];

    expect(getLineInsertHandlePoints(justUnder, "polyline", false)).toEqual([]);
    expect(getLineInsertHandlePoints(justOver, "polyline", false)).toHaveLength(1);
  });

  it("offers nothing where the midpoint would overflow", () => {
    // 検証は有限性しか見ないので、巨大だが有限の座標は文書に入りうる。その中点は Infinity になり、
    // 保存時に null になって、その教材は二度と開けなくなる。
    const enormous: OverlayPoint[] = [{ x: 1e308, y: 0 }, { x: 1.5e308, y: 0 }];

    expect(getLineInsertHandlePoints(enormous, "polyline", false)).toEqual([]);
  });

  it("offers nothing for a freehand line or a degenerate one", () => {
    expect(getLineInsertHandlePoints(OPEN_THREE, "freehand", false)).toEqual([]);
    expect(getLineInsertHandlePoints([{ x: 0, y: 0 }], "polyline", false)).toEqual([]);
    expect(getLineInsertHandlePoints([], "curve", false)).toEqual([]);
  });
});

describe("insertLinePointAt", () => {
  it("adds the point without moving the origin", () => {
    const next = insertLinePointAt(OPEN_THREE, 1, { x: 50, y: 0 });

    expect(next).toHaveLength(4);
    expect(next[0]).toEqual(OPEN_THREE[0]);
    expect(next[1]).toEqual({ x: 50, y: 0 });
  });

  it("refuses to take over index 0 even when asked", () => {
    const next = insertLinePointAt(OPEN_THREE, 0, { x: -50, y: -50 });

    expect(next[0]).toEqual(OPEN_THREE[0]);
    expect(next[1]).toEqual({ x: -50, y: -50 });
  });

  it("appends when the index is past the end", () => {
    expect(insertLinePointAt(OPEN_THREE, 99, { x: 1, y: 1 })).toHaveLength(4);
    expect(insertLinePointAt(OPEN_THREE, 99, { x: 1, y: 1 })[3]).toEqual({ x: 1, y: 1 });
  });

  it("leaves the source array alone", () => {
    const source = [...OPEN_THREE];
    const next = insertLinePointAt(source, 1, { x: 50, y: 0 });

    expect(source).toHaveLength(3);
    expect(next).not.toBe(source);
  });
});

describe("canRemoveLinePointAt", () => {
  it("never removes the origin", () => {
    expect(canRemoveLinePointAt(OPEN_THREE, 0, false)).toBe(false);
    expect(canRemoveLinePointAt([...OPEN_THREE, { x: 0, y: 80 }], 0, true)).toBe(false);
  });

  it("keeps an open line at two points or more", () => {
    const two: OverlayPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

    expect(canRemoveLinePointAt(two, 1, false)).toBe(false);
    expect(canRemoveLinePointAt(OPEN_THREE, 1, false)).toBe(true);
    expect(removeLinePointAt(OPEN_THREE, 1)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 80 }]);
  });

  it("keeps a closed polygon at three points or more", () => {
    const square: OverlayPoint[] = [...OPEN_THREE, { x: 0, y: 80 }];

    expect(canRemoveLinePointAt(OPEN_THREE, 1, true)).toBe(false);
    expect(canRemoveLinePointAt(square, 1, true)).toBe(true);
  });

  it("rejects an index that is not a point", () => {
    expect(canRemoveLinePointAt(OPEN_THREE, 3, false)).toBe(false);
    expect(canRemoveLinePointAt(OPEN_THREE, -1, false)).toBe(false);
  });
});

describe("removeLinePointAt", () => {
  it("leaves the source array alone", () => {
    const source = [...OPEN_THREE];
    const next = removeLinePointAt(source, 1);

    expect(source).toHaveLength(3);
    expect(next).toHaveLength(2);
  });
});
