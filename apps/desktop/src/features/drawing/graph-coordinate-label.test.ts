import { describe, expect, it } from "vitest";
import type { GraphCurve } from "@/features/document";
import { formatGraphCurveLabel } from "./graph-coordinate-label";

describe("graph formula label display", () => {
  it.each([
    { curve: { expr: "s*x", exprTex: "sx" }, tex: "y = sx" },
    { curve: { expr: "(x^2)/(2)", exprTex: "\\frac{x^{2}}{2}" }, tex: "y = \\frac{x^{2}}{2}" },
    { curve: { mode: "xOfY", expr: "s*y", exprTex: "sy" }, tex: "x = sy" },
    { curve: { mode: "implicit", expr: "x^2+y^2-(s^2)", exprTex: "x^{2}+y^{2}=s^{2}" }, tex: "x^{2}+y^{2}=s^{2}" },
    { curve: { mode: "implicit", expr: "x^2-y", exprTex: "x^{2}-y" }, tex: "x^{2}-y = 0" },
    {
      curve: { mode: "parametric", expr: "s*cos(t)", exprTex: "s\\cos t", yExpr: "s*sin(t)", yExprTex: "s\\sin t" },
      tex: "\\begin{cases} x = s\\cos t \\\\ y = s\\sin t \\end{cases}",
    },
    { curve: { expr: "5*x+sin(x)", exprTex: " " }, tex: "y = 5 x + \\sin\\left(x\\right)" },
    {
      curve: { mode: "parametric", expr: "cos(t)", yExpr: "sin(t)" },
      tex: "\\begin{cases} x = \\cos\\left(t\\right) \\\\ y = \\sin\\left(t\\right) \\end{cases}",
    },
  ] satisfies { curve: Pick<GraphCurve, "expr" | "exprTex" | "yExpr" | "yExprTex" | "mode">; tex: string }[])(
    "uses display math for $curve.expr without modifying the evaluation expression",
    ({ curve, tex }) => {
      const before = JSON.stringify(curve);
      expect(formatGraphCurveLabel(curve)).toBe(tex);
      expect(JSON.stringify(curve)).toBe(before);
    },
  );

  it("preserves custom labels and legacy parametric labels", () => {
    expect(formatGraphCurveLabel({ expr: "s*x", exprTex: "sx", label: "f(x)" })).toBe("f(x)");
    expect(formatGraphCurveLabel({ mode: "parametric", expr: "cos(t)", yExpr: "sin(t)", label: "x = a, y = b" }))
      .toBe("\\begin{cases} x = a \\\\ y = b \\end{cases}");
  });
});
