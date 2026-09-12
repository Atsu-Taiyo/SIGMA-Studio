import { resolveGraph2DParameters, resolveGraphParameterCurve, resolveGraphParameterExpression } from "@/features/rendering/core";
import type  {
  Graph2DPreset,
  Graph2DSpec,
  GraphAnnotation,
  GraphCurve,
  GraphCurveDash,
  GraphCurveMode,
  GraphPoint,
  GraphTickMode,
  GraphViewBox,
} from "@/features/document";
import type { GraphPlotBox } from "@/features/drawing";
import { DEFAULT_GRAPH_PLOT_BOX, evaluateMathEquation, evaluateMathExpression, getGraphPlotBox } from "@/features/drawing";
import { formatGraphCurveLabel, makeParametricGraphCurveLabel, mapGraphPoint } from "@/features/drawing/graph-coordinate-label";
import { isGraphFillPattern } from "@/lib/graph-fill-style";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";
export { formatGraphCurveLabel,mapGraphPoint } from "@/features/drawing/graph-coordinate-label";

export type { Graph2DPreset } from "@/features/document";
export {
DEFAULT_GRAPH_PLOT_BOX,
getGraphPlotBox
} from "@/features/drawing";
export type { GraphPlotBox } from "@/features/drawing";

export interface GraphNumericRange {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphClipBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphSvgCropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GraphSpecChangeMeta {
  source: "crop";
  cropBox: GraphSvgCropBox;
  resizeToCrop: boolean;
}

export type GraphExpressionVariableName = "x" | "y" | "t";
type GraphExpressionVariables = Partial<Record<GraphExpressionVariableName, number>>;

export interface GraphCurveSamplingRange {
  min: number;
  max: number;
  variableName: GraphExpressionVariableName;
}

export interface GraphExpressionVariableSegment {
  text: string;
  isVariable: boolean;
}

export const DEFAULT_GRAPH_ORIGIN_LABEL_TEX = "\\mathrm{O}";

// グラフは白黒印刷を基本とするため、推奨パレットは黒・グレー階調を先頭に置く。
// 曲線の区別は色ではなく線種 (実線・破線・点線) と線幅で付ける設計。
export const GRAPH_COLOR_OPTIONS = [
  { id: "black", value: "#0d0d0d" },
  { id: "gray", value: "#6b7280" },
  { id: "lightGray", value: "#9ca3af" },
  { id: "red", value: "#dc2626" },
  { id: "blue", value: "#2563eb" },
] as const;
export const GRAPH_EXPRESSION_VARIABLE_COLOR = "#0f766e";

export const GRAPH_CURVE_MODE_OPTIONS = [
  { label: "y=f(x)", value: "yOfX" },
  { label: "x=f(y)", value: "xOfY" },
  { label: "x=f(t), y=g(t)", value: "parametric" },
  { label: "f(x,y)=0", value: "implicit" },
] as const satisfies readonly { label: string; value: GraphCurveMode }[];

export const GRAPH_DASH_OPTIONS = [
  { value: "solid" },
  { value: "dashed" },
  { value: "dotted" },
] as const satisfies readonly { value: GraphCurveDash }[];

export const GRAPH_STROKE_WIDTH_OPTIONS = [
  { id: "thin", value: 1.4 },
  { id: "regular", value: 2.4 },
  { id: "bold", value: 3.4 },
  { id: "extraBold", value: 4.6 },
] as const;

const COLOR_FALLBACK = GRAPH_COLOR_OPTIONS[0].value;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_SAMPLES = 800;
const MIN_SAMPLES = 32;
const MAX_IMPLICIT_SAMPLES = 220;
const MIN_IMPLICIT_SAMPLES = 32;
const DEFAULT_IMPLICIT_SAMPLES = 120;
const IMPLICIT_ZERO_EPSILON = 1e-12;
const DEFAULT_CURVE_MODE: GraphCurveMode = "yOfX";
const DEFAULT_CURVE_DASH: GraphCurveDash = "solid";
const DEFAULT_CURVE_STROKE_WIDTH = 2.4;
export const DEFAULT_PARAMETRIC_DOMAIN = { min: "0", max: "2*pi" } as const;

/**
 * グラフの初期値。**`title` は空にする** — 唯一の呼び出し元
 * (`overlay-canvas/shapes/graph.ts` の `createGraphShapeProps`) が必ず `""` で
 * 上書きしており、ここに文言を置いても画面にも文書にも出ないため。
 * プリセットの表示名が要る面は `shape.graphPreset.<preset>` を引く。
 */
export function createGraph2DSpecPreset(preset: Graph2DPreset): Graph2DSpec {
  switch (preset) {
    case "blank":
      return {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 320,
        viewBox: {
          xMin: "-5",
          xMax: "5",
          yMin: "-5",
          yMax: "5",
        },
        axes: {
          grid: false,
          showX: true,
          showY: true,
          showTicks: false,
          xLabel: "x",
          yLabel: "y",
          xTickStep: "1",
          yTickStep: "1",
        },
        curves: [],
      };
    case "cosine":
      return {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 300,
        viewBox: {
          xMin: "-2*pi",
          xMax: "2*pi",
          yMin: "-1.5",
          yMax: "1.5",
        },
        axes: {
          grid: true,
          showX: true,
          showY: true,
          showTicks: true,
          xLabel: "x",
          yLabel: "y",
          xTickStep: "pi/2",
          yTickStep: "0.5",
          xTickMode: "pi",
        },
        curves: [
          {
            id: "curve_cosine",
            expr: "cos(x)",
            exprTex: "\\cos(x)",
            label: "y = \\cos(x)",
            color: GRAPH_COLOR_OPTIONS[0].value,
            mode: DEFAULT_CURVE_MODE,
            dash: DEFAULT_CURVE_DASH,
            strokeWidth: DEFAULT_CURVE_STROKE_WIDTH,
          },
        ],
      };
    case "quadratic":
      return {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 320,
        viewBox: {
          xMin: "-1",
          xMax: "5",
          yMin: "-2",
          yMax: "8",
        },
        axes: {
          grid: true,
          showX: true,
          showY: true,
          showTicks: true,
          xLabel: "x",
          yLabel: "y",
          xTickStep: "1",
          yTickStep: "1",
        },
        curves: [
          {
            id: "curve_quadratic",
            expr: "x^2 - 5*x + 6",
            exprTex: "x^{2}-5x+6",
            label: "y = x^{2}-5x+6",
            color: GRAPH_COLOR_OPTIONS[0].value,
            mode: DEFAULT_CURVE_MODE,
            dash: DEFAULT_CURVE_DASH,
            strokeWidth: DEFAULT_CURVE_STROKE_WIDTH,
          },
        ],
        points: [
          { id: "point_x2", x: "2", y: "0", label: "2", color: "#0d0d0d" },
          { id: "point_x3", x: "3", y: "0", label: "3", color: "#0d0d0d" },
        ],
      };
    case "line":
      return {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 300,
        viewBox: {
          xMin: "-4",
          xMax: "4",
          yMin: "-4",
          yMax: "4",
        },
        axes: {
          grid: true,
          showX: true,
          showY: true,
          showTicks: true,
          xLabel: "x",
          yLabel: "y",
          xTickStep: "1",
          yTickStep: "1",
        },
        curves: [
          {
            id: "curve_line",
            expr: "2*x + 1",
            exprTex: "2x+1",
            label: "y = 2x+1",
            color: GRAPH_COLOR_OPTIONS[0].value,
            mode: DEFAULT_CURVE_MODE,
            dash: DEFAULT_CURVE_DASH,
            strokeWidth: DEFAULT_CURVE_STROKE_WIDTH,
          },
        ],
      };
    case "parametric":
      return {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 360,
        viewBox: {
          xMin: "-1.5",
          xMax: "1.5",
          yMin: "-1.5",
          yMax: "1.5",
        },
        axes: {
          grid: true,
          showX: true,
          showY: true,
          showTicks: true,
          xLabel: "x",
          yLabel: "y",
          xTickStep: "0.5",
          yTickStep: "0.5",
        },
        curves: [
          {
            id: "curve_parametric_circle",
            expr: "cos(t)",
            yExpr: "sin(t)",
            exprTex: "\\cos(t)",
            yExprTex: "\\sin(t)",
            label: "x = \\cos(t), y = \\sin(t)",
            color: GRAPH_COLOR_OPTIONS[0].value,
            mode: "parametric",
            dash: DEFAULT_CURVE_DASH,
            strokeWidth: DEFAULT_CURVE_STROKE_WIDTH,
            domain: { ...DEFAULT_PARAMETRIC_DOMAIN },
          },
        ],
      };
    case "numberLine":
      return {
        kind: "numberLine",
        title: "",
        width: 560,
        height: 150,
        viewBox: {
          xMin: "0",
          xMax: "5",
          yMin: "-1",
          yMax: "1",
        },
        axes: {
          grid: false,
          showX: true,
          showY: false,
          showTicks: true,
          xLabel: "x",
          xTickStep: "1",
        },
        curves: [],
        points: [
          { id: "point_solution_2", x: "2", y: "0", label: "x = 2", color: "#0d0d0d" },
          { id: "point_solution_3", x: "3", y: "0", label: "x = 3", color: "#0d0d0d" },
        ],
      };
    case "sine":
    default:
      return {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 300,
        viewBox: {
          xMin: "-2*pi",
          xMax: "2*pi",
          yMin: "-1.5",
          yMax: "1.5",
        },
        axes: {
          grid: true,
          showX: true,
          showY: true,
          showTicks: true,
          xLabel: "x",
          yLabel: "y",
          xTickStep: "pi/2",
          yTickStep: "0.5",
          xTickMode: "pi",
        },
        curves: [
          {
            id: "curve_sine",
            expr: "sin(x)",
            exprTex: "\\sin(x)",
            label: "y = \\sin(x)",
            color: GRAPH_COLOR_OPTIONS[0].value,
            mode: DEFAULT_CURVE_MODE,
            dash: DEFAULT_CURVE_DASH,
            strokeWidth: DEFAULT_CURVE_STROKE_WIDTH,
          },
        ],
      };
  }
}

export function getGraphNumericRange(spec: Graph2DSpec): GraphNumericRange {
  return parseGraphViewBox(resolveGraph2DParameters(spec).viewBox);
}

export function getGraphDisplayRange(spec: Graph2DSpec): GraphNumericRange {
  const resolved = resolveGraph2DParameters(spec);
  return parseGraphViewBox(resolved.graphViewBox ?? resolved.viewBox);
}

export function getGraphDisplayClipBox(spec: Graph2DSpec, plotBox = DEFAULT_GRAPH_PLOT_BOX): GraphClipBox {
  const axisRange = getGraphNumericRange(spec);
  const displayRange = getGraphDisplayRange(spec);
  const clipRange = intersectGraphRanges(axisRange, displayRange);
  if (!clipRange) {
    return { x: plotBox.left, y: plotBox.top, width: 0, height: 0 };
  }

  const topLeft = mapGraphPoint(clipRange.xMin, clipRange.yMax, axisRange, spec, plotBox);
  const bottomRight = mapGraphPoint(clipRange.xMax, clipRange.yMin, axisRange, spec, plotBox);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(0, bottomRight.x - topLeft.x),
    height: Math.max(0, bottomRight.y - topLeft.y),
  };
}

