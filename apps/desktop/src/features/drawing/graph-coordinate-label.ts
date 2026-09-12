import type { Graph2DSpec, GraphCurve } from "@/features/document";
import { DEFAULT_GRAPH_PLOT_BOX, type GraphPlotBox } from "./graph-layout";
interface GraphNumericRange { xMin: number; xMax: number; yMin: number; yMax: number; }

export function mapGraphPoint(
  xValue: number,
  yValue: number,
  range: GraphNumericRange,
  spec: Graph2DSpec,
  plotBox: GraphPlotBox = DEFAULT_GRAPH_PLOT_BOX,
): { x: number; y: number } {
  const width = spec.width - plotBox.left - plotBox.right;
  const height = spec.height - plotBox.top - plotBox.bottom;
  return {
    x: plotBox.left + ((xValue - range.xMin) / (range.xMax - range.xMin)) * width,
    y: plotBox.top + ((range.yMax - yValue) / (range.yMax - range.yMin)) * height,
  };
}

export function formatGraphCurveLabel(curve: Pick<GraphCurve, "expr" | "label" | "mode" | "yExpr">): string {
  const mode = curve.mode ?? "yOfX";
  if (mode === "parametric") {
    const expressions = getParametricGraphCurveLabelExpressions(curve);
    return makeParametricGraphCurveLabel(expressions.xExpr, expressions.yExpr);
  }

  const label = curve.label?.trim();
  if (label) {
    return label;
  }

  if (mode === "implicit") {
    return curve.expr.includes("=") ? curve.expr : curve.expr + " = 0";
  }

  return (mode === "xOfY" ? "x = " : "y = ") + curve.expr;
}

export function makeParametricGraphCurveLabel(xExpr: string, yExpr: string): string {
  return "\\begin{cases} x = " + xExpr + " \\\\ y = " + yExpr + " \\end{cases}";
}

export function getParametricGraphCurveLabelExpressions(
  curve: Pick<GraphCurve, "expr" | "label" | "yExpr">,
): { xExpr: string; yExpr: string } {
  const parsed = parseParametricGraphCurveLabel(curve.label?.trim() ?? "");
  return parsed ?? { xExpr: curve.expr, yExpr: curve.yExpr ?? "" };
}

export function parseParametricGraphCurveLabel(label: string): { xExpr: string; yExpr: string } | null {
  if (!label) {
    return null;
  }

  const casesMatch = label.match(/^\\begin\{cases\}\s*x\s*=\s*(.*?)\s*\\\\\s*y\s*=\s*(.*?)\s*\\end\{cases\}$/);
  if (casesMatch) {
    return { xExpr: casesMatch[1].trim(), yExpr: casesMatch[2].trim() };
  }

  const inlineMatch = label.match(/^x\s*=\s*(.*?)\s*,\s*y\s*=\s*(.*?)$/);
  if (inlineMatch) {
    return { xExpr: inlineMatch[1].trim(), yExpr: inlineMatch[2].trim() };
  }

  return null;
}

export function axisX(range: { xMin: number; xMax: number; yMin: number; yMax: number }, spec: Graph2DSpec, plotBox: GraphPlotBox): number {
  if (range.xMin <= 0 && range.xMax >= 0) {
    return mapGraphPoint(0, 0, range, spec, plotBox).x;
  }

  return plotBox.left;
}

export function axisY(range: { yMin: number; yMax: number }, spec: Graph2DSpec, plotBox: GraphPlotBox): number {
  if (range.yMin <= 0 && range.yMax >= 0) {
    return mapGraphPoint(0, 0, { ...range, xMin: 0, xMax: 1 }, spec, plotBox).y;
  }

  return spec.height - plotBox.bottom;
}

export function intersectGraphRanges(
  a: { xMin: number; xMax: number; yMin: number; yMax: number },
  b: { xMin: number; xMax: number; yMin: number; yMax: number },
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  const xMin = Math.max(a.xMin, b.xMin);
  const xMax = Math.min(a.xMax, b.xMax);
  const yMin = Math.max(a.yMin, b.yMin);
  const yMax = Math.min(a.yMax, b.yMax);
  if (xMin >= xMax || yMin >= yMax) {
    return null;
  }

  return { xMin, xMax, yMin, yMax };
}
