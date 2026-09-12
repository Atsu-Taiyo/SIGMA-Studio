import { describe, expect, it } from "vitest";

import {
  formatGraphPointTex,
  formatGraphRangeTex,
  graphExpressionToTex,
  parseGraphImplicitEquationTex,
  parseGraphPointTex,
  parseGraphRangeTex,
  texToGraphExpression,
  texToGraphExpressionWithError,
} from "@/lib/graph-tex";
import { evaluateExpression, evaluateImplicitExpression, evaluateScalar } from "@/lib/graph2d";

describe("texToGraphExpression", () => {
  it("converts basic arithmetic and powers", () => {
    expect(texToGraphExpression("x^2-5x+6")).toBe("x^2-5*x+6");
    expect(texToGraphExpression("2x+1")).toBe("2*x+1");
    expect(texToGraphExpression("x^{10}")).toBe("x^10");
  });

  /**
   * 保存された評価式はそのまま人の目に触れる: 表示用 TeX を作れない場面ではこの文字列が
   * 数式として描かれるので、`x^2` が `(x)²` と表示されていた。AI が読む文字列も同じ。
   */
  it("adds a paren only where dropping it would change the reading", () => {
    for (const [tex, expected] of [
      ["x^2", "x^2"],
      ["2x^2", "2*x^2"],
      ["x^2+y^2", "x^2+y^2"],
      ["-x^2", "-x^2"],
      ["\\sin(x)^2", "sin(x)^2"],
      ["\\frac{1}{2}x^2", "1/2*x^2"],
      ["\\frac{x^2}{y^2}", "x^2/y^2"],
      ["\\cos(2x)", "cos(2*x)"],
      // ここから先は外すと読み方が変わるので残る。
      ["(x+1)^2", "(x+1)^2"],
      ["e^{-x^2}", "e^(-x^2)"],
      ["x^{\\frac{1}{2}}", "x^(1/2)"],
      ["\\frac{a}{bc}", "a/(b*c)"],
      ["\\frac{1}{x+1}", "1/(x+1)"],
    ] as const) {
      expect(`${tex} -> ${texToGraphExpression(tex)}`).toBe(`${tex} -> ${expected}`);
    }
  });

  /** 同じ式を入力し直すたびに括弧が一段ずつ増える、ということが起きない。 */
  it("reaches a fixed point after one round trip", () => {
    for (const tex of ["x^2+y^2", "\\sin(x)^2", "\\frac{x+1}{x-1}", "\\sqrt[3]{x}", "-2x^3"]) {
      const once = texToGraphExpression(tex) ?? "";
      const twice = texToGraphExpression(graphExpressionToTex(once)) ?? "";
      expect(`${tex}: ${twice}`).toBe(`${tex}: ${once}`);
    }
  });

  it("converts fractions, roots and pi", () => {
    expect(texToGraphExpression("\\frac{3}{2}")).toBe("3/2");
    expect(texToGraphExpression("-\\frac{x+1}{2}")).toBe("-(x+1)/2");
    expect(texToGraphExpression("\\sqrt{2}")).toBe("sqrt(2)");
    expect(texToGraphExpression("\\sqrt[3]{x}")).toBe("x^(1/3)");
    expect(texToGraphExpression("2\\pi")).toBe("2*pi");
    expect(texToGraphExpression("\\frac{\\pi}{2}")).toBe("pi/2");
  });

  it("converts trigonometric and logarithmic functions", () => {
    expect(texToGraphExpression("\\sin x")).toBe("sin(x)");
    expect(texToGraphExpression("\\cos\\left(2x\\right)")).toBe("cos(2*x)");
    expect(texToGraphExpression("\\sin 2\\pi")).toBe("sin(2*pi)");
    expect(texToGraphExpression("\\sin^{2}x")).toBe("sin(x)^2");
    expect(texToGraphExpression("\\ln x + \\exp x")).toBe("ln(x)+exp(x)");
    expect(texToGraphExpression("\\arcsin x")).toBe("asin(x)");
  });

  it("binds a postfix power to the whole function application for parenthesized arguments", () => {
    expect(texToGraphExpression("\\sin\\left(x\\right)^{2}")).toBe("sin(x)^2");
    expect(texToGraphExpression("\\sin(x)^{2}")).toBe("sin(x)^2");
    expect(texToGraphExpression("\\sin\\left(x\\right)^2")).toBe("sin(x)^2");
    expect(texToGraphExpression("\\cos\\left(2x\\right)^{3}")).toBe("cos(2*x)^3");
    expect(texToGraphExpression("\\ln\\left(x\\right)^{2}")).toBe("ln(x)^2");
    expect(texToGraphExpression("\\operatorname{sin}\\left(x\\right)^{2}")).toBe("sin(x)^2");
    // 前置指数 `\sin^{2}(x)` と同じ式へ正規化される。
    expect(texToGraphExpression("\\sin^{2}\\left(x\\right)")).toBe("sin(x)^2");
  });

  it("evaluates parenthesized function powers as (f(x))^n", () => {
    const squared = texToGraphExpression("\\sin\\left(x\\right)^{2}") ?? "";
    expect(evaluateExpression(squared, 0.3)).toBeCloseTo(Math.sin(0.3) ** 2, 10);
    // 誤変換 sin(x^2) ではないことを明示する。
    expect(evaluateExpression(squared, 0.3)).not.toBeCloseTo(Math.sin(0.3 ** 2), 6);

    const pythagorean = texToGraphExpression("\\sin\\left(x\\right)^{2}+\\cos\\left(x\\right)^{2}") ?? "";
    expect(evaluateExpression(pythagorean, 0.7)).toBeCloseTo(1, 10);
  });

  it("preserves a leading minus outside a parenthesized function power", () => {
    const negated = texToGraphExpression("-\\sin\\left(x\\right)^{2}") ?? "";
    expect(negated).toBe("-sin(x)^2");
    expect(evaluateExpression(negated, 0.3)).toBeCloseTo(-(Math.sin(0.3) ** 2), 10);
  });

  it("keeps the TeX convention for non-parenthesized function arguments", () => {
    expect(texToGraphExpression("\\sin x^{2}")).toBe("sin(x^2)");
    expect(texToGraphExpression("\\sin{x}^{2}")).toBe("sin(x^2)");
    expect(texToGraphExpression("\\sin|x|^{2}")).toBe("sin(abs(x)^2)");
    expect(texToGraphExpression("\\sin\\left|x\\right|^{2}")).toBe("sin(abs(x)^2)");
    expect(texToGraphExpression("\\sin 2\\pi")).toBe("sin(2*pi)");
    expect(texToGraphExpression("\\sin^{2}x")).toBe("sin(x)^2");
  });

  it("handles adjacent factors and malformed delimiters after a function call", () => {
    expect(texToGraphExpression("\\sin\\left(x\\right)\\left(x+1\\right)")).toBe("sin(x)*(x+1)");
    expect(texToGraphExpression("\\sin(x)(x+1)")).toBe("sin(x)*(x+1)");
    expect(texToGraphExpression("\\sin\\left(x\\right|")).toBeNull();
    expect(texToGraphExpression("\\sin\\left|x\\right)")).toBeNull();
    expect(texToGraphExpression("\\sin\\left(")).toBeNull();
    expect(texToGraphExpression("\\sin\\left(x\\right)_1")).toBeNull();
  });

  it("chains repeated exponents on function applications", () => {
    const chained = texToGraphExpression("\\sin^{2}\\left(x\\right)^{3}") ?? "";
    expect(evaluateExpression(chained, 0.3)).toBeCloseTo(Math.sin(0.3) ** 6, 10);
    const nested = texToGraphExpression("\\sin\\left(x\\right)^{2^{3}}") ?? "";
    expect(evaluateExpression(nested, 0.3)).toBeCloseTo(Math.sin(0.3) ** 8, 10);
  });

  it("converts absolute values", () => {
    expect(texToGraphExpression("\\left|x-1\\right|")).toBe("abs(x-1)");
    expect(texToGraphExpression("|x|")).toBe("abs(x)");
  });

  it("converts multiplication operators", () => {
    expect(texToGraphExpression("2\\cdot x")).toBe("2*x");
    expect(texToGraphExpression("2\\times3")).toBe("2*3");
    expect(texToGraphExpression("x\\div2")).toBe("x/2");
  });

  it("produces expressions the graph evaluator can evaluate", () => {
    const expression = texToGraphExpression("\\frac{\\sqrt{2}}{2}\\sin\\left(2x\\right)");
    expect(expression).not.toBeNull();
    const value = evaluateExpression(expression ?? "", Math.PI / 4);
    expect(value).toBeCloseTo(Math.SQRT2 / 2, 10);

    const scalarExpression = texToGraphExpression("-\\frac{3}{2}+\\sqrt{2}");
    expect(evaluateScalar(scalarExpression ?? "")).toBeCloseTo(-1.5 + Math.SQRT2, 10);
  });

  it("rejects unsupported input", () => {
    expect(texToGraphExpression("")).toBeNull();
    expect(texToGraphExpression("x_1")).toBeNull();
    expect(texToGraphExpression("\\placeholder{}")).toBeNull();
    expect(texToGraphExpression("x+")).toBeNull();
    expect(texToGraphExpression("\\int x")).toBeNull();
  });

  it("names the reason with a code, not a sentence", () => {
    // 文言で固定すると訳した瞬間に落ちる。**理由の種別**だけを固定し、
    // 「利用者向けの言い方になっているか」は辞書側のテストが見る。
    expect(texToGraphExpressionWithError("x+")).toEqual({ error: "unparsable" });
    expect(texToGraphExpressionWithError("x=1")).toEqual({ error: "hasEquals" });
    expect(texToGraphExpressionWithError("\\int x")).toEqual({ error: "unsupportedCommand" });
  });
});