export function cropGraphSpecToSvgBox(
  spec: Graph2DSpec,
  box: GraphSvgCropBox,
  options: { resizeToCrop?: boolean } = {},
): Graph2DSpec | null {
  try {
    const plotBox = getGraphPlotBox(spec);
    const axisRange = getGraphNumericRange(spec);
    const displayRange = getGraphDisplayRange(spec);
    const cropMin = unmapGraphPoint(box.left, box.top + box.height, axisRange, spec, plotBox);
    const cropMax = unmapGraphPoint(box.left + box.width, box.top, axisRange, spec, plotBox);
    const cropRange: GraphNumericRange = {
      xMin: cropMin.x,
      xMax: cropMax.x,
      yMin: cropMin.y,
      yMax: cropMax.y,
    };
    if (!isValidGraphRange(cropRange)) {
      return null;
    }

    const hasSeparateDisplayRange = spec.graphViewBox !== undefined && !areGraphRangesNearlyEqual(axisRange, displayRange);
    const nextAxisRange = hasSeparateDisplayRange
      ? {
        xMin: cropRange.xMin + (axisRange.xMin - displayRange.xMin),
        xMax: cropRange.xMax + (axisRange.xMax - displayRange.xMax),
        yMin: cropRange.yMin + (axisRange.yMin - displayRange.yMin),
        yMax: cropRange.yMax + (axisRange.yMax - displayRange.yMax),
      }
      : cropRange;
    if (!isValidGraphRange(nextAxisRange)) {
      return null;
    }

    const nextPlotBox = getGraphPlotBox(spec);
    const nextSpec: Graph2DSpec = {
      ...spec,
      width: options.resizeToCrop ? Math.max(1, box.width + nextPlotBox.left + nextPlotBox.right) : spec.width,
      height: options.resizeToCrop ? Math.max(1, box.height + nextPlotBox.top + nextPlotBox.bottom) : spec.height,
      viewBox: graphRangeToViewBox(nextAxisRange),
      curves: spec.curves.map((curve) => shiftGraphCurveDomainWithDisplayRange(curve, displayRange, cropRange)),
    };

    if (hasSeparateDisplayRange) {
      nextSpec.graphViewBox = graphRangeToViewBox(cropRange);
    } else {
      delete nextSpec.graphViewBox;
    }

    return nextSpec;
  } catch {
    return null;
  }
}

export function moveGraphOriginToRatios(spec: Graph2DSpec, xRatio: number, yRatio: number): Graph2DSpec {
  const range = getGraphNumericRange(spec);
  const xSpan = range.xMax - range.xMin;
  const ySpan = range.yMax - range.yMin;
  const x = clampRatio(xRatio);
  const y = clampRatio(yRatio);
  const xMin = -xSpan * x;
  const xMax = xSpan * (1 - x);
  const yMin = -ySpan * (1 - y);
  const yMax = ySpan * y;

  const nextSpec: Graph2DSpec = {
    ...spec,
    viewBox: {
      ...spec.viewBox,
      xMin: formatRangeValue(xMin),
      xMax: formatRangeValue(xMax),
      yMin: formatRangeValue(yMin),
      yMax: formatRangeValue(yMax),
    },
  };
  delete nextSpec.graphViewBox;
  return nextSpec;
}

/**
 * プロット領域のピクセル寸法に合わせて y 範囲を再計算し、x/y の単位長
 * (1 あたりのピクセル数) を一致させる (縦横比 1:1)。y の中心は維持する。
 * 数直線では縦方向に意味がないため何もしない。
 */
