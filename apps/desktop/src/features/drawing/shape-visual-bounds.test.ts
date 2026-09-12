import { describe, expect, it } from "vitest";

import type {
  OverlayArcShape,
  OverlayArrowShape,
  OverlayGeoShape,
  OverlayLineShape,
  OverlayShape,
} from "@/features/document";

import { ARROWHEAD_MARKER_SPECS, overlayStrokeWidth } from "@/features/rendering/core";

import { getShapeArrowheadPlan } from "./arrowhead-trim";
import { trimPolylinePoints } from "./line-geometry";
import { getBoundsCenter } from "./math";
import { getShapeBounds, getShapeCenter } from "./shape-bounds";
import { getShapeLabelBounds } from "./shape-label-geometry";
import {
  getRotatedShapeVisualBounds,
  getShapeInkBounds,
  getShapeRotationPivot,
  getShapeVisualBounds,
  getShapesInkBounds,
  getShapesVisualBounds,
  getStrokeInflation,
} from "./shape-visual-bounds";

const HALF_PI = Math.PI / 2;

function arc(props: Partial<OverlayArcShape["props"]> = {}): OverlayArcShape {
  // 3 点円弧は中心ではなく「中心 - r」を x/y に保存する (`arc-creation.ts`)。
  // r = 50 / 中心 (150, 150) の弧。
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

function line(props: Partial<OverlayLineShape["props"]> = {}): OverlayLineShape {
  return {
    id: "line",
    type: "line",
    x: 10,
    y: 20,
    props: {
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      closed: false,
      color: "#111111",
      dash: "solid",
      size: "m",
      ...props,
    },
  };
}

function arrow(props: Partial<OverlayArrowShape["props"]> = {}): OverlayShape {
  return {
    id: "arrow",
    type: "arrow",
    x: 0,
    y: 0,
    props: {
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      arrowheadStart: "none",
      arrowheadEnd: "none",
      color: "#111111",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayShape;
}

function geo(overrides: Partial<OverlayGeoShape> = {}): OverlayGeoShape {
  return {
    id: "geo",
    type: "geo",
    x: 0,
    y: 0,
    ...overrides,
    props: {
      w: 100,
      h: 40,
      geo: "rectangle",
      fill: "none",
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      ...overrides.props,
    },
  } as OverlayGeoShape;
}

function round(bounds: { x: number; y: number; w: number; h: number }) {
  return {
    x: Math.round(bounds.x * 100) / 100,
    y: Math.round(bounds.y * 100) / 100,
    w: Math.round(bounds.w * 100) / 100,
    h: Math.round(bounds.h * 100) / 100,
  };
}

/** 既定サイズ `m` の線幅は 2px。線はパスの中心に描かれるので枠は左右上下に 1px ずつ広がる。 */
const HALF_STROKE_M = 1;

describe("arc visual bounds", () => {
  it("hugs a quarter arc instead of boxing the whole circle", () => {
    // 0° → 90° は中心の右から下へ。通過する象限極値は無いので、端点 2 つだけが枠を決める。
    const bounds = getShapeVisualBounds(arc());

    // 弧が通るのは中心の右 (150,150) から下 (200,200) まで。そこに線幅の半分だけ余白が付く。
    expect(round(bounds)).toMatchObject({
      x: 150 - HALF_STROKE_M,
      y: 150 - HALF_STROKE_M,
      w: 50 + HALF_STROKE_M * 2,
      h: 50 + HALF_STROKE_M * 2,
    });
    // 参照用の箱 (変形・整列が使う) は今までどおり円全体。
    expect(getShapeBounds(arc())).toMatchObject({ x: 100, y: 100, w: 100, h: 100 });
  });

  it("includes the quadrant extreme the sweep actually crosses", () => {
    // -45° → 45° は 0° (右端) を通る。
    const bounds = getShapeVisualBounds(arc({ startAngle: -Math.PI / 4, endAngle: Math.PI / 4 }));

    expect(round(bounds).x + round(bounds).w).toBe(200 + HALF_STROKE_M);
    expect(round(bounds).w).toBeLessThan(100);
  });

  it("matches the full ellipse once the sweep covers every quadrant", () => {
    const nearlyFull = arc({ startAngle: 0, endAngle: Math.PI * 2 - 0.01 });

    expect(round(getShapeVisualBounds(nearlyFull))).toEqual({
      x: 100 - HALF_STROKE_M,
      y: 100 - HALF_STROKE_M,
      w: 100 + HALF_STROKE_M * 2,
      h: 100 + HALF_STROKE_M * 2,
    });
  });

  it("respects separate x and y radii", () => {
    const bounds = getShapeVisualBounds(arc({ rx: 80, ry: 20, startAngle: 0, endAngle: Math.PI }));

    // 0 → π は右端・下端・左端を通る。
    expect(round(bounds)).toEqual({
      x: 100 - HALF_STROKE_M,
      y: 120 - HALF_STROKE_M,
      w: 160 + HALF_STROKE_M * 2,
      h: 20 + HALF_STROKE_M * 2,
    });
  });

  it("includes the centre for a sector", () => {
    const bounds = getShapeVisualBounds(arc({ kind: "sector" }));

    // 扇形は中心と結ぶ 2 本の半径も描かれるので、中心 (150,150) が枠に入る。
    expect(round(bounds)).toMatchObject({ x: 150 - HALF_STROKE_M, y: 150 - HALF_STROKE_M });
    // π → 1.5π は左上の 1/4。中心と左端・上端で決まる。
    expect(round(getShapeVisualBounds(arc({ kind: "sector", startAngle: Math.PI, endAngle: Math.PI * 1.5 })))).toEqual({
      x: 100 - HALF_STROKE_M,
      y: 100 - HALF_STROKE_M,
      w: 50 + HALF_STROKE_M * 2,
      h: 50 + HALF_STROKE_M * 2,
    });
  });
});

describe("stroke and arrowhead inflation", () => {
  it("grows a line by half its stroke width, not by a fixed padding", () => {
    const thin = getShapeVisualBounds(line({ size: "s" }));
    const thick = getShapeVisualBounds(line({ size: "xl" }));

    // 線は水平なので、高さは線幅そのもの。
    expect(round(thin).h).toBeCloseTo(1.25, 2);
    expect(round(thick).h).toBeCloseTo(5, 2);
    // 固定 10px 余白 (= 高さ 20) だった従来の箱より狭い。
    expect(getShapeBounds(line({ size: "s" })).h).toBe(20);
  });

  it("adds room for an arrow head and nothing when there is none", () => {
    const plain = getShapeVisualBounds(arrow());
    const headed = getShapeVisualBounds(arrow({ arrowheadEnd: "arrow" }));

    expect(headed.w).toBeGreaterThan(plain.w);
    // ヘッドは strokeWidth 単位なので、太い線ほど実寸が大きい。
    const thickHeaded = getShapeVisualBounds(arrow({ arrowheadEnd: "arrow", size: "xl" }));
    expect(thickHeaded.w).toBeGreaterThan(headed.w);
  });

  it("adds head room at the start too", () => {
    expect(getShapeVisualBounds(arrow({ arrowheadStart: "arrow" })).x)
      .toBeLessThan(getShapeVisualBounds(arrow()).x);
  });
});

describe("curve visual bounds", () => {
  it("stays inside the control-point box", () => {
    // 制御点 (50,-100) は曲線が実際に届く高さより上にある。
    const curve = line({
      kind: "curve",
      points: [{ x: 0, y: 0 }, { x: 50, y: -100 }, { x: 100, y: 0 }],
    });

    const visual = getShapeVisualBounds(curve);
    const control = getShapeBounds(curve);

    expect(visual.y).toBeGreaterThan(control.y);
    expect(visual.h).toBeLessThan(control.h);
  });

  it("keeps every vertex of a polyline", () => {
    const polyline = line({
      kind: "polyline",
      points: [{ x: 0, y: 0 }, { x: 50, y: -100 }, { x: 100, y: 0 }],
    });

    expect(round(getShapeVisualBounds(polyline)).y).toBeCloseTo(20 - 100 - 1, 0);
  });
});

describe("group visual bounds", () => {
  function group(id: string, members: OverlayShape[]): OverlayShape[] {
    return [
      { id, type: "group", x: 0, y: 0, props: { w: 1000, h: 1000 } },
      ...members.map((member) => ({ ...member, parentId: id })),
    ];
  }

  it("ignores the stored group box and uses what the members actually draw", () => {
    const shapes = group("group_1", [arc(), geo({ id: "rect", x: 400, y: 400 })]);
    const groupShape = shapes[0];

    const bounds = getShapesVisualBounds([groupShape], shapes);

    // 保存済みのグループ箱 (1000x1000) ではなく、弧の実描画 + 矩形の union。
    expect(bounds).not.toBeNull();
    expect(round(bounds!)).toEqual({
      x: 150 - HALF_STROKE_M,
      y: 150 - HALF_STROKE_M,
      w: 350 + HALF_STROKE_M,
      h: 290 + HALF_STROKE_M,
    });
  });

  it("unions nested groups down to the leaves", () => {
    const inner = group("inner", [arc(), line()]);
    const shapes = [
      { id: "outer", type: "group" as const, x: 0, y: 0, props: { w: 9999, h: 9999 } },
      { ...inner[0], parentId: "outer" },
      ...inner.slice(1),
      { ...geo({ id: "rect", x: 400, y: 400 }), parentId: "outer" },
    ] as OverlayShape[];

    const nested = getShapesVisualBounds([shapes[0]], shapes);
    const leaves = getShapesVisualBounds(
      shapes.filter((shape) => shape.type !== "group"),
      shapes,
    );

    expect(nested).toEqual(leaves);
  });

  it("does not grow when the same members are grouped again and again", () => {
    const members = [arc(), line(), geo({ id: "rect", x: 300, y: 300 })];
    const first = getShapesVisualBounds(members, members);

    for (let round_ = 0; round_ < 3; round_ += 1) {
      const regrouped = group(`group_${round_}`, members);
      expect(getShapesVisualBounds([regrouped[0]], regrouped)).toEqual(first);
    }
  });

  it("boxes a rotated member by its rotated corners", () => {
    const rotated = { ...geo({ id: "rect", x: 0, y: 0 }), rotation: Math.PI / 2 } as OverlayShape;

    const bounds = getShapesVisualBounds([rotated], [rotated]);

    // 100x40 を 90° 回すと 40x100。中心は動かない。
    expect(round(bounds!)).toEqual({ x: 30, y: -30, w: 40, h: 100 });
  });

  it("turns a rotated member around the centre of what it draws", () => {
    // 回転軸は実描画 (ink) 箱の中心。弧の ink は正方形なので、90° 回しても箱は動かない。
    // 参照箱の中心 (150,150) を軸にしていた頃は、ここで箱が 50px 左へ飛んでいた。
    const rotated = { ...arc(), rotation: HALF_PI } as OverlayShape;

    expect(round(getRotatedShapeVisualBounds(rotated))).toEqual(round(getShapeVisualBounds(arc())));
    expect(round(getShapesVisualBounds([rotated], [rotated])!))
      .toEqual(round(getRotatedShapeVisualBounds(rotated)));
  });

  it("returns null for an empty selection", () => {
    expect(getShapesVisualBounds([], [])).toBeNull();
  });

  it("survives a parentId cycle instead of recursing forever", () => {
    // 壊れた教材 (AI 生成・インポート) には循環した parentId が実在する。ここが無限再帰すると
    // 選択の useMemo 内で stack overflow になり、画面が真っ白になる。
    const cyclic = [
      { id: "a", type: "group" as const, x: 0, y: 0, parentId: "b", props: { w: 10, h: 10 } },
      { id: "b", type: "group" as const, x: 0, y: 0, parentId: "a", props: { w: 10, h: 10 } },
    ] as OverlayShape[];

    expect(() => getShapesVisualBounds([cyclic[0]], cyclic)).not.toThrow();
  });

  it("keeps an empty group's stored box, since nothing else describes it", () => {
    const empty = [{ id: "g", type: "group" as const, x: 5, y: 6, props: { w: 20, h: 30 } }] as OverlayShape[];

    expect(getShapesVisualBounds(empty, empty)).toEqual({ x: 5, y: 6, w: 20, h: 30 });
  });
});

describe("arrow head extents", () => {
  it("reserves exactly the marker box of each head", () => {
    // The numbers come from `ARROWHEAD_MARKER_SPECS`, but selection boxes are user-visible: pin
    // them here so a rendering-side tweak to a marker box cannot move existing figures unnoticed.
    const strokeWidth = 2; // size "m"
    for (const [head, extent] of [["arrow", 9], ["bar", 12], ["dot", 8]] as const) {
      const bounds = getShapeVisualBounds(arrow({ arrowheadEnd: head, size: "m" }));
      expect(`${head}:${bounds.h}`).toBe(`${head}:${strokeWidth * extent}`);
    }
  });

  it("reserves more room for a bar than for an arrow head", () => {
    // `bar` は線に垂直へ 12 strokeWidth 伸びる (`shape-renderer.tsx`)。8 で見積もるとはみ出す。
    const withArrow = getShapeVisualBounds(arrow({ arrowheadEnd: "arrow", size: "xl" }));
    const withBar = getShapeVisualBounds(arrow({ arrowheadEnd: "bar", size: "xl" }));

    expect(withBar.h).toBeGreaterThan(withArrow.h);
  });

  it("does not read an arrow head name off Object.prototype", () => {
    // `__proto__` を素のオブジェクトで引くと関数が返り `??` が効かず、枠全体が NaN になる。
    const polluted = getShapeVisualBounds(arrow({ arrowheadEnd: "__proto__" as never, size: "m" }));

    expect(Number.isFinite(polluted.w)).toBe(true);
    expect(Number.isFinite(polluted.h)).toBe(true);
  });

  it("falls back to the widest known head for an unrecognised one", () => {
    const unknown = getShapeVisualBounds(arrow({ arrowheadEnd: "someFutureHead" as never, size: "m" }));
    const bar = getShapeVisualBounds(arrow({ arrowheadEnd: "bar", size: "m" }));

    expect(unknown.h).toBe(bar.h);
  });
});

describe("getShapeRotationPivot", () => {
  it("is the centre of the ink, which for an arc is not the centre of the stored box", () => {
    // 弧は `x = 中心 − r` で保存するので、既定の 90° 弧では参照箱の中心 (150,150) と
    // 実際に描かれる 1/4 円の中心 (175,175) が 25px ずれる。
    expect(getShapeCenter(arc())).toEqual({ x: 150, y: 150 });
    expect(getShapeRotationPivot(arc())).toEqual({ x: 175, y: 175 });
  });

  it("is unchanged for every shape that draws its own box", () => {
    // 矩形系は ink = 参照箱。pivot 規則を変えても見た目が動いてはいけない。
    for (const shape of [geo(), geo({ x: 400, y: 400 })]) {
      expect(getShapeRotationPivot(shape)).toEqual(getShapeCenter(shape));
    }
  });

  it("follows the drawn curve, not the control-point box", () => {
    // 制御点 (50,-100) は曲線が実際に届く高さより上にあるので、点群の箱の中心は曲線の外。
    const curve = line({
      kind: "curve",
      points: [{ x: 0, y: 0 }, { x: 50, y: -100 }, { x: 100, y: 0 }],
    });

    expect(getShapeRotationPivot(curve).y).toBeGreaterThan(getShapeCenter(curve).y);
    expect(getShapeRotationPivot(curve)).toEqual(getBoundsCenter(getShapeInkBounds(curve)));
  });

  it("ignores the caption, so renaming a label cannot move the axis", () => {
    expect(getShapeRotationPivot(line({ label: "A".repeat(40) })))
      .toEqual(getShapeRotationPivot(line()));
  });
});

describe("line and arrow labels", () => {
  it("covers the caption drawn above a horizontal line", () => {
    const labelled = line({ label: "AB" });
    const label = getShapeLabelBounds(labelled)!;
    const bounds = getShapeVisualBounds(labelled);

    // ラベルはベースライン基準で線の 8px 上に描かれるので、線幅だけの箱には収まらない。
    expect(getShapeVisualBounds(line()).y).toBeGreaterThan(label.y);
    expect(bounds.y).toBeLessThanOrEqual(label.y);
  });

  it("widens the box when the caption is longer than the line", () => {
    const long = line({ label: "A".repeat(40) });
    const plain = getShapeVisualBounds(line());
    const bounds = getShapeVisualBounds(long);

    expect(bounds.x).toBeLessThan(plain.x);
    expect(bounds.x + bounds.w).toBeGreaterThan(plain.x + plain.w);
  });

  it("covers an arrow's caption too", () => {
    const labelled = arrow({ label: "AB" }) as OverlayArrowShape;

    expect(getShapeVisualBounds(labelled).y)
      .toBeLessThanOrEqual(getShapeLabelBounds(labelled)!.y);
  });

  it("leaves the ink box exactly where it was", () => {
    // ラベルはフォントサイズ固定でリサイズにスケールしない。ink に混ぜると掴んだ辺が
    // ポインタから逃げるので、visual 箱にだけ入れる (`resize-frame.ts` の不変条件)。
    expect(getShapeInkBounds(line({ label: "A".repeat(40) }))).toEqual(getShapeInkBounds(line()));
    expect(getShapeInkBounds(arrow({ label: "AB" }))).toEqual(getShapeInkBounds(arrow()));
  });

  it("is the union of the inflated ink box and the label box", () => {
    const labelled = line({ label: "A".repeat(40) });
    const inflation = getStrokeInflation(labelled);
    const ink = getShapeInkBounds(labelled);
    const label = getShapeLabelBounds(labelled)!;
    const left = Math.min(ink.x - inflation, label.x);
    const top = Math.min(ink.y - inflation, label.y);

    expect(round(getShapeVisualBounds(labelled))).toEqual(round({
      x: left,
      y: top,
      w: Math.max(ink.x + ink.w + inflation, label.x + label.w) - left,
      h: Math.max(ink.y + ink.h + inflation, label.y + label.h) - top,
    }));
  });

  it("keeps a label-free line exactly as it was", () => {
    expect(getShapeVisualBounds(line({ label: "" }))).toEqual(getShapeVisualBounds(line()));
  });
});

describe("ink bounds", () => {
  const SHAPES: [string, OverlayShape][] = [
    ["arc", arc()],
    ["arc with heads", arc({ size: "xl", arrowheadEnd: "arrow" })],
    ["line", line()],
    ["freehand", line({ kind: "freehand", points: [{ x: 0, y: 0 }, { x: 50, y: -100 }, { x: 100, y: 0 }] })],
    ["arrow", arrow({ arrowheadEnd: "bar", size: "l" })],
    ["geo", geo()],
  ];

  it("is the visible box of a label-free shape with the stroke and head padding taken back off", () => {
    // リサイズは ink 箱を写して pad を足し直す。この 2 つが同じ計算から出ていないと、
    // 「掴んだ辺がポインタに追従する」という不変条件が黙って崩れる。
    // ラベル付きの図形では visual = union(inflate(ink), ラベル箱) になるので、対称な
    // inflation だけで表せるのはラベルの無い図形に限る (上の "line and arrow labels" 参照)。
    for (const [label, shape] of SHAPES) {
      const inflation = getStrokeInflation(shape);
      const ink = getShapeInkBounds(shape);
      const expected = {
        x: ink.x - inflation,
        y: ink.y - inflation,
        w: ink.w + inflation * 2,
        h: ink.h + inflation * 2,
      };

      expect(`${label}:${JSON.stringify(round(getShapeVisualBounds(shape)))}`)
        .toBe(`${label}:${JSON.stringify(round(expected))}`);
    }
  });

  it("keeps the reference box for shapes that draw their own box", () => {
    expect(getShapeInkBounds(geo())).toEqual(getShapeBounds(geo()));
    expect(getStrokeInflation(geo())).toBe(0);
  });

  it("strips the same padding from a selection as from one shape", () => {
    const shapes = [arc(), geo({ x: 400, y: 400 })];

    expect(getShapesInkBounds(shapes, shapes)).toEqual({ x: 150, y: 150, w: 350, h: 290 });
    expect(getShapesVisualBounds(shapes, shapes)).toEqual({
      x: 150 - HALF_STROKE_M,
      y: 150 - HALF_STROKE_M,
      w: 350 + HALF_STROKE_M,
      h: 290 + HALF_STROKE_M,
    });
  });
});

describe("freehand visual bounds", () => {
  it("uses the smoothed path, like the renderer does", () => {
    // `getLineSvgPath` は polyline 以外をすべて滑らかに描く。freehand を制御点の箱で囲むと
    // 実際より広い枠になる。
    const points = [{ x: 0, y: 0 }, { x: 50, y: -100 }, { x: 100, y: 0 }];
    const freehand = line({ kind: "freehand", points });
    const polyline = line({ kind: "polyline", points });

    expect(getShapeVisualBounds(freehand).h).toBeLessThan(getShapeVisualBounds(polyline).h);
  });
});

describe("the selection box still contains everything that is drawn", () => {
  it.each(ARROWHEAD_MARKER_SPECS)("covers the trimmed line and the whole marker box of $kind", (spec) => {
    // The trim only ever shortens ink, so this box stays an upper bound — but the head moved back
    // by the same amount, and it is the head that reaches furthest. Checked at every size because
    // marker units are stroke widths and the two grow together.
    for (const size of ["s", "m", "l", "xl"] as const) {
      const strokeWidth = overlayStrokeWidth(size);
      const shape = arrow({
        start: { x: 0, y: 200 },
        end: { x: 400, y: 200 },
        arrowheadEnd: spec.kind,
        size,
      }) as OverlayArrowShape;
      const bounds = getShapeVisualBounds(shape);
      const plan = getShapeArrowheadPlan(shape);
      const [drawnStart, drawnEnd] = trimPolylinePoints(
        [shape.props.start, shape.props.end],
        plan.start.trimPx,
        plan.end.trimPx,
      );

      // The marker's own box, laid down along the line at the point the path now ends.
      const markerBox = {
        left: drawnEnd.x - plan.end.refX * strokeWidth,
        right: drawnEnd.x + (spec.markerWidth - plan.end.refX) * strokeWidth,
        top: drawnEnd.y - spec.refY * strokeWidth,
        bottom: drawnEnd.y + (spec.markerHeight - spec.refY) * strokeWidth,
      };

      // The box and the marker reach the same distance by two different multiplications, so a head
      // whose marker units are not whole numbers can miss by one ulp. That is arithmetic noise,
      // not a head sticking out of its selection.
      const slack = 1e-9;
      const inside = drawnStart.x >= bounds.x - slack &&
        markerBox.left >= bounds.x - slack &&
        markerBox.right <= bounds.x + bounds.w + slack &&
        markerBox.top >= bounds.y - slack &&
        markerBox.bottom <= bounds.y + bounds.h + slack;
      expect(`${spec.kind}/${size}:${inside}`).toBe(`${spec.kind}/${size}:true`);
    }
  });
});
