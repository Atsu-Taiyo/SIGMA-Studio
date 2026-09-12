/** Shared card-grid width; placement may shrink it to the compact panel width. */
export const GRAPH_SETTINGS_GRID_PANEL_WIDTH_PX = 620;

/**
 * グラフ設定パネルの配置計算。
 *
 * パネルはグラフを覆ってはならない（編集結果をリアルタイムに観察できることが目的）。
 * 右 → 左 → 下 の順に「グラフと交差しない置き場所」を探し、どこにも収まらないときだけ
 * viewport 端へ clamp する。DOM に触れない純粋関数にして単体テストで担保する。
 */

export interface GraphSettingsPanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GraphSettingsPanelSize {
  width: number;
  height: number;
  /**
   * 横に置けないときに縮めてよい下限。省略時は `width` (= 縮めない)。
   * 広いパネルを固定幅のまま扱うと、狭い viewport で「グラフを覆わない」を満たせなくなる。
   */
  minWidth?: number;
}

export interface GraphSettingsPanelViewport {
  width: number;
  height: number;
}

export interface GraphSettingsPanelOffset {
  dx: number;
  dy: number;
}

export type GraphSettingsPanelSide = "right" | "left" | "below" | "clamped";

export interface GraphSettingsPanelPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: GraphSettingsPanelSide;
}

/** 幅は固定。`--graph-panel-width` と同じ値を保つこと。 */
export const GRAPH_SETTINGS_PANEL_WIDTH_PX = 300;
export const GRAPH_SETTINGS_PANEL_MARGIN_PX = 8;
export const GRAPH_SETTINGS_PANEL_GAP_PX = 12;

export function getGraphSettingsPanelPlacement(
  graphRect: GraphSettingsPanelRect,
  panelSize: GraphSettingsPanelSize,
  viewport: GraphSettingsPanelViewport,
  manualOffset: GraphSettingsPanelOffset | null,
): GraphSettingsPanelPlacement {
  const margin = GRAPH_SETTINGS_PANEL_MARGIN_PX;
  const gap = GRAPH_SETTINGS_PANEL_GAP_PX;
  const viewportWidth = Math.max(1, viewport.width - margin * 2);
  const preferredWidth = Math.min(
    Math.max(1, panelSize.width || GRAPH_SETTINGS_PANEL_WIDTH_PX),
    viewportWidth,
  );
  const minWidth = Math.min(Math.max(1, panelSize.minWidth ?? preferredWidth), preferredWidth);
  let maxHeight = Math.max(1, viewport.height - margin * 2);
  let height = Math.min(Math.max(1, panelSize.height), maxHeight);
  const graphRight = graphRect.left + graphRect.width;
  const graphBottom = graphRect.top + graphRect.height;

  // 横に置ける幅。希望幅に足りなくても下限まで縮めば置けるなら、覆うより縮むほうがよい。
  const roomOnRight = viewport.width - margin - (graphRight + gap);
  const roomOnLeft = graphRect.left - gap - margin;
  const roomBelow = viewport.height - margin - (graphBottom + gap);

  let side: GraphSettingsPanelSide;
  let width: number;

  if (roomOnRight >= minWidth) {
    side = "right";
    width = Math.min(preferredWidth, roomOnRight);
  } else if (roomOnLeft >= minWidth) {
    side = "left";
    width = Math.min(preferredWidth, roomOnLeft);
  } else if (roomBelow >= Math.min(height, 160)) {
    // A scrollable settings body can fit below the graph even when its full content cannot.
    side = "below";
    width = preferredWidth;
    maxHeight = Math.min(maxHeight, roomBelow);
    height = Math.min(height, maxHeight);
  } else {
    side = "clamped";
    width = preferredWidth;
  }

  const clampLeft = (value: number): number =>
    Math.max(margin, Math.min(value, viewport.width - margin - width));
  const clampTop = (value: number): number =>
    Math.max(margin, Math.min(value, viewport.height - margin - height));

  let left: number;
  let top: number;

  if (side === "right") {
    left = graphRight + gap;
    top = clampTop(graphRect.top);
  } else if (side === "left") {
    left = graphRect.left - gap - width;
    top = clampTop(graphRect.top);
  } else if (side === "below") {
    left = clampLeft(graphRect.left);
    top = graphBottom + gap;
  } else {
    // どの側にも収まらない狭い viewport。グラフに重なるが、画面外へ出すよりはよい。
    side = "clamped";
    left = clampLeft(viewport.width - margin - width);
    top = clampTop(graphRect.top);
  }

  if (manualOffset) {
    // 自動配置を基準に移動量だけ足す。グラフが動いてもユーザーが決めた相対位置が残る。
    left += manualOffset.dx;
    top += manualOffset.dy;
  }

  return {
    left: clampLeft(left),
    top: clampTop(top),
    width,
    maxHeight,
    side,
  };
}
