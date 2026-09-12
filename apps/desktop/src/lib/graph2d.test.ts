import { describe, expect, it } from "vitest";

import {
  buildFunctionPath,
  cropGraphSpecToSvgBox,
  createGraph2DSpecPreset,
  evaluateExpression,
  evaluateImplicitExpression,
  evaluateScalar,
  fitGraphViewBoxToCurves,
  formatGraphCurveLabel,
  formatTickLabel,
  getGraphDisplayRange,
  getGraphExpressionVariableSegments,
  getGraphIssues,
  getGraphNumericRange,
  getGraphPlotBox,
  makeGraphCurveLabel,
  mapGraphPoint,
  moveGraphOriginToRatios,
} from "@/lib/graph2d";

describe("graph2d", () => {
  it("evaluates supported math expressions", () => {
    expect(evaluateExpression("sin(pi/2)", 0)).toBeCloseTo(1);
    expect(evaluateExpression("x^2 - 5*x + 6", 2)).toBeCloseTo(0);
    expect(evaluateExpression("x^2 - 5x + 6", 3)).toBeCloseTo(0);
    expect(evaluateExpression("2*x + 1", 3)).toBeCloseTo(7);
    expect(evaluateExpression("y^2 + 1", 3, "y")).toBeCloseTo(10);
    expect(evaluateExpression("cos(t)", Math.PI, "t")).toBeCloseTo(-1);
    expect(evaluateImplicitExpression("x^2 - y^2 - 2*y", 2, 1)).toBeCloseTo(1);
    expect(evaluateImplicitExpression("x^2 - 4*x + y^2 = 22", 6, Math.sqrt(10))).toBeCloseTo(0);
    expect(evaluateExpression("sqrt(9) + abs(-2)", 0)).toBeCloseTo(5);
  });

  it("binds unary minus looser than exponentiation", () => {
    // -x^2 は -(x^2)。従来は (-x)^2 と解釈され、教材のグラフが上下反転していた。
    expect(evaluateExpression("-x^2", 2, "x")).toBeCloseTo(-4);
    expect(evaluateExpression("-x^2", 3, "x")).toBeCloseTo(-9);
    expect(evaluateExpression("-2^2", 0)).toBeCloseTo(-4);
  });

  it("keeps unary minus working on the exponent side", () => {
    expect(evaluateExpression("2^-3", 0)).toBeCloseTo(0.125);
    expect(evaluateExpression("-x^-2", 2, "x")).toBeCloseTo(-0.25);
  });

  it("keeps exponentiation right associative", () => {
    // 2^(3^2) = 512 であって (2^3)^2 = 64 ではない。
    expect(evaluateExpression("2^3^2", 0)).toBeCloseTo(512);
  });

  it("folds repeated unary signs", () => {
    expect(evaluateExpression("--x", 3, "x")).toBeCloseTo(3);
    expect(evaluateExpression("-+-x", 3, "x")).toBeCloseTo(3);
  });

  it("applies unary minus after a function call is raised to a power", () => {
    const x = 0.7;
    expect(evaluateExpression("-sin(x)^2", x, "x")).toBeCloseTo(-(Math.sin(x) ** 2));
  });

  it("keeps explicit grouping and multiplication by a negative intact", () => {
    expect(evaluateExpression("-(x^2)", 2, "x")).toBeCloseTo(-4);
    expect(evaluateExpression("(-x)^2", 2, "x")).toBeCloseTo(4);
    expect(evaluateExpression("2*-3", 0)).toBeCloseTo(-6);
    expect(evaluateExpression("2 * -x^2", 2, "x")).toBeCloseTo(-8);
    // 暗黙の乗算はべき乗より緩い: x^2*3 は (x^2)*3。
    expect(evaluateExpression("x^2*3", 3, "x")).toBeCloseTo(27);
    expect(evaluateExpression("2x^2", 3, "x")).toBeCloseTo(18);
  });

  it("draws y = -x^2 below the x-axis", () => {
    // 評価器の結合順は描画 (buildFunctionPath) と塗りつぶし (sampleCurveSegments) の
    // 共通経路。修正前は (-x)^2 と読まれ、上に開く放物線として描かれていた。
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: { xMin: "-3", xMax: "3", yMin: "-9", yMax: "9" },
      curves: [{ ...createGraph2DSpecPreset("line").curves[0], expr: "-x^2", samples: 60 }],
    };
    const path = buildFunctionPath(spec.curves[0], spec);
    const yCoordinates = [...path.matchAll(/[ML][0-9.eE+-]+ ([0-9.eE+-]+)/g)].map((match) => Number(match[1]));
    // 原点 (y=0) は描画域の中央。頂点だけが中央で、残りはすべてその下 (px は下向きが正)。
    const plotBox = getGraphPlotBox(spec);
    const originY = mapGraphPoint(0, 0, getGraphNumericRange(spec), spec, plotBox).y;
    expect(Math.min(...yCoordinates)).toBeCloseTo(originY, 1);
    expect(Math.max(...yCoordinates)).toBeGreaterThan(originY);
  });

  it("binds a unary minus looser than a power", () => {
    // `-x^2` は -(x^2)。単項マイナスを `^` より強く結合すると +x^2 になってしまう。
    expect(evaluateExpression("-x^2", 0.3)).toBeCloseTo(-0.09, 10);
    expect(evaluateExpression("-x^-2", 0.3)).toBeCloseTo(-(0.3 ** -2), 10);
    expect(evaluateExpression("-sin(x)^2", 0.3)).toBeCloseTo(-(Math.sin(0.3) ** 2), 10);
    expect(evaluateScalar("-2^2")).toBe(-4);
    expect(evaluateScalar("-1^2")).toBe(-1);
    // 括弧で囲めば従来どおり底に符号が含まれる。
    expect(evaluateScalar("(-2)^2")).toBe(4);
    expect(evaluateExpression("(-x)^2", 0.3)).toBeCloseTo(0.09, 10);
    // 減算は単項マイナスと取り違えない。
    expect(evaluateScalar("10-2^2")).toBe(6);
    expect(evaluateExpression("1-x^2", 0.3)).toBeCloseTo(0.91, 10);
    // 陰関数・スカラーも同じ ExpressionParser を通るので同時に直る。
    expect(evaluateImplicitExpression("-x^2+y", 3, 0)).toBeCloseTo(-9, 10);
  });

  it("keeps power right-associativity and signed exponents", () => {
    expect(evaluateScalar("2^3^2")).toBe(512);
    expect(evaluateScalar("2^2^3")).toBe(256);
    expect(evaluateExpression("x^-1", 0.3)).toBeCloseTo(1 / 0.3, 10);
    expect(evaluateExpression("e^-x", 0.3)).toBeCloseTo(Math.exp(-0.3), 10);
    expect(evaluateExpression("x^2^-1", 0.3)).toBeCloseTo(Math.sqrt(0.3), 10);
    // 指数側の単項マイナスも `^` より弱いので `2^(-(3^2))`。
    expect(evaluateScalar("2^-3^2")).toBeCloseTo(2 ** -9, 10);
    expect(evaluateScalar("2^-2")).toBe(0.25);
  });

  it("keeps implicit and explicit multiplication around signs", () => {
    expect(evaluateExpression("2x", 0.3)).toBeCloseTo(0.6, 10);
    expect(evaluateExpression("2x^2", 0.3)).toBeCloseTo(0.18, 10);
    expect(evaluateExpression("3(x+1)", 0.3)).toBeCloseTo(3.9, 10);
    expect(evaluateScalar("2pi")).toBeCloseTo(2 * Math.PI, 10);
    expect(evaluateScalar("2*-3")).toBe(-6);
    expect(evaluateScalar("2/-4")).toBe(-0.5);
    expect(evaluateExpression("-2x", 0.3)).toBeCloseTo(-0.6, 10);
    expect(evaluateScalar("-4/2^2")).toBe(-1);
    expect(evaluateExpression("--x", 0.3)).toBeCloseTo(0.3, 10);
  });

  it("creates a blank graph preset without a default curve", () => {
    const spec = createGraph2DSpecPreset("blank");

    expect(spec.curves).toEqual([]);
    expect(spec.axes.grid).toBe(false);
    expect(spec.axes.showTicks).toBe(false);
  });

  it("builds an SVG path for preset curves", () => {
    const spec = createGraph2DSpecPreset("sine");
    const path = buildFunctionPath(spec.curves[0], spec);

    expect(path).toContain("M");
    expect(path).toContain("L");
  });

  it("builds an SVG path for x=f(y) curves", () => {
    const spec = createGraph2DSpecPreset("line");
    const path = buildFunctionPath(
      {
        ...spec.curves[0],
        mode: "xOfY",
        expr: "y^2",
        label: "x = y^2",
      },
      spec,
    );

    expect(path).toContain("M");
    expect(path).toContain("L");
  });

  it("builds an SVG path for parametric curves", () => {
    const spec = createGraph2DSpecPreset("parametric");
    const path = buildFunctionPath(spec.curves[0], spec);

    expect(path).toContain("M");
    expect(path).toContain("L");
  });

  it("extends a curve to the edge of its domain", () => {
    // sqrt(4 - x^2) の定義域端 x=±2 はサンプル格子 (6/220 刻み) に載らない。
    // 補完しないと弧が x軸の 11px 手前で途切れ、塗りつぶしとの見た目がズレる。
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-3",
        xMax: "3",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          expr: "sqrt(4 - x^2)",
          samples: 220,
        },
      ],
    };
    const path = buildFunctionPath(spec.curves[0], spec);
    const xCoordinates = [...path.matchAll(/[ML]([0-9.-]+) /g)].map((match) => Number(match[1]));
    const yCoordinates = [...path.matchAll(/[ML][0-9.-]+ ([0-9.-]+)/g)].map((match) => Number(match[1]));

    // 描画域 496x248、原点 (0,0) は (294, 142)。定義域端 x=±2 は 128.667 / 459.333
    expect(Math.min(...xCoordinates)).toBeCloseTo(128.667, 1);
    expect(Math.max(...xCoordinates)).toBeCloseTo(459.333, 1);
    expect(Math.max(...yCoordinates)).toBeCloseTo(142, 1);
  });

  it("does not bridge a pole when extending to the domain edge", () => {
    // 1/x は x=0 で未定義。定義域端の補完が極を越えて2つの分枝をつないではならない。
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-3",
        xMax: "3",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          expr: "1/x",
          samples: 220,
        },
      ],
    };
    const path = buildFunctionPath(spec.curves[0], spec);
    const yCoordinates = [...path.matchAll(/[ML][0-9.eE+-]+ ([0-9.eE+-]+)/g)].map((match) => Number(match[1]));

    expect((path.match(/M/g) ?? []).length).toBe(2);
    // 分枝は漸近線へ寄る線としてフレーム (y = 18..266) の外まで伸びる。
    // clipPath で切られてフレーム端まで描かれ、塗りつぶしの境界と一致する。
    expect(Math.min(...yCoordinates)).toBeLessThan(18);
    expect(Math.max(...yCoordinates)).toBeGreaterThan(266);
  });

  it("splits a diverging curve at values outside the sampling window", () => {
    // tan(x) は漸近線の直前後で窓 (±8スパン) の外へ飛ぶ。窓外の点を描くと
    // 漸近線をまたぐ偽の縦線になるため、そこでサブパスを切る。
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "-3",
        yMax: "3",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          expr: "tan(x)",
          samples: 220,
        },
      ],
    };
    const path = buildFunctionPath(spec.curves[0], spec);

    expect((path.match(/M/g) ?? []).length).toBe(3);
  });

  it("builds no path for a parametric curve without a y expression", () => {
    const base = createGraph2DSpecPreset("parametric");
    const path = buildFunctionPath({ ...base.curves[0], yExpr: "  " }, base);

    expect(path).toBe("");
  });

  it("builds an SVG path for implicit curves", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-5",
        xMax: "5",
        yMin: "-5",
        yMax: "5",
      },
      curves: [
        {
          id: "curve_implicit",
          expr: "x^2 - y^2 - 2*y",
          exprTex: "x^{2}-y^{2}-2y",
          label: "x^{2}-y^{2}-2y = 0",
          color: "#0d0d0d",
          mode: "implicit" as const,
          samples: 80,
        },
      ],
    };
    const path = buildFunctionPath(spec.curves[0], spec);

    expect(path).toContain("M");
    expect(path).toContain("L");
    expect((path.match(/M/g) ?? []).length).toBeGreaterThan(5);
  });

  it("builds an SVG path for implicit equations with nonzero right-hand sides", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-5",
        xMax: "9",
        yMin: "-5",
        yMax: "5",
      },
      curves: [
        {
          id: "curve_implicit_nonzero",
          expr: "x^2 - 4*x + y^2 = 22",
          exprTex: "x^{2}-4x+y^{2}=22",
          label: "x^{2}-4x+y^{2}=22",
          color: "#0d0d0d",
          mode: "implicit" as const,
          samples: 90,
        },
      ],
    };
    const path = buildFunctionPath(spec.curves[0], spec);

    expect(path).toContain("M");
    expect(path).toContain("L");
  });

  it("formats parametric curve labels as two-line cases", () => {
    expect(makeGraphCurveLabel("parametric", "cos(t)", "sin(t)")).toBe(
      "\\begin{cases} x = cos(t) \\\\ y = sin(t) \\end{cases}",
    );
    expect(formatGraphCurveLabel(createGraph2DSpecPreset("parametric").curves[0])).toBe(
      "\\begin{cases} x = \\cos(t) \\\\ y = \\sin(t) \\end{cases}",
    );
  });

  it("formats implicit curve labels as equations equal to zero", () => {
    expect(makeGraphCurveLabel("implicit", "x^{2}-y^{2}-2y")).toBe("x^{2}-y^{2}-2y = 0");
    expect(makeGraphCurveLabel("implicit", "x^{2}-4x+y^{2}=22")).toBe("x^{2}-4x+y^{2}=22");
  });

  it("splits expression input text by the graph variable", () => {
    expect(getGraphExpressionVariableSegments("2x + \\max(x, 1)", "x")).toEqual([
      { text: "2", isVariable: false },
      { text: "x", isVariable: true },
      { text: " + \\max(", isVariable: false },
      { text: "x", isVariable: true },
      { text: ", 1)", isVariable: false },
    ]);
    expect(getGraphExpressionVariableSegments("cos(t)+theta", "t")).toEqual([
      { text: "cos(", isVariable: false },
      { text: "t", isVariable: true },
      { text: ")+theta", isVariable: false },
    ]);
  });

  it("parses pi-based ranges and labels", () => {
    const spec = createGraph2DSpecPreset("sine");
    const range = getGraphNumericRange(spec);

    expect(range.xMin).toBeCloseTo(-2 * Math.PI);
    expect(range.xMax).toBeCloseTo(2 * Math.PI);
    expect(formatTickLabel(Math.PI / 2, "pi")).toBe("π/2");
    expect(formatTickLabel(-Math.PI, "pi")).toBe("-π");
  });

  it("uses the axis range as the graph display range by default", () => {
    const spec = createGraph2DSpecPreset("line");

    expect(getGraphDisplayRange(spec)).toEqual(getGraphNumericRange(spec));
  });

  it("fits the display range to evaluable curves and points", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = {
      ...base,
      viewBox: {
        xMin: "-1",
        xMax: "1",
        yMin: "-1",
        yMax: "1",
      },
      graphViewBox: {
        xMin: "-1",
        xMax: "1",
        yMin: "-1",
        yMax: "1",
      },
      curves: [
        {
          ...base.curves[0],
          expr: "x^2 + 5",
        },
      ],
      points: [
        {
          id: "point_outside",
          x: "2",
          y: "8",
          label: "A",
          color: "#0d0d0d",
        },
      ],
    };

    const fitted = fitGraphViewBoxToCurves(spec);
    const range = getGraphDisplayRange(fitted);

    expect(fitted.graphViewBox).toBeUndefined();
    expect(range.xMin).toBeLessThan(-1);
    expect(range.xMax).toBeGreaterThan(2);
    expect(range.yMin).toBeLessThan(5);
    expect(range.yMax).toBeGreaterThan(8);
    expect(buildFunctionPath(fitted.curves[0], fitted)).toContain("M");
  });

  it("does not fit the display range when no curve can be evaluated", () => {
    const base = createGraph2DSpecPreset("line");
    const spec = {
      ...base,
      curves: [{ ...base.curves[0], expr: "sin(" }],
    };

    expect(fitGraphViewBoxToCurves(spec)).toBe(spec);
  });

  it("samples curves from the graph display range and curve domain intersection", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      graphViewBox: {
        xMin: "-2",
        xMax: "2",
        yMin: "-4",
        yMax: "4",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          expr: "0",
          domain: {
            min: "-1",
            max: "3",
          },
          samples: 4,
        },
      ],
    };
    const path = buildFunctionPath(spec.curves[0], spec);
    const xCoordinates = [...path.matchAll(/[ML]([0-9.-]+) /g)].map((match) => Number(match[1]));

    expect(xCoordinates[0]).toBeCloseTo(232);
    expect(xCoordinates[xCoordinates.length - 1]).toBeCloseTo(418);
  });

  it("reports invalid graph specs", () => {
    const spec = createGraph2DSpecPreset("quadratic");
    spec.curves[0] = {
      ...spec.curves[0],
      expr: "sin(",
    };

    // **文言ではなくコード**で固定する。文章で固定すると訳した瞬間に落ちる。
    expect(getGraphIssues(spec, "graph_bad")).toContainEqual(
      { code: "curveEvaluate", nodeId: "graph_bad", targetId: "curve_quadratic" },
    );
  });

  it("reports invalid graph display ranges", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      graphViewBox: {
        xMin: "2",
        xMax: "-2",
        yMin: "-4",
        yMax: "4",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
        },
      ],
    };

    expect(getGraphIssues(spec, "graph_bad_range")).toContainEqual(
      { code: "graphRange", nodeId: "graph_bad_range" },
    );
  });

  it("reports invalid curve domains", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          domain: {
            min: "3",
            max: "1",
          },
        },
      ],
    };

    expect(getGraphIssues(spec, "graph_bad_domain")).toContainEqual(
      { code: "curveDomain", nodeId: "graph_bad_domain", targetId: "curve_line" },
    );
  });

  it("reports invalid x=f(y) expressions against the y variable", () => {
    const spec = createGraph2DSpecPreset("line");
    spec.curves[0] = {
      ...spec.curves[0],
      mode: "xOfY",
      expr: "x^2",
      label: "x = x^2",
    };

    expect(getGraphIssues(spec, "graph_bad_y")).toContainEqual(
      { code: "curveEvaluate", nodeId: "graph_bad_y", targetId: "curve_line" },
    );
  });

  it("reports invalid parametric expressions against the t variable", () => {
    const spec = createGraph2DSpecPreset("parametric");
    spec.curves[0] = {
      ...spec.curves[0],
      yExpr: "x^2",
    };

    expect(getGraphIssues(spec, "graph_bad_t")).toContainEqual(
      { code: "curveEvaluate", nodeId: "graph_bad_t", targetId: "curve_parametric_circle" },
    );
  });

  it("reports invalid fill regions", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      fills: [
        {
          id: "fill_bad",
          x: "sin(",
          y: "0",
          opacity: 2,
        },
      ],
    };

    expect(getGraphIssues(spec, "graph_bad_fill")).toContainEqual(
      { code: "fillCoordinates", nodeId: "graph_bad_fill", targetId: "fill_bad" },
    );
    expect(getGraphIssues(spec, "graph_bad_fill")).toContainEqual(
      { code: "fillOpacity", nodeId: "graph_bad_fill", targetId: "fill_bad" },
    );
  });

  it("moves the origin by rewriting the visible range", () => {
    const spec = createGraph2DSpecPreset("line");
    const moved = moveGraphOriginToRatios(spec, 0.25, 0.75);
    const range = getGraphNumericRange(moved);

    expect(range.xMin).toBeCloseTo(-2);
    expect(range.xMax).toBeCloseTo(6);
    expect(range.yMin).toBeCloseTo(-2);
    expect(range.yMax).toBeCloseTo(6);
  });

  it("expands a cropped graph display range when moving the origin", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      graphViewBox: {
        xMin: "0",
        xMax: "2",
        yMin: "0",
        yMax: "2",
      },
    };

    const moved = moveGraphOriginToRatios(spec, 0.5, 0.5);

    expect(moved.graphViewBox).toBeUndefined();
    expect(getGraphDisplayRange(moved)).toEqual(getGraphNumericRange(moved));
  });

  it("crops the graph spec to an SVG box and resizes to the cropped plot", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-5",
        xMax: "5",
        yMin: "-5",
        yMax: "5",
      },
    };
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const topLeft = mapGraphPoint(-2, 2, range, spec, plotBox);
    const bottomRight = mapGraphPoint(2, -2, range, spec, plotBox);
    const cropBox = {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };

    const cropped = cropGraphSpecToSvgBox(spec, cropBox, { resizeToCrop: true });

    expect(cropped).not.toBeNull();
    expect(cropped?.viewBox).toEqual({ xMin: "-2", xMax: "2", yMin: "-2", yMax: "2" });
    expect(cropped?.graphViewBox).toBeUndefined();
    expect(cropped?.width).toBeCloseTo(cropBox.width + plotBox.left + plotBox.right);
    expect(cropped?.height).toBeCloseTo(cropBox.height + plotBox.top + plotBox.bottom);
  });

  it("preserves the axis-to-graph display range difference while cropping", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-5",
        xMax: "5",
        yMin: "-5",
        yMax: "5",
      },
      graphViewBox: {
        xMin: "-4",
        xMax: "4",
        yMin: "-4",
        yMax: "4",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          domain: {
            min: "-3",
            max: "3",
          },
        },
      ],
    };
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const topLeft = mapGraphPoint(-2, 2, range, spec, plotBox);
    const bottomRight = mapGraphPoint(2, -2, range, spec, plotBox);

    const cropped = cropGraphSpecToSvgBox(spec, {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    });

    expect(cropped).not.toBeNull();
    expect(cropped?.viewBox).toEqual({ xMin: "-3", xMax: "3", yMin: "-3", yMax: "3" });
    expect(cropped?.graphViewBox).toEqual({ xMin: "-2", xMax: "2", yMin: "-2", yMax: "2" });
    expect(cropped?.curves[0].domain).toEqual({ min: "-1", max: "1" });
  });

  it("keeps shifted curve domains even when the resulting interval is inverted", () => {
    const spec = {
      ...createGraph2DSpecPreset("line"),
      viewBox: {
        xMin: "-1",
        xMax: "11",
        yMin: "-5",
        yMax: "5",
      },
      graphViewBox: {
        xMin: "0",
        xMax: "10",
        yMin: "-4",
        yMax: "4",
      },
      curves: [
        {
          ...createGraph2DSpecPreset("line").curves[0],
          domain: {
            min: "9",
            max: "11",
          },
        },
      ],
    };
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const topLeft = mapGraphPoint(0, 2, range, spec, plotBox);
    const bottomRight = mapGraphPoint(0.5, -2, range, spec, plotBox);

    const cropped = cropGraphSpecToSvgBox(spec, {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    });

    expect(cropped).not.toBeNull();
    expect(cropped?.graphViewBox).toEqual({ xMin: "0", xMax: "0.5", yMin: "-2", yMax: "2" });
    expect(cropped?.curves[0].domain).toEqual({ min: "9", max: "1.5" });
  });
});