export function fitGraphViewBoxToSquareUnits(
  spec: Graph2DSpec,
  plotWidth: number,
  plotHeight: number,
): Graph2DSpec {
  if (spec.kind !== "cartesian" || plotWidth <= 0 || plotHeight <= 0) {
    return spec;
  }

  let range: GraphNumericRange;
  try {
    range = getGraphNumericRange(spec);
  } catch {
    return spec;
  }

  const xSpan = range.xMax - range.xMin;
  if (!(xSpan > 0)) {
    return spec;
  }

  const unitPx = plotWidth / xSpan;
  const ySpan = plotHeight / unitPx;
  const yCenter = (range.yMin + range.yMax) / 2;
  const yMin = yCenter - ySpan / 2;
  const yMax = yCenter + ySpan / 2;
  if (nearlyEqual(yMin, range.yMin) && nearlyEqual(yMax, range.yMax)) {
    return spec;
  }

  return {
    ...spec,
    viewBox: {
      ...spec.viewBox,
      yMin: formatRangeValue(yMin),
      yMax: formatRangeValue(yMax),
    },
  };
}

/**
 * 表示範囲を保ったまま単位長が縦横で一致する外枠高さを返す。
 * 範囲が解決できない場合や数直線では null。
 */
export function getGraphHeightForSquareUnits(spec: Graph2DSpec, width: number): number | null {
  if (spec.kind !== "cartesian") {
    return null;
  }

  const plotBox = getGraphPlotBox(spec);
  const plotWidth = width - plotBox.left - plotBox.right;
  if (plotWidth <= 0) {
    return null;
  }

  let range: GraphNumericRange;
  try {
    range = getGraphNumericRange(spec);
  } catch {
    return null;
  }

  const xSpan = range.xMax - range.xMin;
  const ySpan = range.yMax - range.yMin;
  if (!(xSpan > 0) || !(ySpan > 0)) {
    return null;
  }

  return Math.round(plotWidth * (ySpan / xSpan) + plotBox.top + plotBox.bottom);
}

/**
 * グラフの検証結果。**文言ではなくコードで返す。**
 *
 * 以前は日本語の文章を組み立てて返しており、設定パネル側 (`EditorSettings.tsx`) が
 * その文章を**日本語の正規表現で解析し直して**言い換えていた。つまり文言を訳した
 * 瞬間に解析が全て外れ、利用者向けの言い換えが黙って効かなくなる作りだった
 * (WI-5 の `=== "改段"` と同型の地雷)。コードで返せば、表示言語も言い換えも
 * 辞書 (`shape.graphIssue.*`) の担当になる。
 */
export interface GraphIssue {
  code: GraphIssueCode;
  /** どの要素で起きたか。`nodeId` はグラフ、それ以外は曲線 / 点 / 注釈 / 塗りの id。 */
  nodeId: string;
  targetId?: string;
}

export type GraphIssueCode =
  | "width"
  | "height"
  | "axisRange"
  | "graphRange"
  | "curveColor"
  | "curveMode"
  | "curveMissingXExpr"
  | "curveMissingYExpr"
  | "curveMissingExpr"
  | "curveDash"
  | "curveStrokeWidth"
  | "curveDomain"
  | "curveEvaluate"
  | "pointCoordinates"
  | "pointColor"
  | "annotationCoordinates"
  | "fillCartesianOnly"
  | "fillCoordinates"
  | "fillColor"
  | "fillPattern"
  | "fillOpacity";

/** 既定ロケールの解決器。呼ぶたびに `getFixedT` を作らないよう module 直下に置く。 */
const DEFAULT_SHAPE_TRANSLATE = createTranslator(DEFAULT_LOCALE, "shape");

/**
 * 検証結果を人間が読める一文にする。
 *
 * **`withTarget` は既定 false。** 曲線 id は `curve_<uuid>` なので、設定パネルに出しても
 * 利用者はどの行のことか分からない (旧経路も、id を正規表現で捕獲したうえで
 * **意図的に捨てて**いた)。一方 AI は id で対象を特定して直せるので、AI へ返すときだけ
 * 付ける。`t` の既定が日本語なのは、AI へ返す文面を変えないため。
 */
export function formatGraphIssue(
  issue: GraphIssue,
  t: Translate<"shape"> = DEFAULT_SHAPE_TRANSLATE,
  { withTarget = false }: { withTarget?: boolean } = {},
): string {
  const message = t(`graphIssue.${issue.code}` as never) as unknown as string;
  return withTarget && issue.targetId
    ? t("graphIssue.withTarget", { message, target: issue.targetId }) as unknown as string
    : message;
}

export function formatGraphWarning(
  code: GraphWarningCode,
  t: Translate<"shape"> = DEFAULT_SHAPE_TRANSLATE,
): string {
  return t(`graphWarning.${code}` as never) as unknown as string;
}

export function getGraphIssues(spec: Graph2DSpec, nodeId: string): GraphIssue[] {
  spec = resolveGraph2DParameters(spec);
  const issues: GraphIssue[] = [];

  if (!Number.isFinite(spec.width) || spec.width < 240 || spec.width > 1200) {
    issues.push({ code: "width", nodeId });
  }

  if (!Number.isFinite(spec.height) || spec.height < 120 || spec.height > 900) {
    issues.push({ code: "height", nodeId });
  }

  let axisRange: GraphNumericRange | null = null;
  let graphRange: GraphNumericRange | null = null;
  try {
    axisRange = getGraphNumericRange(spec);
  } catch {
    issues.push({ code: "axisRange", nodeId });
  }

  if (spec.graphViewBox) {
    try {
      graphRange = getGraphDisplayRange(spec);
    } catch {
      issues.push({ code: "graphRange", nodeId });
    }
  } else {
    graphRange = axisRange;
  }

  for (const curve of spec.curves) {
    const mode = normalizeGraphCurveMode(curve.mode);
    const yExpr = curve.yExpr?.trim() ?? "";

    if (!COLOR_PATTERN.test(curve.color)) {
      issues.push({ code: "curveColor", nodeId, targetId: curve.id });
    }

    if (
      curve.mode !== undefined &&
      curve.mode !== "yOfX" &&
      curve.mode !== "xOfY" &&
      curve.mode !== "parametric" &&
      curve.mode !== "implicit"
    ) {
      issues.push({ code: "curveMode", nodeId, targetId: curve.id });
    }

    if (mode === "parametric") {
      if (!curve.expr.trim()) {
        issues.push({ code: "curveMissingXExpr", nodeId, targetId: curve.id });
      }
      if (!yExpr) {
        issues.push({ code: "curveMissingYExpr", nodeId, targetId: curve.id });
      }
      if (!curve.expr.trim() || !yExpr) {
        continue;
      }
    } else if (!curve.expr.trim()) {
      issues.push({ code: "curveMissingExpr", nodeId, targetId: curve.id });
      continue;
    }

    if (
      curve.dash !== undefined &&
      curve.dash !== "solid" &&
      curve.dash !== "dashed" &&
      curve.dash !== "dotted"
    ) {
      issues.push({ code: "curveDash", nodeId, targetId: curve.id });
    }

    if (
      curve.strokeWidth !== undefined &&
      (!Number.isFinite(curve.strokeWidth) || curve.strokeWidth < 0.5 || curve.strokeWidth > 8)
    ) {
      issues.push({ code: "curveStrokeWidth", nodeId, targetId: curve.id });
    }

    if (graphRange) {
      const samplingRange = resolveGraphCurveSamplingRange(curve, mode, graphRange);
      if (!samplingRange) {
        issues.push({ code: "curveDomain", nodeId, targetId: curve.id });
        continue;
      }

      try {
        const midpoint = (samplingRange.min + samplingRange.max) / 2;
        if (mode === "parametric") {
          evaluateExpression(curve.expr, midpoint, "t");
          evaluateExpression(yExpr, midpoint, "t");
        } else if (mode === "implicit") {
          evaluateImplicitExpression(
            curve.expr,
            (graphRange.xMin + graphRange.xMax) / 2,
            (graphRange.yMin + graphRange.yMax) / 2,
          );
        } else {
          evaluateExpression(curve.expr, midpoint, samplingRange.variableName);
        }
      } catch {
        issues.push({ code: "curveEvaluate", nodeId, targetId: curve.id });
      }
    }
  }

  for (const point of spec.points ?? []) {
    if (evaluateOptionalScalar(point.x, null) === null || evaluateOptionalScalar(point.y, null) === null) {
      issues.push({ code: "pointCoordinates", nodeId, targetId: point.id });
    }
    if (point.color && !COLOR_PATTERN.test(point.color)) {
      issues.push({ code: "pointColor", nodeId, targetId: point.id });
    }
  }

  for (const annotation of spec.annotations ?? []) {
    if (evaluateOptionalScalar(annotation.x, null) === null || evaluateOptionalScalar(annotation.y, null) === null) {
      issues.push({ code: "annotationCoordinates", nodeId, targetId: annotation.id });
    }
  }

  if (spec.kind !== "cartesian" && (spec.fills ?? []).length > 0) {
    issues.push({ code: "fillCartesianOnly", nodeId });
  }

  for (const fill of spec.fills ?? []) {
    if (evaluateOptionalScalar(fill.x, null) === null || evaluateOptionalScalar(fill.y, null) === null) {
      issues.push({ code: "fillCoordinates", nodeId, targetId: fill.id });
    }
    if (fill.color && !COLOR_PATTERN.test(fill.color)) {
      issues.push({ code: "fillColor", nodeId, targetId: fill.id });
    }
    if (fill.pattern !== undefined && !isGraphFillPattern(fill.pattern)) {
      issues.push({ code: "fillPattern", nodeId, targetId: fill.id });
    }
    if (
      fill.opacity !== undefined &&
      (!Number.isFinite(fill.opacity) || fill.opacity < 0 || fill.opacity > 1)
    ) {
      issues.push({ code: "fillOpacity", nodeId, targetId: fill.id });
    }
  }

  return issues;
}

