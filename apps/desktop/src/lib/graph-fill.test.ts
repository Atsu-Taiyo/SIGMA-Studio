import { describe, expect, it } from "vitest";

import {
  getGraphFillPath,
  type GraphFillPoint,
  resolveGraphFillRegion,
  sampleCurveSegments,
  toggleGraphFillAtPoint,
} from "@/lib/graph-fill";
import { createGraph2DSpecPreset, getGraphNumericRange, getGraphPlotBox, mapGraphPoint } from "@/lib/graph2d";
import type { Graph2DSpec } from "@/types/sigma-doc";

function baseCartesianSpec(): Graph2DSpec {
  return {
    ...createGraph2DSpecPreset("line"),
    viewBox: {
      xMin: "-2",
      xMax: "2",
      yMin: "-2",
      yMax: "2",
    },
    axes: {
      grid: false,
      showX: true,
      showY: true,
      showTicks: false,
      xTickStep: "1",
      yTickStep: "1",
    },
    curves: [],
    points: [],
    annotations: [],
    showFormulaLabels: false,
  };
}

function wideCartesianSpec(): Graph2DSpec {
  return {
    ...baseCartesianSpec(),
    viewBox: {
      xMin: "-5",
      xMax: "5",
      yMin: "-5",
      yMax: "5",
    },
  };
}

/** 弧 y = sqrt(4 - x^2) が y = 2 に (0,2) で接するグラフ。軸の有無だけを差し替える。 */
function tangentArcSpec(axes: { showX: boolean; showY: boolean }): Graph2DSpec {
  return {
    ...baseCartesianSpec(),
    axes: { ...baseCartesianSpec().axes, ...axes },
    viewBox: {
      xMin: "-3",
      xMax: "3",
      yMin: "-3",
      yMax: "3",
    },
    curves: [
      {
        id: "curve_semicircle",
        expr: "sqrt(4 - x^2)",
        label: "y = sqrt(4 - x^2)",
        color: "#2563eb",
        samples: 220,
      },
      {
        id: "curve_upper",
        expr: "2",
        label: "y = 2",
        color: "#dc2626",
        samples: 220,
      },
    ],
  };
}

/** 放物線 y = x^2 - 2 と x軸で囲まれた面の内部に、何にも接しない小さな閉ループが浮いているグラフ。 */
function detachedLoopSpec(): Graph2DSpec {
  return {
    ...wideCartesianSpec(),
    curves: [
      {
        id: "curve_parabola",
        expr: "x^2 - 2",
        label: "y = x^2 - 2",
        color: "#2563eb",
        samples: 220,
      },
      {
        id: "curve_detached_loop",
        expr: "0.7 + 0.2*cos(t)",
        yExpr: "-0.7 + 0.2*sin(t)",
        mode: "parametric",
        domain: { min: "0", max: "2*pi" },
        label: "浮遊する閉ループ",
        color: "#dc2626",
        samples: 220,
      },
    ],
  };
}

function containsSvgPoint(point: GraphFillPoint, polygon: GraphFillPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses = (current.y > point.y) !== (previous.y > point.y);
    if (!crosses) {
      continue;
    }

    const x = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (point.x < x) {
      inside = !inside;
    }
  }

  return inside;
}

