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
    /** 1-based page-specific separator styling. Pages without an entry inherit columnRule. */
    pageColumnRules?: { page: number; rule: ColumnRule }[];
  };
  header?: PageRunningRegion;
  footer?: PageRunningRegion;
  /** Single continuous overlay for the whole document (figures resolve their page from block anchors). */
  overlay?: PageOverlay;
  /** 下地のパターン。用紙プリセットでは通常 `undefined` (無地)。 */
  background?: PageBackground;
  /**
   * ヘッダー/フッターの `{page}` を数え始める番号 (0〜9999 の整数)。省略は 1。表紙を 0 ページに
   * したいときは 0。`{total}` は最後のページに出る番号 (ページ数 + 開始番号 − 1) と同じになる。
   * 変えるのは差し込みの値だけで、表示するページの指定・ページ専用の中身・ページ移動は
   * 組版上のページ (1 始まり) のまま。既定のときは持たない。
   */
  pageNumberStart?: number;
}

export interface PageRunningRegion {
  enabled: boolean;
  heightMm: number;
  offsetMm: number;
  showOnFirstPage: boolean;
  /**
   * 2 ページ目以降を、既定で出すか。省略は出す。`false` にすると「先頭ページのみ」。
   * ページごとの例外は `hiddenPages` / `shownPages` が持つ。
   */
  showOnLaterPages?: boolean;
  /**
   * 2 ページ目以降を既定で出す (`showOnLaterPages` が `true`/省略) とき、出さないページ番号
   * (2 以上・昇順・重複なし)。空なら持たない。1 ページ目は `showOnFirstPage` が決める。
   * ページ番号は組版の結果で決まる位置の番号なので、本文を足してページが送られると、出さないページも
   * 同じ番号のページへ移る (ブロックには結び付けない)。
   */
  hiddenPages?: number[];
  /** 2 ページ目以降を既定で出さない (`showOnLaterPages: false`) とき、出すページ番号。 */
  shownPages?: number[];
  /**
   * ページ専用の中身 (文字)。ここにあるページだけ `blocks` の代わりにこの文字を出す。ページ番号は
   * `hiddenPages` と同じ位置の番号。図形・画像 (`overlay`) はページごとには変えず、共通のまま。
   */
  pageContents?: PageRunningRegionPageContent[];
  /** Free-form header/footer body. This is the canonical repeated text content. */
  blocks: RichBlock[];
  /** Repeated overlay for figures, images, graphs, and free-positioned text inside this region. */
  overlay?: PageOverlay;
}

export interface PageRunningRegionPageContent {
  /** 1 始まりのページ番号。 */
  page: number;
  blocks: RichBlock[];
}

/**
 * `overlaySnapshot` is the only source for overlay figures. Previews, exports, and
 * print output are always regenerated from it — no serialized SVG is ever persisted.
 */
export interface PageOverlay {
  overlaySnapshot?: OverlaySnapshot;
  updatedAt?: string;
}