/**
 * Get visibility warnings for a graph (separate from validation errors).
 * These are advisory warnings that don't block graph insertion.
 */
export type GraphWarningCode = "curveOutsideView";

export function getGraphVisibilityWarnings(spec: Graph2DSpec): GraphWarningCode[] {
  const warnings: GraphWarningCode[] = [];

  // Check if any curves are completely clipped outside viewBox
  for (const curve of spec.curves) {
    const expression =
      curve.mode === "parametric" ? curve.expr || curve.yExpr : curve.expr;
    if (expression) {
      try {
        const bounds = getCurveSampleBounds(curve, spec);
        if (bounds && isCurvePathEmptyWithBounds(curve, spec, bounds)) {
          warnings.push("curveOutsideView");
          break;
        }
      } catch {
        // Silently skip visibility checks that fail
      }
    }
  }

  return warnings;
}

export function evaluateScalar(input: string): number {
  return evaluateExpression(input, 0);
}

export function evaluateOptionalScalar(input: string | undefined, fallback: number | null): number | null {
  if (input === undefined || input.trim() === "") {
    return fallback;
  }

  try {
    return evaluateScalar(input);
  } catch {
    return null;
  }
}

export function evaluateExpression(expr: string, value: number, variableName: GraphExpressionVariableName = "x"): number {
  return evaluateExpressionWithVariables(expr, { [variableName]: value });
}

export function evaluateImplicitExpression(expr: string, x: number, y: number): number {
  return evaluateMathEquation(expr, { x, y });
}

function evaluateExpressionWithVariables(expr: string, variables: GraphExpressionVariables): number {
  return evaluateMathExpression(expr, variables);
}

/**
 * Get the actual bounds of sampled curve points.
 * Used to determine if a curve's samples actually intersect the display range.
 */
function getCurveSampleBounds(
  curve: GraphCurve,
  spec: Graph2DSpec,
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  curve = resolveGraphParameterCurve(curve, spec.parameters);
  spec = resolveGraph2DParameters(spec);
  try {
    const graphRange = getGraphDisplayRange(spec);
    const mode = normalizeGraphCurveMode(curve.mode);

    if (mode === "implicit") {
      // For implicit curves, sample the entire grid
      const xRange = resolveGraphCurveSamplingRange(curve, "implicit", graphRange);
      if (!xRange) return null;
      evaluateImplicitExpression(
        curve.expr,
        (graphRange.xMin + graphRange.xMax) / 2,
        (graphRange.yMin + graphRange.yMax) / 2,
      );
      // Implicit curves sample the entire view range
      return {
        xMin: graphRange.xMin,
        xMax: graphRange.xMax,
        yMin: graphRange.yMin,
        yMax: graphRange.yMax,
      };
    }

    const samplingRange = resolveGraphCurveSamplingRange(curve, mode, graphRange);
    if (!samplingRange) return null;

    const sampleCount = clampInteger(curve.samples ?? 180, MIN_SAMPLES, MAX_SAMPLES);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let hasSample = false;

    for (let index = 0; index <= sampleCount; index += 1) {
      const independentValue =
        samplingRange.min + ((samplingRange.max - samplingRange.min) * index) / sampleCount;
      try {
        let graphPoint: { x: number; y: number };
        if (mode === "parametric") {
          const yExpr = curve.yExpr?.trim();
          if (!yExpr) continue;
          graphPoint = {
            x: evaluateExpression(curve.expr, independentValue, "t"),
            y: evaluateExpression(yExpr, independentValue, "t"),
          };
        } else {
          const dependentValue = evaluateExpression(
            curve.expr,
            independentValue,
            samplingRange.variableName,
          );
          graphPoint =
            mode === "xOfY"
              ? { x: dependentValue, y: independentValue }
              : { x: independentValue, y: dependentValue };
        }

        if (!Number.isFinite(graphPoint.x) || !Number.isFinite(graphPoint.y)) {
          continue;
        }

        hasSample = true;
        minX = Math.min(minX, graphPoint.x);
        maxX = Math.max(maxX, graphPoint.x);
        minY = Math.min(minY, graphPoint.y);
        maxY = Math.max(maxY, graphPoint.y);
      } catch {
        // Skip samples that fail to evaluate
      }
    }

    if (!hasSample) {
      return null;
    }

    return { xMin: minX, xMax: maxX, yMin: minY, yMax: maxY };
  } catch {
    return null;
  }
}

export function fitGraphViewBoxToCurves(spec: Graph2DSpec): Graph2DSpec {
  const curveBounds = spec.curves
    .map((curve) => getCurveSampleBounds(curve, spec))
    .filter((bounds): bounds is GraphNumericRange => bounds !== null);
  if (curveBounds.length === 0) {
    return spec;
  }

  const bounds = curveBounds.reduce<GraphNumericRange>(
    (current, curve) => ({
      xMin: Math.min(current.xMin, curve.xMin),
      xMax: Math.max(current.xMax, curve.xMax),
      yMin: Math.min(current.yMin, curve.yMin),
      yMax: Math.max(current.yMax, curve.yMax),
    }),
    {
      xMin: Infinity,
      xMax: -Infinity,
      yMin: Infinity,
      yMax: -Infinity,
    },
  );

  for (const point of spec.points ?? []) {
    const parsed = parseGraphPoint(point, spec.parameters);
    if (!parsed) {
      continue;
    }
    bounds.xMin = Math.min(bounds.xMin, parsed.x);
    bounds.xMax = Math.max(bounds.xMax, parsed.x);
    bounds.yMin = Math.min(bounds.yMin, parsed.y);
    bounds.yMax = Math.max(bounds.yMax, parsed.y);
  }

  const paddedRange = (min: number, max: number): { min: number; max: number } => {
    const span = max - min;
    const padding = span > 1e-9 ? span * 0.1 : Math.max(Math.abs(min) * 0.1, 1);
    return { min: min - padding, max: max + padding };
  };
  const xRange = paddedRange(bounds.xMin, bounds.xMax);
  const yRange = paddedRange(bounds.yMin, bounds.yMax);
  const nextSpec: Graph2DSpec = {
    ...spec,
    viewBox: graphRangeToViewBox({
      xMin: xRange.min,
      xMax: xRange.max,
      yMin: yRange.min,
      yMax: yRange.max,
    }),
  };
  delete nextSpec.graphViewBox;
  return nextSpec;
}