describe("parseGraphPointTex", () => {
  it("parses coordinates with and without parens", () => {
    expect(parseGraphPointTex("(1, 2)")).toEqual({ x: "1", y: "2", xTex: "1", yTex: "2" });
    expect(parseGraphPointTex("1, 2")).toEqual({ x: "1", y: "2", xTex: "1", yTex: "2" });
    expect(parseGraphPointTex("\\left(1, 2\\right)")).toEqual({ x: "1", y: "2", xTex: "1", yTex: "2" });
  });

  it("parses fractions, roots and pi coordinates", () => {
    const parsed = parseGraphPointTex("\\left(\\frac{3}{2}, -\\sqrt{2}\\right)");
    expect(parsed).toEqual({
      x: "3/2",
      y: "-sqrt(2)",
      xTex: "\\frac{3}{2}",
      yTex: "-\\sqrt{2}",
    });

    const piPoint = parseGraphPointTex("(\\pi, 0)");
    expect(piPoint?.x).toBe("pi");
  });

  it("keeps commas inside groups intact", () => {
    // 座標区切り以外のカンマ (グループ内) では分割しない。
    expect(parseGraphPointTex("(\\frac{1}{2}, 3)")?.x).toBe("1/2");
  });

  it("rejects invalid coordinate input", () => {
    expect(parseGraphPointTex("(1)")).toBeNull();
    expect(parseGraphPointTex("(1, 2, 3)")).toBeNull();
    expect(parseGraphPointTex("(1, )")).toBeNull();
  });
});