describe("graph-fill", () => {
  it("resolves the region closed by a parabola and the x-axis", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      curves: [
        {
          id: "curve_parabola",
          expr: "x^2 - 1",
          label: "y = x^2 - 1",
          color: "#2563eb",
          samples: 160,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 0.5, y: -0.5 });

    expect(region?.path).toMatch(/^M/);
    expect(region?.path).toContain("Z");
    expect(region?.area).toBeGreaterThan(1000);
  });

  it("resolves the region closed by two curves", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: false,
        showY: false,
      },
      curves: [
        {
          id: "curve_lower",
          expr: "x^2",
          label: "y = x^2",
          color: "#2563eb",
          samples: 180,
        },
        {
          id: "curve_upper",
          expr: "1",
          label: "y = 1",
          color: "#dc2626",
          samples: 180,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 0, y: 0.5 });

    expect(region?.path).toMatch(/^M/);
    expect(region?.area).toBeGreaterThan(1000);
  });

  it("resolves a two-curve region even when the click is on a single axis inside it", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      curves: [
        {
          id: "curve_lower",
          expr: "x^2",
          label: "y = x^2",
          color: "#2563eb",
          samples: 180,
        },
        {
          id: "curve_upper",
          expr: "2 - x^2",
          label: "y = 2 - x^2",
          color: "#dc2626",
          samples: 180,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 0, y: 1 });

    expect(region?.path).toMatch(/^M/);
    expect(region?.area).toBeGreaterThan(1000);
  });

  it("resolves thin regions near a shared curve-axis vertex", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      curves: [
        {
          id: "curve_diagonal",
          expr: "x",
          label: "y = x",
          color: "#2563eb",
          samples: 180,
        },
      ],
    };

    const lowerLeftBelowLine = resolveGraphFillRegion(spec, { x: -0.01, y: -0.02 });
    const lowerLeftAboveLine = resolveGraphFillRegion(spec, { x: -0.02, y: -0.01 });
    const boundary = toggleGraphFillAtPoint(spec, { x: 0, y: 0 }, "fill_boundary");
    const oneFill = toggleGraphFillAtPoint(spec, { x: -0.01, y: -0.02 }, "fill_a");
    const twoFills = toggleGraphFillAtPoint(oneFill, { x: -0.02, y: -0.01 }, "fill_b");

    expect(lowerLeftBelowLine?.path).toMatch(/^M/);
    expect(lowerLeftAboveLine?.path).toMatch(/^M/);
    expect(lowerLeftBelowLine?.path).not.toBe(lowerLeftAboveLine?.path);
    expect(boundary.fills).toBeUndefined();
    expect(twoFills.fills).toHaveLength(2);
  });

  it("does not include a decorative sine lobe when filling the lower-left y < x region", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      viewBox: {
        xMin: "-2*pi",
        xMax: "2*pi",
        yMin: "-1.5",
        yMax: "1.5",
      },
      curves: [
        {
          id: "curve_sine",
          expr: "sin(x)",
          label: "y = sin(x)",
          color: "#2563eb",
          samples: 220,
        },
        {
          id: "curve_diagonal",
          expr: "x",
          label: "y = x",
          color: "#0d0d0d",
          samples: 220,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: -0.5, y: -1 });
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const sineLobePoint = mapGraphPoint(-1.2, -0.65, range, spec, plotBox);
    const lowerLeftPoint = mapGraphPoint(-0.3, -1, range, spec, plotBox);

    expect(region?.path).toMatch(/^M/);
    expect(containsSvgPoint(lowerLeftPoint, region!.polygon)).toBe(true);
    expect(containsSvgPoint(sineLobePoint, region!.polygon)).toBe(false);
  });

  it("keeps tangent curve-axis regions separated at a contact point", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showY: false,
      },
      viewBox: {
        xMin: "-1",
        xMax: "1",
        yMin: "-0.5",
        yMax: "1",
      },
      curves: [
        {
          id: "curve_tangent",
          expr: "x^2",
          label: "y = x^2",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const leftRegion = resolveGraphFillRegion(spec, { x: -0.1, y: 0.005 });
    const rightRegion = resolveGraphFillRegion(spec, { x: 0.1, y: 0.005 });
    const leftFill = toggleGraphFillAtPoint(spec, { x: -0.1, y: 0.005 }, "fill_left");
    const bothFills = toggleGraphFillAtPoint(leftFill, { x: 0.1, y: 0.005 }, "fill_right");

    expect(leftRegion?.path).toMatch(/^M/);
    expect(rightRegion?.path).toMatch(/^M/);
    expect(leftRegion?.path).not.toBe(rightRegion?.path);
    expect(bothFills.fills).toHaveLength(2);
  });

  it("does not invent a contact when a curve only passes near an axis", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showY: false,
      },
      viewBox: {
        xMin: "-1",
        xMax: "1",
        yMin: "-0.5",
        yMax: "1",
      },
      curves: [
        {
          id: "curve_near_axis",
          expr: "x^2 + 0.005",
          label: "y = x^2 + 0.005",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const leftFill = toggleGraphFillAtPoint(spec, { x: -0.2, y: 0.02 }, "fill_left");
    const toggledOff = toggleGraphFillAtPoint(leftFill, { x: 0.2, y: 0.02 }, "fill_right");

    expect(leftFill.fills).toHaveLength(1);
    expect(toggledOff.fills).toBeUndefined();
  });

  it("resolves frame-bounded cells in a multi-curve graph", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      width: 451.70919041293365,
      height: 384.18507708603545,
      viewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "-3",
        yMax: "9",
      },
      axes: {
        ...baseCartesianSpec().axes,
        showX: false,
        showY: true,
      },
      curves: [
        {
          id: "curve_x_sin_y",
          expr: "sin(y)",
          mode: "xOfY",
          label: "x = sin(y)",
          color: "#0d0d0d",
          samples: 220,
        },
        {
          id: "curve_y_sin_x",
          expr: "sin(x)",
          mode: "yOfX",
          domain: { min: "-1" },
          label: "y = sin(x)",
          color: "#0d0d0d",
          samples: 220,
        },
        {
          id: "curve_y_x",
          expr: "x",
          mode: "yOfX",
          domain: { min: "-6" },
          label: "y = x",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 0.1, y: 2.4 });
    const plotBox = getGraphPlotBox(spec);
    const frameArea = (spec.width - plotBox.left - plotBox.right) * (spec.height - plotBox.top - plotBox.bottom);

    expect(region?.path).toMatch(/^M/);
    expect(region?.area).toBeLessThan(frameArea * 0.8);
  });

  it("separates the two lenses of an off-grid tangency at the x-axis", () => {
    // x^4 - x^2 は x=0 で x軸に接する。viewBox 幅 3.5 / samples 220 なので
    // x=0 はサンプル格子から外れ、接点は「格子上の厳密ヒット」では検出できない。
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: true,
        showY: false,
      },
      viewBox: {
        xMin: "-1.5",
        xMax: "2",
        yMin: "-1",
        yMax: "1",
      },
      curves: [
        {
          id: "curve_tangent_offgrid",
          expr: "x^4 - x^2",
          label: "y = x^4 - x^2",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const left = resolveGraphFillRegion(spec, { x: -0.5, y: -0.15 });
    const right = resolveGraphFillRegion(spec, { x: 0.5, y: -0.15 });
    const leftFill = toggleGraphFillAtPoint(spec, { x: -0.5, y: -0.15 }, "fill_left");
    const bothFills = toggleGraphFillAtPoint(leftFill, { x: 0.5, y: -0.15 }, "fill_right");

    // 片側のレンズは ∫(x^2 - x^4)dx = 2/15 unit^2、面積係数 141.71 * 124 = 17572.5 px^2/unit^2
    expect(left?.path).toMatch(/^M/);
    expect(right?.path).toMatch(/^M/);
    expect(left?.path).not.toBe(right?.path);
    expect(left!.area).toBeGreaterThan(2000);
    expect(left!.area).toBeLessThan(2400);
    expect(right!.area).toBeCloseTo(left!.area, -1);
    expect(bothFills.fills).toHaveLength(2);
  });

  it("closes a semicircle onto the x-axis at its domain edges", () => {
    // sqrt(4 - x^2) の定義域端 x=±2 はサンプル格子に載らないため、
    // 補完しないと弧が x軸から 11px 浮いた孤立成分になる。
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: true,
        showY: false,
      },
      viewBox: {
        xMin: "-3",
        xMax: "3",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          id: "curve_semicircle",
          expr: "sqrt(4 - x^2)",
          label: "y = sqrt(4 - x^2)",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 0, y: 1 });

    // 半円 = pi * 2^2 / 2 = 6.2832 unit^2、面積係数 82.667 * 41.333 = 3417 px^2/unit^2
    expect(region?.path).toMatch(/^M/);
    expect(region!.area).toBeGreaterThan(20500);
    expect(region!.area).toBeLessThan(21600);
  });

  it("separates the two sides of a tangency once the arc ends are welded to the axes", () => {
    // 実際の教材シナリオ (軸ON)。弧の端 (±2,0) が x軸に溶接され、y軸が接点 (0,2) を通るので
    // 接点の左右が別の領域になる。片側 = 3*2 - pi*2^2/4 = 6 - pi = 2.8584 unit^2、
    // 面積係数 82.667 * 41.333 = 3417 px^2/unit^2 → 9767 px^2。
    const spec = tangentArcSpec({ showX: true, showY: true });

    const left = resolveGraphFillRegion(spec, { x: -1, y: 1.9 });
    const right = resolveGraphFillRegion(spec, { x: 1, y: 1.9 });
    const leftFill = toggleGraphFillAtPoint(spec, { x: -1, y: 1.9 }, "fill_left");
    const bothFills = toggleGraphFillAtPoint(leftFill, { x: 1, y: 1.9 }, "fill_right");

    expect(left?.path).not.toBe(right?.path);
    expect(left!.area).toBeGreaterThan(9600);
    expect(left!.area).toBeLessThan(9900);
    expect(right!.area).toBeCloseTo(left!.area, -1);
    expect(bothFills.fills).toHaveLength(2);
  });

  it("fills the half disc bounded by the arc, the tangent line and the axes", () => {
    // 弧の内側。y軸で二分されるので pi*2^2/2 / 2 = pi unit^2 → 10734 px^2。
    // 修正前は「x軸より上・フレーム内」の象限矩形 30752 px^2 が返っていた。
    const spec = tangentArcSpec({ showX: true, showY: true });

    const region = resolveGraphFillRegion(spec, { x: 0.5, y: 1 });

    expect(region!.area).toBeGreaterThan(10600);
    expect(region!.area).toBeLessThan(10800);
  });

  it("treats free arc ends as not separating the region under the tangent line", () => {
    // 軸OFF だと弧の両端 (±2,0) はどこにも接続しない行き止まりになる。
    // 行き止まりの鎖は位相的に面を分割しない (端を回り込める) ので、y=2 の下は
    // 1つの連結領域であり、左右で塗り分けられないのが正しい。
    // 弧が境界として効くのは、その端が軸やフレームに溶接されたときだけ (上のテスト)。
    const spec = tangentArcSpec({ showX: false, showY: false });

    const left = resolveGraphFillRegion(spec, { x: -1, y: 1.9 });
    const right = resolveGraphFillRegion(spec, { x: 1, y: 1.9 });

    expect(left?.path).toBe(right?.path);
    // 496 × (5/6 × 248) = 102506.7
    expect(left!.area).toBeGreaterThan(102000);
    expect(left!.area).toBeLessThan(103000);
  });

  it("does not leak past the domain edge of a square-root curve", () => {
    // sqrt(x) は x<0 で未定義。定義域端 x=0 を補完しないと、
    // 曲線の下の領域と曲線の外の領域が1つの面に融合する。
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: true,
        showY: false,
      },
      viewBox: {
        xMin: "-3",
        xMax: "3.5",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          id: "curve_sqrt",
          expr: "sqrt(x)",
          label: "y = sqrt(x)",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const underCurve = resolveGraphFillRegion(spec, { x: 2, y: 0.5 });
    const outsideCurve = resolveGraphFillRegion(spec, { x: -2, y: 1 });
    const oneFill = toggleGraphFillAtPoint(spec, { x: 2, y: 0.5 }, "fill_under");
    const twoFills = toggleGraphFillAtPoint(oneFill, { x: -2, y: 1 }, "fill_outside");

    // 曲線の下 = ∫[0,3.5] sqrt(x) dx = 4.3653 unit^2、面積係数 76.31 * 41.333 = 3153.7
    expect(underCurve?.path).toMatch(/^M/);
    expect(underCurve!.area).toBeGreaterThan(13300);
    expect(underCurve!.area).toBeLessThan(14000);
    expect(outsideCurve?.path).toMatch(/^M/);
    expect(outsideCurve?.path).not.toBe(underCurve?.path);
    expect(twoFills.fills).toHaveLength(2);
  });

  it("closes a diverging curve at the frame when it leaves the sampling window in one step", () => {
    // 1/x は x=0 の直前後で窓 (±8スパン) の外へ一気に飛ぶ。窓外へ出る線分を
    // 捨てると分枝がフレーム内で途切れ、漸近線の左右が1つの面に融合する。
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: false,
        showY: false,
      },
      viewBox: {
        xMin: "-3",
        xMax: "3",
        yMin: "-100",
        yMax: "100",
      },
      curves: [
        {
          id: "curve_reciprocal",
          expr: "1/x",
          label: "y = 1/x",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const upperRight = resolveGraphFillRegion(spec, { x: 2, y: 50 });
    const lowerLeft = resolveGraphFillRegion(spec, { x: -2, y: -50 });
    const oneFill = toggleGraphFillAtPoint(spec, { x: 2, y: 50 }, "fill_upper_right");
    const twoFills = toggleGraphFillAtPoint(oneFill, { x: -2, y: -50 }, "fill_lower_left");
    const plotBox = getGraphPlotBox(spec);
    const frameArea = (spec.width - plotBox.left - plotBox.right) * (spec.height - plotBox.top - plotBox.bottom);

    expect(upperRight?.path).toMatch(/^M/);
    expect(lowerLeft?.path).toMatch(/^M/);
    expect(upperRight?.path).not.toBe(lowerLeft?.path);
    expect(upperRight!.area).toBeLessThan(frameArea * 0.5);
    expect(twoFills.fills).toHaveLength(2);
  });

  it("keeps regions on both sides of a tangent asymptote separated", () => {
    // ±8スパンの窓外ガードが残っていること (外すと tan の漸近線をまたぐ偽の縦線が引かれ、
    // 中央の分枝の左右が別の形に崩れる) の回帰テスト。
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: false,
        showY: false,
      },
      viewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          id: "curve_tangent",
          expr: "tan(x)",
          label: "y = tan(x)",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const leftOfAsymptote = resolveGraphFillRegion(spec, { x: -1.7, y: 0 });
    const rightOfAsymptote = resolveGraphFillRegion(spec, { x: 1.7, y: 0 });
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);

    expect(leftOfAsymptote?.path).toMatch(/^M/);
    expect(rightOfAsymptote?.path).toMatch(/^M/);
    expect(leftOfAsymptote?.path).not.toBe(rightOfAsymptote?.path);
    expect(
      containsSvgPoint(mapGraphPoint(1.7, 0, range, spec, plotBox), leftOfAsymptote!.polygon),
    ).toBe(false);
    expect(
      containsSvgPoint(mapGraphPoint(-1.7, 0, range, spec, plotBox), rightOfAsymptote!.polygon),
    ).toBe(false);
  });

  it("does not fill a face that encloses a detached closed loop", () => {
    // 閉じたループは剪定されずに残り、面の内部に浮いたままになる。この面は実際には
    // 穴あき領域 (annulus) で多角形1つでは表せないので、塗らないのが正しい。
    const spec = detachedLoopSpec();

    expect(resolveGraphFillRegion(spec, { x: 1, y: -0.5 })).toBeNull();
    // ループを含まない反対側の面は従来どおり塗れる (事後条件が広く効きすぎていないこと)。
    expect(resolveGraphFillRegion(spec, { x: -1, y: -0.5 })?.path).toMatch(/^M/);
    // ループの内側そのものは閉じているので塗れる。
    expect(resolveGraphFillRegion(spec, { x: 0.7, y: -0.7 })?.path).toMatch(/^M/);
  });

  it("does not fill an open face even when the click lands on an axis", () => {
    // 軸から 0.35px 以内のクリック (境界ヒット経路) でも事後条件を効かせる。
    // y = -0.01 は x軸から 0.248px。
    const spec = detachedLoopSpec();

    expect(resolveGraphFillRegion(spec, { x: 1, y: -0.01 })).toBeNull();
    // 同じ境界ヒット経路で、閉じている反対側は塗れること (無条件 null になっていない)。
    expect(resolveGraphFillRegion(spec, { x: -1, y: -0.01 })?.path).toMatch(/^M/);
  });

  it("does not fall back to the single-curve analytic region when the face is open", () => {
    // 解析経路は曲線1本と1本の直線境界しか見ない。x^2-2 と y=0 の解析領域は
    // x ∈ [-1.414, 1.414] で **y軸を跨ぐ** (≈4638 px^2)。面追跡が「閉じていない」と
    // 判定した後にここへフォールバックすると、描かれている y軸を越えて塗ってしまう。
    const spec = detachedLoopSpec();
    const region = resolveGraphFillRegion(spec, { x: 1, y: -0.5 });
    const mirrored = resolveGraphFillRegion(spec, { x: -1, y: -0.5 });

    expect(region).toBeNull();
    // 対称な反対側は y軸で切られた片側だけ (≈2319 px^2) であり、解析領域の半分にあたる。
    expect(mirrored!.area).toBeLessThan(2500);
  });

  it("keeps surrounding regions fillable when a domain-limited curve dead-ends inside them", () => {
    // 教材で頻出の「y = x (-2 ≤ x ≤ 2)」。行き止まりの線分は面を分割しないので、
    // それを内部に含む第1象限は従来どおり塗れなければならない。
    const spec: Graph2DSpec = {
      ...wideCartesianSpec(),
      curves: [
        {
          id: "curve_segment",
          expr: "x",
          domain: { min: "-2", max: "2" },
          label: "y = x (-2 <= x <= 2)",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    // 第1象限 = 248 × 124 = 30752 px^2。線分の右外側と上側のどちらから押しても同じ面。
    const rightOfSegment = resolveGraphFillRegion(spec, { x: 2.5, y: 1 });
    const aboveSegment = resolveGraphFillRegion(spec, { x: 0.5, y: 2.5 });

    expect(rightOfSegment!.area).toBeCloseTo(30752, 0);
    expect(aboveSegment!.area).toBeCloseTo(30752, 0);
    expect(rightOfSegment!.path).toBe(aboveSegment!.path);
  });

  it("keeps a quadrant fillable when a detached annotation segment floats inside it", () => {
    // 何にも接していない浮遊線分。両端から剪定されて完全に消えるので、第1象限は塗れる。
    const spec: Graph2DSpec = {
      ...wideCartesianSpec(),
      curves: [
        {
          id: "curve_floating_note",
          expr: "1",
          domain: { min: "0.5", max: "1.5" },
          label: "y = 1",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    expect(resolveGraphFillRegion(spec, { x: 2.5, y: 2.5 })!.area).toBeCloseTo(30752, 0);
  });

  it("keeps regions fillable around an annotation segment that touches a curve", () => {
    // y = 1 (0.5 <= x <= 1.5) は y = x^2 と (1,1) で交わるが、両端は行き止まり。
    // 交点で次数3になるだけで面は分割されないので、周囲は従来どおり塗れる。
    const spec: Graph2DSpec = {
      ...wideCartesianSpec(),
      curves: [
        {
          id: "curve_parabola",
          expr: "x^2",
          label: "y = x^2",
          color: "#2563eb",
          samples: 220,
        },
        {
          id: "curve_note",
          expr: "1",
          domain: { min: "0.5", max: "1.5" },
          label: "y = 1",
          color: "#dc2626",
          samples: 220,
        },
      ],
    };

    // 放物線の下・x軸の上・y軸の右 = ∫[0,√5] x^2 dx + (5-√5)*5 = 17.55 unit^2 × 1230.08
    const underParabola = resolveGraphFillRegion(spec, { x: 2.5, y: 0.5 });
    // 放物線の上・y軸の右 = ∫[0,√5] (5 - x^2) dx = 7.454 unit^2 × 1230.08
    const aboveParabola = resolveGraphFillRegion(spec, { x: 1, y: 2 });

    expect(underParabola!.area).toBeGreaterThan(21300);
    expect(underParabola!.area).toBeLessThan(21800);
    expect(aboveParabola!.area).toBeGreaterThan(9000);
    expect(aboveParabola!.area).toBeLessThan(9300);
  });

  it("closes an xOfY curve onto the y-axis at its domain edges", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: false,
        showY: true,
      },
      viewBox: {
        xMin: "-3",
        xMax: "3",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          id: "curve_semicircle_x_of_y",
          expr: "sqrt(4 - y^2)",
          mode: "xOfY",
          label: "x = sqrt(4 - y^2)",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 1, y: 0 });

    expect(region?.path).toMatch(/^M/);
    expect(region!.area).toBeGreaterThan(20500);
    expect(region!.area).toBeLessThan(21600);
  });

  it("closes a parametric curve at the edge of its defined domain", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: true,
        showY: false,
      },
      viewBox: {
        xMin: "-3",
        xMax: "3",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          id: "curve_parametric_semicircle",
          expr: "t",
          yExpr: "sqrt(4 - t^2)",
          mode: "parametric",
          domain: { min: "-3", max: "3" },
          label: "半円",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const region = resolveGraphFillRegion(spec, { x: 0, y: 1 });

    expect(region?.path).toMatch(/^M/);
    expect(region!.area).toBeGreaterThan(20500);
    expect(region!.area).toBeLessThan(21600);
  });

  it("does not invent a split where the curve genuinely crosses the boundary", () => {
    // x^3 は x=0 で x軸を「横切る」。|delta| は局所極小だが符号が変わるので、
    // 接点として二重に分割してはならない。
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: true,
        showY: false,
      },
      viewBox: {
        xMin: "-1.5",
        xMax: "2",
        yMin: "-1",
        yMax: "1",
      },
      curves: [
        {
          id: "curve_cubic",
          expr: "x^3",
          label: "y = x^3",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const above = resolveGraphFillRegion(spec, { x: 0.5, y: 0.05 });
    const below = resolveGraphFillRegion(spec, { x: -0.5, y: -0.05 });
    const oneFill = toggleGraphFillAtPoint(spec, { x: 0.5, y: 0.05 }, "fill_above");
    const twoFills = toggleGraphFillAtPoint(oneFill, { x: -0.5, y: -0.05 }, "fill_below");

    expect(above?.path).toMatch(/^M/);
    expect(below?.path).toMatch(/^M/);
    expect(above?.path).not.toBe(below?.path);
    expect(twoFills.fills).toHaveLength(2);
  });

  it("toggles off a newly separated lens when it is clicked again", () => {
    const spec: Graph2DSpec = {
      ...baseCartesianSpec(),
      axes: {
        ...baseCartesianSpec().axes,
        showX: true,
        showY: false,
      },
      viewBox: {
        xMin: "-1.5",
        xMax: "2",
        yMin: "-1",
        yMax: "1",
      },
      curves: [
        {
          id: "curve_tangent_offgrid",
          expr: "x^4 - x^2",
          label: "y = x^4 - x^2",
          color: "#2563eb",
          samples: 220,
        },
      ],
    };

    const withFill = toggleGraphFillAtPoint(spec, { x: -0.5, y: -0.15 }, "fill_left");
    const withoutFill = toggleGraphFillAtPoint(withFill, { x: -0.7, y: -0.2 }, "fill_left_again");

    expect(withFill.fills).toHaveLength(1);
    expect(withoutFill.fills).toBeUndefined();
  });

  it("returns no curve segments for unsupported or empty curve definitions", () => {
    const spec = baseCartesianSpec();
    const axisRange = getGraphNumericRange(spec);
    const plotBox = getGraphPlotBox(spec);
    const sample = (curve: Parameters<typeof sampleCurveSegments>[0]) =>
      sampleCurveSegments(curve, spec, axisRange, axisRange, plotBox);

    const implicitCurve = sample({
      id: "curve_implicit",
      expr: "x^2 + y^2 - 1",
      mode: "implicit",
      color: "#2563eb",
    });
    const parametricWithoutYExpr = sample({
      id: "curve_parametric_incomplete",
      expr: "t",
      mode: "parametric",
      domain: { min: "-1", max: "1" },
      color: "#2563eb",
    });
    const emptyDomain = sample({
      id: "curve_empty_domain",
      expr: "x",
      domain: { min: "1", max: "1" },
      color: "#2563eb",
    });
    const unparsableExpression = sample({
      id: "curve_unparsable",
      expr: "sin(",
      color: "#2563eb",
    });

    expect(implicitCurve).toEqual([]);
    expect(parametricWithoutYExpr).toEqual([]);
    expect(emptyDomain).toEqual([]);
    expect(unparsableExpression).toEqual([]);
  });

  it("resolves regions closed by axes and the outer frame", () => {
    const spec = baseCartesianSpec();

    const region = resolveGraphFillRegion(spec, { x: 1, y: 1 });

    expect(region?.path).toMatch(/^M/);
    expect(region?.polygon).toHaveLength(4);
  });

  it("toggles an existing fill when the same closed region is clicked again", () => {
    const spec = baseCartesianSpec();
    const withFill = toggleGraphFillAtPoint(spec, { x: 1, y: 1 }, "fill_test");

    expect(withFill.fills).toHaveLength(1);
    expect(getGraphFillPath(withFill, withFill.fills![0])).toMatch(/^M/);

    const withoutFill = toggleGraphFillAtPoint(withFill, { x: 1.2, y: 1.2 }, "fill_second");

    expect(withoutFill.fills).toBeUndefined();
  });

  it("does not add a fill for boundary clicks or number lines", () => {
    const spec = baseCartesianSpec();
    const boundaryClick = toggleGraphFillAtPoint(spec, { x: 0, y: 0 }, "fill_boundary");
    const numberLineClick = toggleGraphFillAtPoint(createGraph2DSpecPreset("numberLine"), { x: 2, y: 0 }, "fill_line");

    expect(boundaryClick.fills).toBeUndefined();
    expect(numberLineClick.fills).toBeUndefined();
  });
});