/** Check if two numeric ranges intersect. */
function rangesIntersect(
  range1: { min: number; max: number },
  range2: { min: number; max: number },
): boolean {
  return range1.min <= range2.max && range2.min <= range1.max;
}

export interface GraphSamplePoint {
  x: number;
  y: number;
}

/** 定義域端の二分探索: 最大反復回数と、独立変数スパンに対する停止幅。 */
const DOMAIN_EDGE_REFINE_ITERATIONS = 40;
const DOMAIN_EDGE_REFINE_RATIO = 1e-9;

/**
 * 定義域端 (sqrt(4 - x^2) の x=±2、sqrt(x) の x=0 など) はサンプル格子に載らないため、
 * 定義域の内 (validValue) と外 (invalidValue) を二分探索して最後の有効点を求める。
 *
 * `evaluate` は「その独立変数で曲線が定義されない (評価例外・非有限)」なら null を返すこと。
 * `shouldStop` に該当する点へ到達したらそこで打ち切る — 極 (1/x の x=0 など) では値が
 * 発散し続けるため、天文学的な座標まで詰めても描画に寄与せず数値的に不安定になる。
 */
export function refineCurveDomainEdge(
  evaluate: (independentValue: number) => GraphSamplePoint | null,
  validValue: number,
  invalidValue: number,
  independentSpan: number,
  shouldStop: (point: GraphSamplePoint) => boolean,
): GraphSamplePoint | null {
  let valid = validValue;
  let invalid = invalidValue;
  let refined: GraphSamplePoint | null = null;
  const stopWidth = Math.abs(independentSpan) * DOMAIN_EDGE_REFINE_RATIO;

  for (let iteration = 0; iteration < DOMAIN_EDGE_REFINE_ITERATIONS; iteration += 1) {
    if (Math.abs(invalid - valid) <= stopWidth) {
      break;
    }

    const middle = (valid + invalid) / 2;
    const point = evaluate(middle);
    if (!point) {
      invalid = middle;
      continue;
    }

    valid = middle;
    refined = point;
    if (shouldStop(point)) {
      break;
    }
  }

  return refined;
}

export function buildFunctionPath(curve: GraphCurve, spec: Graph2DSpec, plotBox = DEFAULT_GRAPH_PLOT_BOX): string {
  curve = resolveGraphParameterCurve(curve, spec.parameters);
  spec = resolveGraph2DParameters(spec);
  try {
    const axisRange = getGraphNumericRange(spec);
    const graphRange = getGraphDisplayRange(spec);
    const mode = normalizeGraphCurveMode(curve.mode);
    const width = spec.width - plotBox.left - plotBox.right;
    const height = spec.height - plotBox.top - plotBox.bottom;
    if (width <= 0 || height <= 0) {
      return "";
    }

    if (mode === "implicit") {
      return buildImplicitFunctionPath(curve, spec, axisRange, graphRange, plotBox);
    }

    const samplingRange = resolveGraphCurveSamplingRange(curve, mode, graphRange);
    if (!samplingRange) {
      return "";
    }

    const sampleCount = clampInteger(curve.samples ?? 180, MIN_SAMPLES, MAX_SAMPLES);
    const ySpan = graphRange.yMax - graphRange.yMin;
    const xSpan = graphRange.xMax - graphRange.xMin;
    const xLimitMin = graphRange.xMin - xSpan * 8;
    const xLimitMax = graphRange.xMax + xSpan * 8;
    const yLimitMin = graphRange.yMin - ySpan * 8;
    const yLimitMax = graphRange.yMax + ySpan * 8;
    const independentSpan = samplingRange.max - samplingRange.min;
    const commands: string[] = [];
    let penDown = false;

    /** 評価に失敗した / 非有限になった場合は null (= その独立変数で曲線は定義されない)。 */
    const evaluatePoint = (independentValue: number): GraphSamplePoint | null => {
      try {
        if (mode === "parametric") {
          const yExpr = curve.yExpr?.trim();
          if (!yExpr) {
            return null;
          }
          const point = {
            x: evaluateExpression(curve.expr, independentValue, "t"),
            y: evaluateExpression(yExpr, independentValue, "t"),
          };
          return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
        }

        const dependentValue = evaluateExpression(curve.expr, independentValue, samplingRange.variableName);
        if (!Number.isFinite(dependentValue)) {
          return null;
        }

        return mode === "xOfY"
          ? { x: dependentValue, y: independentValue }
          : { x: independentValue, y: dependentValue };
      } catch {
        return null;
      }
    };

    const isInsideSamplingWindow = (point: GraphSamplePoint): boolean =>
      point.x >= xLimitMin && point.x <= xLimitMax && point.y >= yLimitMin && point.y <= yLimitMax;

    const emit = (graphPoint: GraphSamplePoint) => {
      const point = mapGraphPoint(graphPoint.x, graphPoint.y, axisRange, spec, plotBox);
      commands.push(`${penDown ? "L" : "M"}${roundCoordinate(point.x)} ${roundCoordinate(point.y)}`);
      penDown = true;
    };

    // 定義域端まで線を伸ばす。塗りつぶし (graph-fill.ts) と同じ補完を使うことで、
    // 「描かれていない部分まで塗られている」ように見えるズレを防ぐ。
    // 窓 (±8スパン) の外へ出る線分の扱いは描画側では変えない — 変えると漸近線に偽の線が引かれる。
    const refineEdge = (validValue: number, invalidValue: number): GraphSamplePoint | null =>
      refineCurveDomainEdge(
        evaluatePoint,
        validValue,
        invalidValue,
        independentSpan,
        (point) => !isInsideSamplingWindow(point),
      );

    let previousDefinedValue: number | null = null;

    for (let index = 0; index <= sampleCount; index += 1) {
      const independentValue = samplingRange.min + (independentSpan * index) / sampleCount;
      const graphPoint = evaluatePoint(independentValue);

      if (!graphPoint) {
        if (previousDefinedValue !== null) {
          // 補完点が窓外でも描く: SVG 側の clipPath がフレームで切るので、極 (1/x の x=0 など)
          // では漸近線へ寄る線としてフレーム端まで描かれ、塗りつぶしの境界と一致する。
          // 「窓外のサンプル同士を直結しない」ガードは触っていないので偽の縦線は出ない。
          const refined = refineEdge(previousDefinedValue, independentValue);
          if (refined) {
            emit(refined);
          }
        }
        previousDefinedValue = null;
        penDown = false;
        continue;
      }

      if (!isInsideSamplingWindow(graphPoint)) {
        previousDefinedValue = independentValue;
        penDown = false;
        continue;
      }

      if (previousDefinedValue === null && index > 0) {
        const previousValue = samplingRange.min + (independentSpan * (index - 1)) / sampleCount;
        const refined = refineEdge(independentValue, previousValue);
        if (refined) {
          emit(refined);
        }
      }

      emit(graphPoint);
      previousDefinedValue = independentValue;
    }

    return commands.join(" ");
  } catch {
    return "";
  }
}