describe("parseGraphRangeTex", () => {
  it("parses full inequality chains", () => {
    expect(parseGraphRangeTex("-2 \\le x \\le 3", "x")).toEqual({ min: "-2", max: "3" });
    expect(parseGraphRangeTex("0 \\le t \\le 2\\pi", "t")).toEqual({ min: "0", max: "2*pi" });
    expect(parseGraphRangeTex("-\\frac{\\pi}{2} \\leq x \\leq \\frac{\\pi}{2}", "x")).toEqual({
      min: "-pi/2",
      max: "pi/2",
    });
  });

  it("parses reversed and strict inequality chains", () => {
    expect(parseGraphRangeTex("3 \\ge x \\ge -2", "x")).toEqual({ min: "-2", max: "3" });
    expect(parseGraphRangeTex("-2 < x < 3", "x")).toEqual({ min: "-2", max: "3" });
  });

  it("parses one-sided ranges", () => {
    expect(parseGraphRangeTex("x \\le 3", "x")).toEqual({ max: "3" });
    expect(parseGraphRangeTex("-2 \\le x", "x")).toEqual({ min: "-2" });
    expect(parseGraphRangeTex("x \\ge -2", "x")).toEqual({ min: "-2" });
  });

  it("rejects ranges that do not reference the variable", () => {
    expect(parseGraphRangeTex("-2 \\le y \\le 3", "x")).toBeNull();
    expect(parseGraphRangeTex("-2 \\le 3", "x")).toBeNull();
    expect(parseGraphRangeTex("x", "x")).toBeNull();
    expect(parseGraphRangeTex("-2 \\le x \\ge 3", "x")).toBeNull();
  });
});

describe("parseGraphImplicitEquationTex", () => {
  it("normalizes equations equal to zero to their left-hand expression", () => {
    expect(parseGraphImplicitEquationTex("x^2-y^2-2y=0")).toEqual({
      expression: "x^2-y^2-2*y",
      tex: "x^2-y^2-2y=0",
    });
  });

  it("normalizes nonzero right-hand sides by subtracting them", () => {
    const parsed = parseGraphImplicitEquationTex("x^2-y^2=2y");

    expect(parsed).toEqual({
      expression: "x^2-y^2-2*y",
      tex: "x^2-y^2=2y",
    });
    expect(evaluateImplicitExpression(parsed?.expression ?? "", 2, 1)).toBeCloseTo(1);
  });

  it("normalizes constant right-hand side equations", () => {
    const parsed = parseGraphImplicitEquationTex("x^2-4x+y^2=22");

    expect(parsed).toEqual({
      expression: "x^2-4*x+y^2-22",
      tex: "x^2-4x+y^2=22",
    });
    expect(evaluateImplicitExpression(parsed?.expression ?? "", 6, Math.sqrt(10))).toBeCloseTo(0);
  });
});

