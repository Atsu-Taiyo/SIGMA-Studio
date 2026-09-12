import { describe, expect, it } from "vitest";

import type {
  OverlayArcShape,
  OverlayCalloutShape,
  OverlayGraphShape,
  OverlayPoint,
  OverlayShape,
  OverlayTableShape,
  OverlayTextShape,
} from "@/features/document";

import type { ResizeHandle } from "./interaction-mode";
import { getBoundsCenter } from "./math";
import { resizeBounds } from "./resize";
import {
  getSelectionResizeFrame,
  getSelectionRotationPivot,
  getSelectionVisualFrame,
  resizeRotatedShapeToVisualBounds,
  resizeShapesToVisualBounds,
  ZERO_BOUNDS_PADDING,
} from "./resize-frame";
import { resizeShapesToBounds } from "./shape-arrangement";
import { getShapeRotation, getShapesSelectionBounds } from "./shape-bounds";
import { getShapeRotationPivot, getShapeVisualBounds } from "./shape-visual-bounds";

const HALF_PI = Math.PI / 2;

/**
 * 3 点円弧は中心ではなく「中心 - r」を x/y に保存する (`arc-creation.ts`)。既定の 90° 弧では
 * 保存箱 (楕円全体) 100x100 に対し、実際に描かれる弧は 50x50 しかない。
 */
function arc(props: Partial<OverlayArcShape["props"]> = {}): OverlayArcShape {
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
      ...props,
    },
  };
}

function line(): OverlayShape {
  return {
    id: "line",
    type: "line",
    x: 10,
    y: 20,
    props: {
      kind: "polyline",
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      closed: false,
      color: "#111111",
      dash: "solid",
      size: "m",
    },
  } as OverlayShape;
}

/** ラベルは visual 箱にだけ入るので、左右非対称な `padding` を作る唯一の既定図形。 */
function labelledLine(): OverlayShape {
  const shape = line() as OverlayShape & { props: Record<string, unknown> };
  return { ...shape, props: { ...shape.props, labelColor: "#111111", label: "AB" } } as OverlayShape;
}

