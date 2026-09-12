import type { ColumnRule } from "./column-rule";
import type { OverlaySnapshot } from "../overlay-model";
import type { RichBlock } from "./blocks";

export type PageSizePreset = "A4" | "A3" | "B5" | "B4" | "custom" | "whiteboard";
export type PageOrientation = "portrait" | "landscape";

/**
 * 紙／無限キャンバスの下地。ホワイトボードの既定は `"dots"`。
 *
 * 型名を `WhiteboardBackground` にしていないのは、印刷の切り出し
 * (`cropWhiteboardDocumentForPrint`) がホワイトボードを `preset: "custom"` の 1 枚紙へ
 * 投影するため。**用紙プリセットでも保持されなければならないフィールド**であって、
 * ホワイトボード専用ではない。
 */
export type PageBackground = "grid" | "dots" | "none";

/**
 * 下地 1 マスのワールド座標での大きさ。
 *
 * 描画側 (キャンバスのパターン生成) と印刷側 (切り出し原点のセル合わせ) の**両方**が
 * 同じ値を見る必要があるのでモデル層に置く。片方だけ変えると、紙面のマス目が画面の
 * ワールドグリッドと位相ずれする。
 */
export const WHITEBOARD_BASE_CELL_PX = 24;

export interface PageLayout {
  preset: PageSizePreset;
  orientation: PageOrientation;
  pageSize: {
    widthMm: number;
    heightMm: number;
  };
  marginsMm: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  flow: {
    type: "columns";
    columnCount: number;
    columnGapMm: number;
    columnRule?: ColumnRule;
  };
  header?: PageRunningRegion;
  footer?: PageRunningRegion;
  /** Single continuous overlay for the whole document (figures resolve their page from block anchors). */
  overlay?: PageOverlay;
  /** 下地のパターン。用紙プリセットでは通常 `undefined` (無地)。 */
  background?: PageBackground;
}

export interface PageRunningRegion {
  enabled: boolean;
  heightMm: number;
  offsetMm: number;
  showOnFirstPage: boolean;
  /** Free-form header/footer body. This is the canonical repeated text content. */
  blocks: RichBlock[];
  /** Repeated overlay for figures, images, graphs, and free-positioned text inside this region. */
  overlay?: PageOverlay;
}

/**
 * `overlaySnapshot` is the only source for overlay figures. Previews, exports, and
 * print output are always regenerated from it — no serialized SVG is ever persisted.
 */
export interface PageOverlay {
  overlaySnapshot?: OverlaySnapshot;
  updatedAt?: string;
}