/**
 * Detects if a curve path is empty or completely clipped outside viewBox.
 * Checks both SVG path generation and actual sample bounds vs display range.
 */
export function isCurvePathEmpty(curve: GraphCurve, spec: Graph2DSpec): boolean {
  try {
    const bounds = getCurveSampleBounds(curve, spec);
    if (!bounds) {
      return true; // No valid samples
    }
    return isCurvePathEmptyWithBounds(curve, spec, bounds);
  } catch {
    return false;
  }
}

function isCurvePathEmptyWithBounds(
  curve: GraphCurve,
  spec: Graph2DSpec,
  bounds: GraphNumericRange,
): boolean {
  const path = buildFunctionPath(curve, spec);
  if (path.length === 0) {
    return true;
  }

  const displayRange = getGraphDisplayRange(spec);
  const xIntersects = rangesIntersect(
    { min: bounds.xMin, max: bounds.xMax },
    { min: displayRange.xMin, max: displayRange.xMax },
  );
  const yIntersects = rangesIntersect(
    { min: bounds.yMin, max: bounds.yMax },
    { min: displayRange.yMin, max: displayRange.yMax },
  );
  return !(xIntersects && yIntersects);
}

function buildImplicitFunctionPath(
  curve: GraphCurve,
  spec: Graph2DSpec,
  axisRange: GraphNumericRange,
  graphRange: GraphNumericRange,
  plotBox: GraphPlotBox,
): string {
  const xRange = resolveGraphCurveSamplingRange(curve, "implicit", graphRange);
  if (!xRange) {
    return "";
  }

  const sampleCount = clampInteger(
    curve.samples ?? DEFAULT_IMPLICIT_SAMPLES,
    MIN_IMPLICIT_SAMPLES,
    MAX_IMPLICIT_SAMPLES,
  );
  const grid: ImplicitSamplePoint[][] = [];

  for (let row = 0; row <= sampleCount; row += 1) {
    const y = graphRange.yMin + ((graphRange.yMax - graphRange.yMin) * row) / sampleCount;
    const samples: ImplicitSamplePoint[] = [];
    for (let column = 0; column <= sampleCount; column += 1) {
      const x = xRange.min + ((xRange.max - xRange.min) * column) / sampleCount;
      samples.push({
        x,
        y,
        value: evaluateImplicitSample(curve.expr, x, y),
      });
    }
    grid.push(samples);
  }

  const commands: string[] = [];
  for (let row = 0; row < sampleCount; row += 1) {
    for (let column = 0; column < sampleCount; column += 1) {
      const bottomLeft = grid[row][column];
      const bottomRight = grid[row][column + 1];
      const topRight = grid[row + 1][column + 1];
      const topLeft = grid[row + 1][column];
      const intersections = uniqueImplicitIntersections([
        implicitEdgeIntersection(bottomLeft, bottomRight),
        implicitEdgeIntersection(bottomRight, topRight),
        implicitEdgeIntersection(topRight, topLeft),
        implicitEdgeIntersection(topLeft, bottomLeft),
      ]);

      for (let index = 0; index + 1 < intersections.length; index += 2) {
        const start = mapGraphPoint(intersections[index].x, intersections[index].y, axisRange, spec, plotBox);
        const end = mapGraphPoint(intersections[index + 1].x, intersections[index + 1].y, axisRange, spec, plotBox);
        if (distance(start, end) <= 0.001) {
          continue;
        }
        commands.push(
          `M${roundCoordinate(start.x)} ${roundCoordinate(start.y)} L${roundCoordinate(end.x)} ${roundCoordinate(end.y)}`,
        );
      }
    }
  }

  return commands.join(" ");
}

interface ImplicitSamplePoint {
  x: number;
  y: number;
  value: number;
}

function evaluateImplicitSample(expr: string, x: number, y: number): number {
  try {
    return evaluateImplicitExpression(expr, x, y);
  } catch {
    return Number.NaN;
  }
}

function implicitEdgeIntersection(
  a: ImplicitSamplePoint,
  b: ImplicitSamplePoint,
): { x: number; y: number } | null {
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) {
    return null;
  }

  const aIsZero = Math.abs(a.value) <= IMPLICIT_ZERO_EPSILON;
  const bIsZero = Math.abs(b.value) <= IMPLICIT_ZERO_EPSILON;
  if (aIsZero && bIsZero) {
    return null;
  }
  if (aIsZero) {
    return { x: a.x, y: a.y };
  }
  if (bIsZero) {
    return { x: b.x, y: b.y };
  }
  if ((a.value > 0) === (b.value > 0)) {
    return null;
  }

  const t = a.value / (a.value - b.value);
  if (!Number.isFinite(t) || t < -IMPLICIT_ZERO_EPSILON || t > 1 + IMPLICIT_ZERO_EPSILON) {
    return null;
  }
  const clampedT = Math.min(1, Math.max(0, t));
  return {
    x: a.x + (b.x - a.x) * clampedT,
    y: a.y + (b.y - a.y) * clampedT,
  };
}

function uniqueImplicitIntersections(
  intersections: Array<{ x: number; y: number } | null>,
): Array<{ x: number; y: number }> {
  const unique: Array<{ x: number; y: number }> = [];
  for (const point of intersections) {
    if (!point) {
      continue;
    }
    if (unique.some((current) => Math.abs(current.x - point.x) < 1e-9 && Math.abs(current.y - point.y) < 1e-9)) {
      continue;
    }
    unique.push(point);
  }
  return unique;
}


export function unmapGraphPoint(
  x: number,
  y: number,
  range: GraphNumericRange,
  spec: Graph2DSpec,
  plotBox = DEFAULT_GRAPH_PLOT_BOX,
): { x: number; y: number } {
  const width = spec.width - plotBox.left - plotBox.right;
  const height = spec.height - plotBox.top - plotBox.bottom;
  // Ensure division by zero is handled safely
  const w = width <= 0 ? 1 : width;
  const h = height <= 0 ? 1 : height;
  return {
    x: range.xMin + ((x - plotBox.left) / w) * (range.xMax - range.xMin),
    y: range.yMax - ((y - plotBox.top) / h) * (range.yMax - range.yMin),
  };
}


export function generateTicks(min: number, max: number, requestedStep?: string, maxTicks = 12): number[] {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) {
    return [];
  }

  let step = evaluateOptionalScalar(requestedStep, null);
  if (step === null || step <= 0 || !Number.isFinite(step)) {
    step = chooseNiceStep(span / Math.max(2, maxTicks - 1));
  }

  const ticks: number[] = [];
  const first = Math.ceil((min - 1e-10) / step) * step;
  const limit = Math.min(maxTicks * 5, 80);

  for (let index = 0; index < limit; index += 1) {
    const value = first + step * index;
    if (value > max + step * 1e-6) {
      break;
    }
    if (value >= min - step * 1e-6) {
      ticks.push(roundTick(value));
    }
  }

  return ticks;
}

export function formatTickLabel(value: number, mode: GraphTickMode = "number"): string {
  if (mode === "pi") {
    return formatPiTick(value);
  }

  return formatNumberTick(value);
}

export function formatTickLabelTex(
  value: number,
  mode: GraphTickMode = "number",
  stepStr?: string,
): string {
  if (mode === "pi") {
    return formatPiTickTex(value);
  }

  const denominator = detectFractionDenominator(stepStr);
  if (denominator !== null) {
    return formatRationalTickTex(value, denominator);
  }

  return formatNumberTick(value);
}