function rect(id = "rect", x = 40, y = 60, w = 100, h = 80, rotation = 0): OverlayShape {
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

function text(): OverlayTextShape {
  return {
    id: "text",
    type: "text",
    x: 30,
    y: 40,
    props: {
      w: 120,
      h: 16,
      blocks: [{ type: "paragraph", id: "resize_frame_test_9", children: [{ type: "text", text: "説明" }] }],
      color: "black",
      size: "m",
    },
  };
}

function graph(): OverlayGraphShape {
  return {
    id: "graph",
    type: "graph2dShape",
    x: 10,
    y: 20,
    props: {
      w: 360,
      h: 240,
      boundsMode: "plot",
      spec: {
        kind: "cartesian",
        title: "",
        width: 360,
        height: 240,
        viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
        axes: { grid: false },
        curves: [],
      },
    },
  };
}

function table(): OverlayTableShape {
  return {
    id: "table",
    type: "tableShape",
    x: 20,
    y: 30,
    props: {
      w: 240,
      h: 120,
      table: {
        version: 1,
        kind: "plain",
        columns: [],
        rows: [],
        cells: [],
        grid: { borderColor: "#111827", borderWidth: 1 },
        defaultCellStyle: {},
      },
    },
  };
}

function callout(): OverlayCalloutShape {
  return {
    id: "callout",
    type: "callout",
    x: 10,
    y: 20,
    props: {
      w: 160,
      h: 72,
      radius: 18,
      tail: {
        baseStart: { x: 36, y: 72 },
        baseEnd: { x: 68, y: 72 },
        tip: { x: 24, y: 100 },
      },
      blocks: [{ type: "paragraph", id: "resize_frame_test_10", children: [{ type: "text", text: "説明" }] }],
      color: "#111111",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
    },
  };
}

function image(): OverlayShape {
  return {
    id: "image",
    type: "image",
    x: 10,
    y: 20,
    props: { assetId: "asset_1", w: 200, h: 200 },
  } as OverlayShape;
}

/** 実際の編集画面と同じ順序: 見えている箱を掴み、見えている箱を目標にする。 */
function visualResize(
  shapes: OverlayShape[],
  handle: ResizeHandle,
  dx: number,
  dy: number,
  allShapes: OverlayShape[] = shapes,
): OverlayShape[] {
  const frame = getSelectionResizeFrame(shapes, allShapes);
  if (!frame) {
    throw new Error("frame missing");
  }
  return resizeShapesToVisualBounds(shapes, frame, resizeBounds(frame.visual, handle, dx, dy), handle);
}

/** WI-15 以前の経路。保存箱を掴み、保存箱を目標にする。 */
function referenceResize(shapes: OverlayShape[], handle: ResizeHandle, dx: number, dy: number): OverlayShape[] {
  const from = getShapesSelectionBounds(shapes);
  if (!from) {
    throw new Error("bounds missing");
  }
  return resizeShapesToBounds(shapes, from, resizeBounds(from, handle, dx, dy));
}

function rotateAround(point: OverlayPoint, center: OverlayPoint, rotation: number): OverlayPoint {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/** 選択枠は図形が実際に描かれている箱の中心を原点に CSS で回るので、辺も同じ点で回す。 */
function westEdgePagePoint(shape: OverlayShape): OverlayPoint {
  const bounds = getShapeVisualBounds(shape);
  return rotateAround(
    { x: bounds.x, y: bounds.y + bounds.h / 2 },
    getShapeRotationPivot(shape),
    getShapeRotation(shape),
  );
}

const PADDING_FREE_SHAPES: [string, OverlayShape][] = [
  ["geo", rect()],
  ["text", text()],
  ["graph2dShape", graph()],
  ["tableShape", table()],
  ["callout", callout()],
  ["image", image()],
];

const ALL_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

describe("getSelectionVisualFrame", () => {
  it("frames the arc that is drawn, not the ellipse it is stored in", () => {
    const shape = arc();

    // 保存箱は楕円全体 (100x100)、描かれる 90° 弧は 50x50 + 線幅の半分。
    expect(getShapesSelectionBounds([shape])).toEqual({ x: 100, y: 100, w: 100, h: 100 });
    expect(getSelectionVisualFrame([shape], [shape])).toEqual({ x: 149, y: 149, w: 52, h: 52 });
  });

  it("reports the stroke padding that must stay out of the resize mapping", () => {
    const frame = getSelectionResizeFrame([arc()], [arc()]);

    expect(frame?.padding).toEqual({ left: 1, top: 1, right: 1, bottom: 1 });
  });

  it("counts the caption of a labelled line as padding, on the side it is drawn", () => {
    // ラベルは `points[1]` (線の右端) に中央揃えで描かれるので、右と上にだけ張り出す。
    const padding = getSelectionResizeFrame([labelledLine()], [labelledLine()])?.padding;

    expect(padding!.right).toBeGreaterThan(padding!.left);
    expect(padding!.top).toBeGreaterThan(padding!.bottom);
  });

  it("reports the rotation pivot of a single selection, and the frame centre of several", () => {
    const shapes = [arc(), rect()];

    expect(getSelectionRotationPivot([arc()], [arc()])).toEqual(getShapeRotationPivot(arc()));
    expect(getSelectionRotationPivot(shapes, shapes))
      .toEqual(getBoundsCenter(getSelectionVisualFrame(shapes, shapes)!));
    expect(getSelectionRotationPivot([], [])).toBeNull();
  });

  it("leaves shapes that draw their own box on the reference box, with no padding", () => {
    for (const [label, shape] of PADDING_FREE_SHAPES) {
      const frame = getSelectionResizeFrame([shape], [shape]);

      expect(`${label}:${JSON.stringify(frame?.visual)}`)
        .toBe(`${label}:${JSON.stringify(getShapesSelectionBounds([shape]))}`);
      expect(`${label}:${JSON.stringify(frame?.padding)}`)
        .toBe(`${label}:${JSON.stringify(ZERO_BOUNDS_PADDING)}`);
    }
  });
});

describe("resizeShapesToVisualBounds", () => {
  it("stretches the drawn arc by exactly the dragged distance and keeps its west edge", () => {
    const before = arc();
    const visualBefore = getShapeVisualBounds(before);

    const [after] = visualResize([before], "e", 70, 0);
    const visualAfter = getShapeVisualBounds(after);

    expect(visualAfter.w).toBeCloseTo(visualBefore.w + 70, 10);
    expect(visualAfter.h).toBeCloseTo(visualBefore.h, 10);
    expect(Math.abs(visualAfter.x - visualBefore.x)).toBeLessThan(0.01);
  });

  it("keeps the west edge fixed even when arrow heads make the padding large", () => {
    // xl (線幅 5) + arrow (9 stroke) で片側 22.5px。保存箱と見えている箱の差が弧の実寸を超える。
    const before = arc({ size: "xl", arrowheadEnd: "arrow" });
    const visualBefore = getShapeVisualBounds(before);

    const [after] = visualResize([before], "e", 70, 0);
    const visualAfter = getShapeVisualBounds(after);

    expect(visualAfter.w).toBeCloseTo(visualBefore.w + 70, 10);
    expect(Math.abs(visualAfter.x - visualBefore.x)).toBeLessThan(0.01);
  });

  it("needs the padding removed: mapping the padded box directly drags the west edge along", () => {
    // 「パディングを外す」が効いていることの対偶。ここが緑のままだと上の 2 件は
    // pad を外さない実装でも通ってしまう。
    const before = arc({ size: "xl", arrowheadEnd: "arrow" });
    const visualBefore = getShapeVisualBounds(before);
    const frame = getSelectionResizeFrame([before], [before]);
    const padless = { visual: frame!.visual, padding: ZERO_BOUNDS_PADDING };

    const [after] = resizeShapesToVisualBounds(
      [before],
      padless,
      resizeBounds(padless.visual, "e", 70, 0),
      "e",
    );

    expect(Math.abs(getShapeVisualBounds(after).x - visualBefore.x)).toBeGreaterThan(1);
  });

  it("is the reference-box path, operation for operation, for shapes with no padding", () => {
    for (const [label, shape] of PADDING_FREE_SHAPES) {
      for (const handle of ALL_HANDLES) {
        const next = visualResize([shape], handle, 37, -21);
        const reference = referenceResize([shape], handle, 37, -21);

        expect(`${label}/${handle}:${JSON.stringify(next)}`)
          .toBe(`${label}/${handle}:${JSON.stringify(reference)}`);
      }
    }
  });

  it("is the reference-box path for a group of rectangles", () => {
    const shapes = [rect("a", 0, 0, 40, 40), rect("b", 60, 20, 40, 40)];

    expect(JSON.stringify(visualResize(shapes, "se", 50, 30)))
      .toBe(JSON.stringify(referenceResize(shapes, "se", 50, 30)));
  });

  it("keeps the aspect ratio of the box the author sees", () => {
    const shape = arc();
    const frame = getSelectionResizeFrame([shape], [shape])!;
    const visualTo = resizeBounds(frame.visual, "se", 60, 10, { preserveAspect: true });

    const [after] = resizeShapesToVisualBounds([shape], frame, visualTo, "se");
    const visualAfter = getShapeVisualBounds(after);

    expect(visualAfter.w / visualAfter.h).toBeCloseTo(frame.visual.w / frame.visual.h, 6);
  });

  it("keeps the fixed edge when the drag flips the box past it", () => {
    // 線・矢印は点をそのまま写すので鏡像がそのまま表現できる。円弧は「箱 + 角度」なので
    // 鏡像に相当する形を保存できず、反転をまたぐ厳密な一致はモデル上そもそも成立しない
    // (下の退化ケースで有限性だけを固定する)。
    const before = line();
    const visualBefore = getShapeVisualBounds(before);

    const [after] = visualResize([before], "e", -(visualBefore.w + 40), 0);
    const visualAfter = getShapeVisualBounds(after);

    expect(Math.abs(visualAfter.x + visualAfter.w - visualBefore.x)).toBeLessThan(0.01);
    expect(visualAfter.w).toBeCloseTo(40, 6);
  });

  it("keeps the west edge of a labelled line fixed, caption padding and all", () => {
    // ラベル箱は visual にだけ入り ink には入らないので、`padding` に左右非対称な値が乗る。
    // 既存の「pad を写像から外す」経路がそれをそのまま扱えることの確認。
    const before = labelledLine();
    const visualBefore = getShapeVisualBounds(before);

    const [after] = visualResize([before], "e", 70, 0);
    const visualAfter = getShapeVisualBounds(after);

    expect(Math.abs(visualAfter.x - visualBefore.x)).toBeLessThan(0.01);
    expect(visualAfter.w).toBeGreaterThan(visualBefore.w);
  });

  it("stays finite and un-inverted when dragged smaller than its own stroke padding", () => {
    const before = arc({ size: "xl", arrowheadEnd: "arrow" });
    const visualBefore = getShapeVisualBounds(before);

    for (const dx of [-(visualBefore.w - 1), -(visualBefore.w + 40)]) {
      const [after] = visualResize([before], "e", dx, 0);
      const visualAfter = getShapeVisualBounds(after);

      expect(`${dx}:${Number.isFinite(visualAfter.x) && Number.isFinite(visualAfter.w)}`)
        .toBe(`${dx}:true`);
      expect(`${dx}:${visualAfter.w > 0 && visualAfter.h > 0}`).toBe(`${dx}:true`);
      expect(`${dx}:${visualAfter.w <= visualBefore.w}`).toBe(`${dx}:true`);
    }
  });
});

describe("resizeRotatedShapeToVisualBounds", () => {
  it("keeps the opposite edge of the visible frame fixed on the page", () => {
    const before = { ...arc(), rotation: Math.PI / 6 } as OverlayArcShape;
    const frame = getSelectionResizeFrame([before], [before])!;
    const beforeFixedPoint = westEdgePagePoint(before);

    const after = resizeRotatedShapeToVisualBounds(
      before,
      frame,
      resizeBounds(frame.visual, "e", 70, 0),
      "e",
    );

    expect(getShapeVisualBounds(after).w).toBeCloseTo(frame.visual.w + 70, 6);
    const afterFixedPoint = westEdgePagePoint(after);
    expect(Math.hypot(
      afterFixedPoint.x - beforeFixedPoint.x,
      afterFixedPoint.y - beforeFixedPoint.y,
    )).toBeLessThan(0.01);
  });

  it("is the reference-box path for a rotated rectangle", () => {
    const shape = rect("rotated", 100, 100, 100, 60, Math.PI / 2);
    const frame = getSelectionResizeFrame([shape], [shape])!;

    const next = resizeRotatedShapeToVisualBounds(shape, frame, { x: 100, y: 100, w: 140, h: 60 }, "e");

    expect(next).toMatchObject({ x: 80, y: 120, props: { w: 140, h: 60 } });
  });
});
