import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/features/document";

import {
  getShapeCenter,
  getShapesSelectionBounds,
} from "./shape-bounds";
import { getShapeRotationPivot } from "./shape-visual-bounds";
import {
  alignShapes,
  distributeShapes,
  fitShapesWithinPage,
  flipShapesAround,
  resizeRotatedShapeToBounds,
  resizeShapesToBounds,
  rotateShapesAround,
} from "./shape-arrangement";
import type { OverlayAlignAction } from "./shape-arrangement";

function rect(id: string, x: number, y: number, w: number, h: number, rotation = 0): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    rotation,
    props: {
      w,
      h,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

const HALF_PI = Math.PI / 2;

/** 3 点円弧は「中心 − r」を x/y に保存する。参照箱は円全体 100x100、描かれるのは 50x50。 */
function arc(): OverlayShape {
  return {
    id: "arc",
    type: "arc",
    x: 100,
    y: 100,
    props: {
      r: 50,
      startAngle: 0,
      endAngle: HALF_PI,
      color: "#111111",
      dash: "solid",
      size: "m",
    },
  };
}

function line(id: string, x: number, y: number, points: { x: number; y: number }[]): OverlayShape {
  return {
    id,
    type: "line",
    x,
    y,
    rotation: 0,
    props: {
      points,
      closed: false,
      color: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function arrow(
  id: string,
  x: number,
  y: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
): OverlayShape {
  return {
    id,
    type: "arrow",
    x,
    y,
    rotation: 0,
    props: {
      start,
      end,
      arrowheadEnd: "arrow",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function text(id: string, x: number, y: number, w: number, h: number): OverlayShape {
  return {
    id,
    type: "text",
    x,
    y,
    rotation: 0,
    props: {
      w,
      h,
      blocks: [
          {
            type: "paragraph", id: "shape_arrangement_test_5",
            children: [{ type: "text", text: "label" }],
          },
        ],
      color: "black",
      size: "m",
    },
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("shape arrangement", () => {
  it("unions shape selection bounds", () => {
    expect(getShapesSelectionBounds([
      rect("a", 10, 20, 30, 40),
      line("b", 100, 50, [{ x: 0, y: 0 }, { x: 40, y: 10 }]),
    ])).toEqual({
      x: 10,
      y: 20,
      w: 140,
      h: 50,
    });
    expect(getShapesSelectionBounds([])).toBeNull();
  });

  it("scales point-shape absolute points and keeps local points valid", () => {
    const [resized] = resizeShapesToBounds(
      [line("line", 20, 30, [{ x: 0, y: 0 }, { x: 20, y: 10 }])],
      { x: 10, y: 20, w: 40, h: 20 },
      { x: 110, y: 220, w: 80, h: 40 },
    );

    expect(resized).toMatchObject({
      x: 130,
      y: 240,
      props: {
        points: [{ x: 0, y: 0 }, { x: 40, y: 20 }],
      },
    });
  });

  it("keeps the opposite page-space edge fixed when resizing a rotated shape", () => {
    const resized = resizeRotatedShapeToBounds(
      rect("rotated", 100, 100, 100, 60, Math.PI / 2),
      { x: 100, y: 100, w: 100, h: 60 },
      { x: 100, y: 100, w: 140, h: 60 },
      "e",
    );

    expect(resized).toMatchObject({
      x: 80,
      y: 120,
      rotation: Math.PI / 2,
      props: { w: 140, h: 60 },
    });
  });

  it("holds the fixed handle in the frame it was handed, not in the reference box", () => {
    // `fromBounds` が図形の参照箱と別物 (WI-15 の「見えている箱」) のとき、リサイズ後の箱も
    // 同じ frame で測り直さないと固定点の計算が別の矩形の上で行われ、図形が跳ぶ。
    const shape = rect("rotated", 100, 100, 100, 60, Math.PI / 2);
    // 参照箱の右半分。実際の pad と同じく「図形の幾何から線形に決まる箱」なので、
    // 参照箱をアフィン写像すればこの箱も同じ写像で動く。
    const rightHalf = (target: OverlayShape) => {
      const bounds = getShapesSelectionBounds([target]);
      if (!bounds) {
        throw new Error("bounds missing");
      }
      return { x: bounds.x + bounds.w / 2, y: bounds.y, w: bounds.w / 2, h: bounds.h };
    };
    const from = rightHalf(shape);
    const to = { ...from, w: from.w + 40 };

    const resized = resizeRotatedShapeToBounds(shape, from, to, "e", rightHalf);

    const westEdge = (target: OverlayShape, bounds: { x: number; y: number; w: number; h: number }) => {
      const center = getShapeCenter(target);
      const point = { x: bounds.x, y: bounds.y + bounds.h / 2 };
      const rotation = Math.PI / 2;
      return {
        x: center.x + (point.x - center.x) * Math.cos(rotation) - (point.y - center.y) * Math.sin(rotation),
        y: center.y + (point.x - center.x) * Math.sin(rotation) + (point.y - center.y) * Math.cos(rotation),
      };
    };
    const before = westEdge(shape, from);
    const after = westEdge(resized, rightHalf(resized));

    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1e-9);
    expect(rightHalf(resized).w).toBeCloseTo(from.w + 40, 9);
  });

  it("keeps the scale origin fixed after a rotated resize crosses and flips an edge", () => {
    const resized = resizeRotatedShapeToBounds(
      rect("rotated", 100, 100, 100, 60, Math.PI / 2),
      { x: 100, y: 100, w: 100, h: 60 },
      { x: 100, y: 100, w: -40, h: 60 },
      "e",
    );

    expect(resized).toMatchObject({
      x: 130,
      y: 30,
      rotation: Math.PI / 2,
      props: { w: 40, h: 60 },
    });
  });

  it.each([
    ["left", [{ x: 10, y: 20 }, { x: 10, y: 60 }]],
    ["center", [{ x: 25, y: 20 }, { x: 30, y: 60 }]],
    ["right", [{ x: 40, y: 20 }, { x: 50, y: 60 }]],
    ["top", [{ x: 10, y: 20 }, { x: 50, y: 20 }]],
    ["middle", [{ x: 10, y: 50 }, { x: 50, y: 40 }]],
    ["bottom", [{ x: 10, y: 80 }, { x: 50, y: 60 }]],
  ] satisfies [OverlayAlignAction, { x: number; y: number }[]][])("aligns shapes to %s", (action, expected) => {
    const aligned = alignShapes([
      rect("a", 10, 20, 20, 10),
      rect("b", 50, 60, 10, 30),
    ], action);

    expect(aligned.map((shape) => ({ x: shape.x, y: shape.y }))).toEqual(expected);
  });

  it.each([
    ["left", [{ x: 10, y: 10 }, { x: 10, y: 80 }, { x: 10, y: 40 }, { x: 10, y: 50 }]],
    ["center", [{ x: 65, y: 10 }, { x: 60, y: 80 }, { x: 65, y: 40 }, { x: 55, y: 50 }]],
    ["right", [{ x: 120, y: 10 }, { x: 110, y: 80 }, { x: 120, y: 40 }, { x: 100, y: 50 }]],
    ["top", [{ x: 40, y: 10 }, { x: 10, y: 10 }, { x: 120, y: 10 }, { x: 70, y: 10 }]],
    // The mixed-shape "text" fixture (70,50,40,24) keeps its stored 24px height: a text box wraps
    // at the width the user set, and how many lines that takes is the renderer's business — the
    // box only ever floors at the lines the content breaks itself into. Every vertical alignment
    // below is measured against that box.
    ["middle", [{ x: 40, y: 35.5 }, { x: 10, y: 45 }, { x: 120, y: 40.5 }, { x: 70, y: 33.5 }]],
    ["bottom", [{ x: 40, y: 61 }, { x: 10, y: 80 }, { x: 120, y: 71 }, { x: 70, y: 57 }]],
  ] satisfies [OverlayAlignAction, { x: number; y: number }[]][])("aligns mixed shapes to %s by visible bounds", (action, expected) => {
    const aligned = alignShapes([
      rect("box", 40, 10, 20, 20),
      arrow("arrow", 10, 80, { x: 0, y: 0 }, { x: 30, y: 0 }),
      line("line", 120, 40, [{ x: 0, y: 0 }, { x: 20, y: 10 }]),
      text("text", 70, 50, 40, 24),
    ], action);

    expect(aligned.map((shape) => ({ x: shape.x, y: shape.y }))).toEqual(expected);
  });

  it("distributes shapes with equal horizontal and vertical gaps", () => {
    const horizontal = distributeShapes([
      rect("a", 0, 0, 10, 10),
      rect("b", 30, 0, 10, 10),
      rect("c", 100, 0, 20, 10),
    ], "horizontal");
    const vertical = distributeShapes([
      rect("a", 0, 0, 10, 10),
      rect("b", 0, 30, 10, 10),
      rect("c", 0, 100, 10, 20),
    ], "vertical");

    expect(horizontal.map((shape) => shape.x)).toEqual([0, 50, 100]);
    expect(vertical.map((shape) => shape.y)).toEqual([0, 50, 100]);
  });

  it("distributes line and arrow shapes without selection padding", () => {
    const distributed = distributeShapes([
      rect("first", 0, 0, 20, 20),
      arrow("arrow", 50, 0, { x: 0, y: 0 }, { x: 20, y: 0 }),
      line("line", 100, 0, [{ x: 0, y: 0 }, { x: 20, y: 0 }]),
      rect("last", 180, 0, 20, 20),
    ], "horizontal");

    expect(distributed.map((shape) => shape.x)).toEqual([0, 60, 120, 180]);
  });

  it("rotates shapes around a group center while preserving relative distance", () => {
    const center = { x: 0, y: 0 };
    const shapes = [
      rect("a", 5, -5, 10, 10, Math.PI / 6),
      rect("b", -5, 15, 10, 10),
    ];
    const rotated = rotateShapesAround(shapes, center, Math.PI / 2);

    expect(getShapeCenter(rotated[0])).toEqual({ x: 0, y: 10 });
    expect(getShapeCenter(rotated[1])).toEqual({ x: -20, y: 0 });
    expect(rotated[0].rotation).toBeCloseTo((Math.PI * 2) / 3);
    expect(distance(center, getShapeCenter(rotated[0]))).toBeCloseTo(distance(center, getShapeCenter(shapes[0])));
    expect(distance(center, getShapeCenter(rotated[1]))).toBeCloseTo(distance(center, getShapeCenter(shapes[1])));
  });

  it("carries an arc's drawn centre around the group centre, not its stored centre", () => {
    // 弧の pivot は実描画の中心 (175,175)。保存箱の中心 (150,150) を運ぶと、回した後の
    // 弧が本来の位置から 25px ずれる。
    const center = { x: 0, y: 0 };
    const rotated = rotateShapesAround([arc()], center, HALF_PI);

    const pivotBefore = getShapeRotationPivot(arc());
    expect(getShapeRotationPivot(rotated[0]).x).toBeCloseTo(-pivotBefore.y, 9);
    expect(getShapeRotationPivot(rotated[0]).y).toBeCloseTo(pivotBefore.x, 9);
  });

  it("keeps an arc's drawn centre on the page when it is only turned in place", () => {
    const before = getShapeRotationPivot(arc());
    const turned = rotateShapesAround([arc()], before, HALF_PI);

    const after = getShapeRotationPivot(turned[0]);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("mirrors a rotated shape around the selection centre", () => {
    const original = rect("mirrored", 5, -5, 10, 10, Math.PI / 6);
    const [flipped] = flipShapesAround([original], { x: 0, y: 0 }, "horizontal");

    expect(getShapeCenter(flipped)).toEqual({ x: -10, y: 0 });
    expect(flipped.rotation).toBeCloseTo(-Math.PI / 6);
    expect(flipped.flipX).toBe(true);
    expect(flipped.flipY).toBeUndefined();
  });

  it("returns a shape to its original transform after the same flip twice", () => {
    const original = rect("mirrored-twice", 5, 15, 10, 10, Math.PI / 6);
    const once = flipShapesAround([original], { x: 0, y: 0 }, "vertical");
    const [twice] = flipShapesAround(once, { x: 0, y: 0 }, "vertical");

    expect(getShapeCenter(twice)).toEqual(getShapeCenter(original));
    expect(twice.rotation).toBeCloseTo(original.rotation ?? 0);
    expect(twice.flipX).toBeUndefined();
    expect(twice.flipY).toBeUndefined();
  });

  it("keeps empty and already-fitting shape lists by reference", () => {
    const empty: OverlayShape[] = [];
    const fitting = [rect("inside", 10, 20, 30, 40)];

    expect(fitShapesWithinPage(empty, 100, 100)).toBe(empty);
    expect(fitShapesWithinPage(fitting, 100, 100)).toBe(fitting);
  });

  it("moves shapes back from the left and top page edges", () => {
    const fitted = fitShapesWithinPage(
      [
        rect("first", -20, -15, 10, 10),
        rect("second", 20, 25, 20, 20),
      ],
      100,
      100,
    );

    expect(fitted.map((shape) => ({ x: shape.x, y: shape.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 40 },
    ]);
  });

  it("moves shapes back from the right and bottom page edges", () => {
    const fitted = fitShapesWithinPage(
      [
        rect("first", 60, 70, 20, 20),
        rect("second", 90, 95, 20, 10),
      ],
      100,
      100,
    );

    expect(fitted.map((shape) => ({ x: shape.x, y: shape.y }))).toEqual([
      { x: 50, y: 65 },
      { x: 80, y: 90 },
    ]);
  });
});