export function normalizeGraphColor(color: string | undefined, fallback: string = COLOR_FALLBACK): string {
  return color && COLOR_PATTERN.test(color) ? color : fallback;
}

export function normalizeGraphPaletteColor(color: string | undefined): string {
  const match = GRAPH_COLOR_OPTIONS.find((option) => option.value.toLowerCase() === color?.toLowerCase());
  if (match) {
    return match.value;
  }
  // 任意の色 (ColorPalette から選択) はそのまま尊重し、不正値のみ黒へ倒す。
  return color && COLOR_PATTERN.test(color) ? color.toLowerCase() : COLOR_FALLBACK;
}

export function normalizeGraphCurveMode(mode: GraphCurveMode | undefined): GraphCurveMode {
  if (mode === "xOfY" || mode === "parametric" || mode === "implicit") {
    return mode;
  }

  return DEFAULT_CURVE_MODE;
}

export function normalizeGraphCurveDash(dash: GraphCurveDash | undefined): GraphCurveDash {
  return dash === "dashed" || dash === "dotted" ? dash : DEFAULT_CURVE_DASH;
}

export function normalizeGraphCurveStrokeWidth(strokeWidth: number | undefined): number {
  if (!Number.isFinite(strokeWidth) || strokeWidth === undefined || strokeWidth < 0.5 || strokeWidth > 8) {
    return DEFAULT_CURVE_STROKE_WIDTH;
  }

  return strokeWidth;
}


export function makeGraphCurveLabel(mode: GraphCurveMode | undefined, expr: string, yExpr?: string): string {
  const normalizedMode = normalizeGraphCurveMode(mode);
  if (normalizedMode === "parametric") {
    return makeParametricGraphCurveLabel(expr, yExpr ?? "");
  }
  if (normalizedMode === "implicit") {
    if (expr.includes("=")) {
      return expr;
    }
    return `${expr} = 0`;
  }

  return `${graphCurveFormulaPrefix(normalizedMode)}${expr}`;
}

export function getGraphExpressionVariableSegments(
  expression: string,
  variableName: GraphExpressionVariableName,
): GraphExpressionVariableSegment[] {
  if (!expression) {
    return [{ text: "", isVariable: false }];
  }

  const segments: GraphExpressionVariableSegment[] = [];
  let buffer = "";
  const pushBuffer = () => {
    if (buffer) {
      segments.push({ text: buffer, isVariable: false });
      buffer = "";
    }
  };

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "\\") {
      buffer += char;
      index += 1;
      while (index < expression.length && isAsciiLetter(expression[index])) {
        buffer += expression[index];
        index += 1;
      }
      index -= 1;
      continue;
    }

    const previous = expression[index - 1];
    const next = expression[index + 1];
    if (char === variableName && !isAsciiLetter(previous) && !isAsciiLetter(next)) {
      pushBuffer();
      segments.push({ text: char, isVariable: true });
      continue;
    }

    buffer += char;
  }
  pushBuffer();

  return segments;
}

export function graphCurveStrokeDasharray(curve: Pick<GraphCurve, "dash" | "strokeWidth">): string | undefined {
  const dash = normalizeGraphCurveDash(curve.dash);
  if (dash === "solid") {
    return undefined;
  }

  const strokeWidth = normalizeGraphCurveStrokeWidth(curve.strokeWidth);
  if (dash === "dashed") {
    return `${roundDashValue(strokeWidth * 3)} ${roundDashValue(strokeWidth * 2)}`;
  }

  return `0 ${roundDashValue(strokeWidth * 2.2)}`;
}

// 白黒基調の既定スタイル: 追加された曲線は色ではなく線種の違いで区別する。
const DEFAULT_CURVE_STYLE_SEQUENCE: readonly { color: string; dash: GraphCurveDash }[] = [
  { color: GRAPH_COLOR_OPTIONS[0].value, dash: "solid" },
  { color: GRAPH_COLOR_OPTIONS[0].value, dash: "dashed" },
  { color: GRAPH_COLOR_OPTIONS[1].value, dash: "solid" },
  { color: GRAPH_COLOR_OPTIONS[0].value, dash: "dotted" },
  { color: GRAPH_COLOR_OPTIONS[1].value, dash: "dashed" },
];

export function createDefaultGraphCurve(index: number): GraphCurve {
  const expr = index % 2 === 0 ? "sin(x)" : "cos(x)";
  const texExpr = index % 2 === 0 ? "\\sin(x)" : "\\cos(x)";
  const style = DEFAULT_CURVE_STYLE_SEQUENCE[index % DEFAULT_CURVE_STYLE_SEQUENCE.length];
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? `curve_${globalThis.crypto.randomUUID()}`
      : `curve_${Date.now()}_${index}`;

  return {
    id,
    expr,
    exprTex: texExpr,
    label: `y = ${texExpr}`,
    color: style.color,
    mode: DEFAULT_CURVE_MODE,
    dash: style.dash,
    strokeWidth: DEFAULT_CURVE_STROKE_WIDTH,
  };
}

export function createDefaultGraphPoint(index: number): GraphPoint {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? `point_${globalThis.crypto.randomUUID()}`
      : `point_${Date.now()}_${index}`;

  return {
    id,
    x: "0",
    y: "0",
    label: index === 0 ? "P" : `P_${index + 1}`,
    color: GRAPH_COLOR_OPTIONS[0].value,
  };
}

export function parseGraphPoint(point: GraphPoint | GraphAnnotation, parameters: NonNullable<Graph2DSpec["parameters"]> = []): { x: number; y: number } | null {
  const x = evaluateOptionalScalar(resolveGraphParameterExpression(point.x, parameters), null);
  const y = evaluateOptionalScalar(resolveGraphParameterExpression(point.y, parameters), null);
  return x === null || y === null ? null : { x, y };
}

export function describeGraphSpec(spec: Graph2DSpec): string {
  const labels = spec.showFormulaLabels === false
    ? []
    : spec.curves.map((curve) => formatGraphCurveLabel(curve));
  const points = (spec.points ?? []).map((point) => point.label).filter(Boolean);
  return [spec.title, ...labels, ...points].filter(Boolean).join(" ");
}

export function chooseNiceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const normalized = rawStep / magnitude;

  if (normalized <= 1) {
    return magnitude;
  }
  if (normalized <= 2) {
    return 2 * magnitude;
  }
  if (normalized <= 5) {
    return 5 * magnitude;
  }
  return 10 * magnitude;
}

function graphCurveFormulaPrefix(mode: GraphCurveMode): string {
  return mode === "xOfY" ? "x = " : "y = ";
}


function isAsciiLetter(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z]$/.test(char);
}

function graphCurveVariableName(mode: GraphCurveMode): GraphExpressionVariableName {
  if (mode === "parametric") {
    return "t";
  }

  return mode === "xOfY" ? "y" : "x";
}

function getGraphCurveIndependentRange(
  mode: GraphCurveMode,
  range: GraphNumericRange,
): { min: number; max: number } {
  if (mode === "xOfY") {
    return { min: range.yMin, max: range.yMax };
  }

  if (mode === "parametric") {
    return {
      min: evaluateScalar(DEFAULT_PARAMETRIC_DOMAIN.min),
      max: evaluateScalar(DEFAULT_PARAMETRIC_DOMAIN.max),
    };
  }

  return { min: range.xMin, max: range.xMax };
}

