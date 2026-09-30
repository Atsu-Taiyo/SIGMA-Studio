import type { OverlaySelectionStylePatch, OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { canChangeOverlayShapeType } from "@/components/editor/overlay-canvas/shape-type-change";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import { normalizeFillOpacity } from "@/lib/fill-opacity";

/**
 * 図形を選んだときに、選択バーへ **何を並べるか** の計画。
 *
 * 純粋関数にしてあるのは、「どの図形にどの操作を出すか」がこのバーの仕様そのものだから。
 * 画面のことは知らず、選択の概要 (`OverlaySelectionSummary`) だけから決める。
 */
export interface ShapeToolPlan {
  /** 文字図形そのものを選んでいる。太字・サイズ・色など本文と同じ文字書式を出す。 */
  text: boolean;
  /** 図形の種類 (四角→円、直線→矢印など) を変えられる。 */
  shapeType: boolean;
  stroke: boolean;
  fill: boolean;
  /** 線の太さと種類。 */
  lineStyle: boolean;
  /** 線の両端 (矢印・丸など)。 */
  lineEndpoints: boolean;
  /**
   * 図形まるごとの不透明度。塗り・枠線の色パレットが不透明度を持つので、それを持つ図形には出さない。
   * 色を選べない図形 (画像・グラフなど) と、すでに 1 でない値を持つ図形 (戻す手段を残す) にだけ出る。
   */
  opacity: boolean;
  image: { hasCrop: boolean } | null;
  graph: { canFillArea: boolean } | null;
  graph3d: boolean;
  chart: boolean;
  table: boolean;
  group: boolean;
  ungroup: boolean;
  align: boolean;
  distribute: boolean;
  /** 1 つだけ選んでいる。種類固有の操作 (画像・グラフなど) はこのときだけ。 */
  single: boolean;
}

export function planShapeTools(selection: OverlaySelectionSummary): ShapeToolPlan {
  const shapes = selection.selectedShapes;
  const single = shapes.length === 1;
  const only: OverlayShape | null = single ? shapes[0] : null;

  return {
    text: only?.type === "text",
    shapeType: only !== null && canChangeOverlayShapeType(only),
    stroke: selection.canStyleStroke,
    fill: selection.canStyleFill,
    lineStyle: selection.canStyleLine,
    lineEndpoints: selection.canStyleLineEndpoints,
    opacity: !(selection.canStyleFill || selection.canStyleStroke) || readSharedOpacity(shapes) !== 1,
    image: only?.type === "image" ? { hasCrop: Boolean(only.props.crop) } : null,
    graph: only?.type === "graph2dShape" ? { canFillArea: only.props.spec.kind === "cartesian" } : null,
    graph3d: only?.type === "graph3dShape",
    chart: only?.type === "chartShape",
    table: only?.type === "tableShape",
    group: selection.selectedCount >= 2,
    ungroup: shapes.some((shape) => shape.type === "group"),
    align: selection.canAlign,
    distribute: selection.canDistribute,
    single,
  };
}

/** 選択中の図形が同じ不透明度ならその値 (1 = 不透明)。食い違うときは `null`。 */
export function readSharedOpacity(shapes: readonly OverlayShape[]): number | null {
  let result: number | null = null;
  for (const shape of shapes) {
    const opacity = shape.opacity ?? 1;
    if (result === null) {
      result = opacity;
    } else if (result !== opacity) {
      return null;
    }
  }
  return result;
}

/** 枠線の色。枠線を持つ図形が同じ色ならその値、食い違い・該当なしは `null`。 */
export function readSharedStrokeColor(shapes: readonly OverlayShape[]): string | null {
  let result: string | null = null;
  for (const shape of shapes) {
    if (shape.type !== "geo" && shape.type !== "arrow" && shape.type !== "line" && shape.type !== "arc") {
      continue;
    }
    if (result === null) {
      result = shape.props.color;
    } else if (result !== shape.props.color) {
      return null;
    }
  }
  return result;
}

function hasStroke(shape: OverlayShape): shape is Extract<OverlayShape, { type: "geo" | "arrow" | "line" | "arc" }> {
  return shape.type === "geo" || shape.type === "arrow" || shape.type === "line" || shape.type === "arc";
}

/** 枠線の不透明度 (1 = 不透明)。枠線を持つ図形が同じ値ならその値、食い違い・該当なしは `null`。 */
export function readSharedStrokeOpacity(shapes: readonly OverlayShape[]): number | null {
  let result: number | null = null;
  for (const shape of shapes) {
    if (!hasStroke(shape)) {
      continue;
    }
    const opacity = normalizeFillOpacity(shape.props.strokeOpacity);
    if (result === null) {
      result = opacity;
    } else if (result !== opacity) {
      return null;
    }
  }
  return result;
}

/**
 * 枠線の色だけを変える (見本を押したとき)。選んでいる不透明度は保つ。
 *
 * 0% のときと、図形ごとに食い違うとき (`opacity` が `null`) だけ 1 に戻す。0% のまま色を変えても
 * 見た目が何も変わらず、理由も分からないため。
 */
export function strokeColorPatch(color: string, opacity: number | null): OverlaySelectionStylePatch {
  return opacity === null || opacity === 0 ? { color, strokeOpacity: 1 } : { color };
}

/**
 * 色パレットの操作中プレビューを、図形へ被せる書式へ直す。`color` が `null` のときは不透明度の
 * スライダーで、色は触らない (色が食い違う選択を 1 色にそろえてしまわないため)。
 */
export function fillPreviewPatch(preview: { color: string | null; opacity: number }): OverlaySelectionStylePatch {
  return preview.color === null
    ? { fillOpacity: preview.opacity }
    : { fill: "solid", fillColor: preview.color, fillOpacity: preview.opacity };
}

export function strokePreviewPatch(preview: { color: string | null; opacity: number }): OverlaySelectionStylePatch {
  return preview.color === null
    ? { strokeOpacity: preview.opacity }
    : { color: preview.color, strokeOpacity: preview.opacity };
}

/** 塗りの色と不透明度。塗りを持つ図形が「なし」または食い違うときは色が `null`。 */
export function readFillState(selection: OverlaySelectionSummary): { color: string | null; opacity: number } {
  const fill = selection.fill;
  return fill.kind === "solid"
    ? { color: fill.fillColor, opacity: fill.fillOpacity }
    : { color: null, opacity: 1 };
}