describe("graphExpressionToTex", () => {
  it("renders stored expressions as TeX", () => {
    expect(graphExpressionToTex("x^2 - 5*x + 6")).toBe("x^{2} - 5 x + 6");
    expect(graphExpressionToTex("sin(x)")).toBe("\\sin\\left(x\\right)");
    expect(graphExpressionToTex("2*pi")).toBe("2 \\pi");
    expect(graphExpressionToTex("(3)/(2)")).toBe("\\frac{3}{2}");
    expect(graphExpressionToTex("sqrt(2)")).toBe("\\sqrt{2}");
    expect(graphExpressionToTex("abs(x-1)")).toBe("\\left|x - 1\\right|");
    expect(graphExpressionToTex("-(pi)/(2)")).toBe("-\\frac{\\pi}{2}");
  });

  it("keeps parens for grouped factors", () => {
    expect(graphExpressionToTex("(x+1)^2")).toBe("\\left(x + 1\\right)^{2}");
    expect(graphExpressionToTex("2*(x+1)")).toBe("2 \\left(x + 1\\right)");
  });

  it("round-trips through texToGraphExpression", () => {
    for (const expression of ["x^2 - 5*x + 6", "sin(2*x)", "(3)/(2)", "sqrt(2)*x", "-(pi)/(2)", "sin(x)^2", "cos(2*x)^2"]) {
      const tex = graphExpressionToTex(expression);
      const converted = texToGraphExpression(tex);
      expect(converted).not.toBeNull();
      expect(evaluateExpression(converted ?? "", 0.7)).toBeCloseTo(evaluateExpression(expression, 0.7), 10);
    }
  });

  it("round-trips sin(x)^2 through the display TeX", () => {
    const tex = graphExpressionToTex("sin(x)^2");
    expect(tex).toBe("\\sin\\left(x\\right)^{2}");
    // 読み取ったほうも同じ文字列に戻る。入力し直すたびに括弧が増える形にはしない。
    expect(texToGraphExpression(tex)).toBe("sin(x)^2");
  });

  it("round-trips unary minus and exponent forms with the same value", () => {
    // TeX 側のパーサは元から `-x^2` を `-(x^2)` と読む。評価器を合わせたので、
    // 往復しても意味が変わらないことを固定する。
    for (const [expression, expectedTex] of [
      ["-x^2", "-x^{2}"],
      ["-2^2", "-2^{2}"],
      ["2^-3", "2^{-3}"],
      ["-x^-2", "-x^{-2}"],
      ["2^3^2", "2^{3^{2}}"],
      ["-x^2+3*x", "-x^{2} + 3 x"],
    ] as const) {
      const tex = graphExpressionToTex(expression);
      expect(tex).toBe(expectedTex);
      const converted = texToGraphExpression(tex);
      expect(converted).not.toBeNull();
      expect(evaluateExpression(converted ?? "", 2)).toBeCloseTo(evaluateExpression(expression, 2), 10);
    }
  });

  it("falls back to the raw expression when unparseable", () => {
    expect(graphExpressionToTex("@@")).toBe("@@");
  });
});

describe("format helpers", () => {
  it("formats point TeX preferring stored TeX parts", () => {
    expect(formatGraphPointTex("(3)/(2)", "0")).toBe("(\\frac{3}{2},\\ 0)");
    expect(formatGraphPointTex("1", "2", "\\frac{2}{2}", "2")).toBe("(\\frac{2}{2},\\ 2)");
  });

  it("formats range TeX", () => {
    expect(formatGraphRangeTex("-2", "3", "x")).toBe("-2 \\le x \\le 3");
    expect(formatGraphRangeTex("0", "2*pi", "t")).toBe("0 \\le t \\le 2 \\pi");
    expect(formatGraphRangeTex("-2", undefined, "x")).toBe("-2 \\le x");
    expect(formatGraphRangeTex(undefined, "3", "x")).toBe("x \\le 3");
    expect(formatGraphRangeTex(undefined, undefined, "x")).toBe("");
  });
});
