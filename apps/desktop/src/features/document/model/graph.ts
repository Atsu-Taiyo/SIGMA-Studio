import type { GraphParameter } from "./graph-parameter";

export type Graph2DKind = "cartesian" | "numberLine";
export type Graph2DPreset = "blank" | "sine" | "cosine" | "quadratic" | "line" | "parametric" | "numberLine";
export type GraphTickMode = "number" | "pi";
export type GraphCurveMode = "yOfX" | "xOfY" | "parametric" | "implicit";
export type GraphCurveDash = "solid" | "dashed" | "dotted";
export type GraphFillPattern =
  | "solid"
  | "diagonal"
  | "diagonalBack"
  | "cross"
  | "horizontal"
  | "vertical"
  | "dots";

export interface Graph2DSpec {
  kind: Graph2DKind;
  title: string;
  width: number;
  height: number;
  viewBox: GraphViewBox;
  graphViewBox?: GraphViewBox;
  axes: GraphAxes;
  curves: GraphCurve[];
  parameters?: GraphParameter[];
  points?: GraphPoint[];
  annotations?: GraphAnnotation[];
  fills?: GraphFillRegion[];
  showFormulaLabels?: boolean;
}

export interface GraphViewBox {
  xMin: string;
  xMax: string;
  yMin: string;
  yMax: string;
}

export interface GraphAxes {
  grid: boolean;
  showX?: boolean;
  showY?: boolean;
  showTicks?: boolean;
  axisDash?: GraphCurveDash;
  axisColor?: string;
  axisStrokeWidth?: number;
  xLabel?: string;
  yLabel?: string;
  originLabel?: string;
  /** Tick label font size in points. */
  tickFontSize?: number;
  xTickStep?: string;
  yTickStep?: string;
  xTickMode?: GraphTickMode;
  yTickMode?: GraphTickMode;
}

export interface GraphCurve {
  id: string;
  /** `yOfX`: y=f(x), `xOfY`: x=f(y), `parametric`: x=f(t), `implicit`: F(x,y)=0. 評価用の正規化済み式 (正本)。 */
  expr: string;
  /** Used only when `mode` is `"parametric"`: y=g(t). */
  yExpr?: string;
  /** ユーザーが入力した TeX (表示・再編集用の投影)。無ければ `expr` から導出する。 */
  exprTex?: string;
  /** `yExpr` に対応する入力 TeX。 */
  yExprTex?: string;
  label?: string;
  color: string;
  mode?: GraphCurveMode;
  dash?: GraphCurveDash;
  strokeWidth?: number;
  domain?: {
    min?: string;
    max?: string;
  };
  samples?: number;
}

/** 点ラベルを置く方位 (8方位)。未指定なら曲線・軸・他の点/ラベルを避けて自動配置する。 */
export type GraphPointLabelPlacement = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface GraphPoint {
  id: string;
  x: string;
  y: string;
  /** ユーザーが入力した座標 TeX (表示・再編集用の投影)。無ければ `x`/`y` から導出する。 */
  xTex?: string;
  yTex?: string;
  label?: string;
  /** ラベルを置く方位。省略時は曲線・軸・他要素と重ならない位置を自動選択する。 */
  labelPlacement?: GraphPointLabelPlacement;
  color?: string;
  fill?: "solid" | "none";
  radius?: number;
  showXProjection?: boolean;
  showYProjection?: boolean;
}

export interface GraphAnnotation {
  id: string;
  x: string;
  y: string;
  text: string;
}

export interface GraphFillRegion {
  id: string;
  x: string;
  y: string;
  color?: string;
  opacity?: number;
  pattern?: GraphFillPattern;
}
