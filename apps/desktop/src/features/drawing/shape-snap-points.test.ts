import { describe, expect, it } from "vitest";

import { getShapeSnapPoints } from "./shape-snap-points";
import type { OverlayArcShape, OverlayGeoShape } from "@/features/document";

function geo(overrides: Partial<OverlayGeoShape["props"]> = {}): OverlayGeoShape {
  return {
    id: "geo",
    type: "geo",
    x: 10,
    y: 20,
    props: {
      w: 120,
      h: 120,
      geo: "regularPolygon",
      polygonSides: 12,
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
      ...overrides,
    },
  };
}

describe("getShapeSnapPoints", () => {
  it("returns every vertex and edge midpoint of a 12-sided polygon", () => {
    const points = getShapeSnapPoints(geo());

    expect(points).toHaveLength(24);
    expect(points?.[0]).toEqual({ x: 70, y: 20 });
    expect(points?.[12]).toEqual({
      x: (points![0].x + points![1].x) / 2,
      y: (points![0].y + points![1].y) / 2,
    });
  });

  it("returns the three vertices and three edge midpoints of a triangle", () => {
    const points = getShapeSnapPoints(geo({ geo: "triangle", w: 100, h: 80, apexX: 25 }));

    expect(points).toEqual([
      { x: 35, y: 20 },
      { x: 110, y: 100 },
      { x: 10, y: 100 },
      { x: 72.5, y: 60 },
      { x: 60, y: 100 },
      { x: 22.5, y: 60 },
    ]);
  });

  it("returns arc endpoints and the midpoint on the arc", () => {
    const arc: OverlayArcShape = {
      id: "arc",
      type: "arc",
      x: 100,
      y: 50,
      props: {
        r: 40,
        rx: 40,
        ry: 20,
        startAngle: 0,
        endAngle: Math.PI,
        kind: "arc",
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(getShapeSnapPoints(arc)).toEqual([
      { x: 180, y: 70 },
      { x: 140, y: 90 },
      { x: 100, y: 70 },
    ]);
  });

  it("rotates semantic snap points with the shape", () => {
    const shape = { ...geo({ geo: "triangle", w: 100, h: 100 }), rotation: Math.PI / 2 };
    const points = getShapeSnapPoints(shape);

    expect(points?.[0].x).toBeCloseTo(110);
    expect(points?.[0].y).toBeCloseTo(70);
  });

  it("mirrors semantic snap points with the shape", () => {
    const shape = { ...geo({ geo: "triangle", w: 100, h: 80, apexX: 25 }), flipX: true };
    const points = getShapeSnapPoints(shape);

    expect(points?.[0]).toEqual({ x: 85, y: 20 });
    expect(points?.[1]).toEqual({ x: 10, y: 100 });
    expect(points?.[2]).toEqual({ x: 110, y: 100 });
  });

  it("rotates an arc's snap points around the centre of what it draws", () => {
    // 未回転の弧の始点は (200,150)。pivot は実描画の中心 (175,175) なので 90° 回すと
    // (200,200) に来る。保存箱の中心 (150,150) を軸にしていた頃は (150,200) だった。
    const rotated: OverlayArcShape = {
      id: "arc",
      type: "arc",
      x: 100,
      y: 100,
      rotation: Math.PI / 2,
      props: {
        r: 50,
        startAngle: 0,
        endAngle: Math.PI / 2,
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    const points = getShapeSnapPoints(rotated);

    expect(points?.[0].x).toBeCloseTo(200, 9);
    expect(points?.[0].y).toBeCloseTo(200, 9);
  });
});