export function resolveGraphCurveSamplingRange(
  curve: GraphCurve,
  mode: GraphCurveMode,
  range: GraphNumericRange,
): GraphCurveSamplingRange | null {
  const variableName = graphCurveVariableName(mode);
  const independentRange = getGraphCurveIndependentRange(mode, range);
  const rawDomainMin = evaluateOptionalScalar(curve.domain?.min, independentRange.min);
  const rawDomainMax = evaluateOptionalScalar(curve.domain?.max, independentRange.max);
  if (rawDomainMin === null || rawDomainMax === null) {
    return null;
  }

  const min = mode === "parametric" ? rawDomainMin : Math.max(independentRange.min, rawDomainMin);
  const max = mode === "parametric" ? rawDomainMax : Math.min(independentRange.max, rawDomainMax);
  if (min >= max) {
    return null;
  }

  return { min, max, variableName };
}

function parseGraphViewBox(viewBox: GraphViewBox): GraphNumericRange {
  const xMin = evaluateScalar(viewBox.xMin);
  const xMax = evaluateScalar(viewBox.xMax);
  const yMin = evaluateScalar(viewBox.yMin);
  const yMax = evaluateScalar(viewBox.yMax);

  if (xMin >= xMax) {
    throw new Error("xMin must be smaller than xMax");
  }
  if (yMin >= yMax) {
    throw new Error("yMin must be smaller than yMax");
  }

  return { xMin, xMax, yMin, yMax };
}

function intersectGraphRanges(a: GraphNumericRange, b: GraphNumericRange): GraphNumericRange | null {
  const xMin = Math.max(a.xMin, b.xMin);
  const xMax = Math.min(a.xMax, b.xMax);
  const yMin = Math.max(a.yMin, b.yMin);
  const yMax = Math.min(a.yMax, b.yMax);

  if (xMin >= xMax || yMin >= yMax) {
    return null;
  }

  return { xMin, xMax, yMin, yMax };
}

function isValidGraphRange(range: GraphNumericRange): boolean {
  return Number.isFinite(range.xMin) &&
    Number.isFinite(range.xMax) &&
    Number.isFinite(range.yMin) &&
    Number.isFinite(range.yMax) &&
    range.xMin < range.xMax &&
    range.yMin < range.yMax;
}

function areGraphRangesNearlyEqual(a: GraphNumericRange, b: GraphNumericRange): boolean {
  return nearlyEqual(a.xMin, b.xMin) &&
    nearlyEqual(a.xMax, b.xMax) &&
    nearlyEqual(a.yMin, b.yMin) &&
    nearlyEqual(a.yMax, b.yMax);
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function graphRangeToViewBox(range: GraphNumericRange): GraphViewBox {
  return {
    xMin: formatRangeValue(range.xMin),
    xMax: formatRangeValue(range.xMax),
    yMin: formatRangeValue(range.yMin),
    yMax: formatRangeValue(range.yMax),
  };
}

function shiftGraphCurveDomainWithDisplayRange(
  curve: GraphCurve,
  previousDisplayRange: GraphNumericRange,
  nextDisplayRange: GraphNumericRange,
): GraphCurve {
  if (!curve.domain) {
    return curve;
  }

  const mode = normalizeGraphCurveMode(curve.mode);
  if (mode === "parametric") {
    return curve;
  }

  const previousMin = mode === "xOfY" ? previousDisplayRange.yMin : previousDisplayRange.xMin;
  const previousMax = mode === "xOfY" ? previousDisplayRange.yMax : previousDisplayRange.xMax;
  const nextMin = mode === "xOfY" ? nextDisplayRange.yMin : nextDisplayRange.xMin;
  const nextMax = mode === "xOfY" ? nextDisplayRange.yMax : nextDisplayRange.xMax;
  const min = shiftGraphDomainValue(curve.domain.min, previousMin, nextMin);
  const max = shiftGraphDomainValue(curve.domain.max, previousMax, nextMax);

  if (min === curve.domain.min && max === curve.domain.max) {
    return curve;
  }

  const domain = {
    ...(curve.domain ?? {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };

  return {
    ...curve,
    domain,
  };
}

function shiftGraphDomainValue(
  value: string | undefined,
  previousBoundary: number,
  nextBoundary: number,
): string | undefined {
  if (value === undefined || value.trim() === "") {
    return value;
  }

  const parsed = evaluateOptionalScalar(value, null);
  if (parsed === null) {
    return value;
  }

  return formatRangeValue(nextBoundary + (parsed - previousBoundary));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(0.98, Math.max(0.02, value));
}

export function formatRangeValue(value: number): string {
  if (Math.abs(value) < 1e-10) {
    return "0";
  }

  // Use 6 decimal places to preserve precision for small-scale graphs
  return Number(value.toFixed(6)).toString();
}

function formatNumberTick(value: number): string {
  if (Math.abs(value) < 1e-9) {
    return "0";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return Number(value.toFixed(3)).toString();
}

function formatPiTick(value: number): string {
  if (Math.abs(value) < 1e-9) {
    return "0";
  }

  const halfPi = Math.PI / 2;
  const units = Math.round(value / halfPi);
  if (Math.abs(value - units * halfPi) > 1e-5) {
    return formatNumberTick(value);
  }

  const sign = units < 0 ? "-" : "";
  const absoluteUnits = Math.abs(units);
  if (absoluteUnits === 1) {
    return `${sign}π/2`;
  }
  if (absoluteUnits === 2) {
    return `${sign}π`;
  }
  if (absoluteUnits % 2 === 0) {
    return `${sign}${absoluteUnits / 2}π`;
  }
  return `${sign}${absoluteUnits}π/2`;
}

function formatPiTickTex(value: number): string {
  if (Math.abs(value) < 1e-9) {
    return "0";
  }

  const halfPi = Math.PI / 2;
  const units = Math.round(value / halfPi);
  if (Math.abs(value - units * halfPi) > 1e-5) {
    return formatNumberTick(value);
  }

  const sign = units < 0 ? "-" : "";
  const absoluteUnits = Math.abs(units);
  if (absoluteUnits === 1) {
    return `${sign}\\dfrac{\\pi}{2}`;
  }
  if (absoluteUnits === 2) {
    return `${sign}\\pi`;
  }
  if (absoluteUnits % 2 === 0) {
    const coefficient = absoluteUnits / 2;
    return `${sign}${coefficient}\\pi`;
  }
  return `${sign}\\dfrac{${absoluteUnits}\\pi}{2}`;
}

function roundTick(value: number): number {
  return Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(10));
}

function detectFractionDenominator(stepStr?: string): number | null {
  if (!stepStr) {
    return null;
  }

  const match = stepStr.trim().match(/^-?(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    return null;
  }

  const numerator = Number.parseInt(match[1], 10);
  const denominator = Number.parseInt(match[2], 10);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1 || numerator === 0) {
    return null;
  }

  const divisor = gcdInt(numerator, denominator);
  const reducedDenominator = denominator / divisor;
  return reducedDenominator > 1 ? reducedDenominator : null;
}

function formatRationalTickTex(value: number, denominator: number): string {
  if (Math.abs(value) < 1e-9) {
    return "0";
  }

  const scaled = value * denominator;
  const numerator = Math.round(scaled);
  if (Math.abs(scaled - numerator) > 1e-6) {
    return formatNumberTick(value);
  }

  const sign = numerator < 0 ? "-" : "";
  const absNumerator = Math.abs(numerator);
  const divisor = gcdInt(absNumerator, denominator);
  const simpNum = absNumerator / divisor;
  const simpDen = denominator / divisor;

  if (simpDen === 1) {
    return `${sign}${simpNum}`;
  }

  return `${sign}\\dfrac{${simpNum}}{${simpDen}}`;
}

function gcdInt(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y > 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x || 1;
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(3));
}

function roundDashValue(value: number): number {
  return Number(value.toFixed(2));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}
