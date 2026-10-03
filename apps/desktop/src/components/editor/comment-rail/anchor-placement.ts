/**
 * コメントの対象 (本文の要素) が、いま見えている本文の窓に対してどこにあるか。DOM にも React にも依存しない。
 * 座標はすべてビューポート基準 (getBoundingClientRect と同じ)。
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * - visible: 窓の中
 * - above / below: 窓の外
 * - none: 対象の要素が無い (文書全体へのコメントなど)
 */
export type CommentAnchorPlacement = "visible" | "above" | "below" | "none";

export function classifyAnchorPlacement(anchor: Rect | null, viewport: Rect): CommentAnchorPlacement {
  if (!anchor) return "none";
  if (anchor.bottom < viewport.top) return "above";
  if (anchor.top > viewport.bottom) return "below";
  return "visible";
}

/** 折り返して複数の行にまたがる対象を、1つの矩形にまとめる。 */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return rects.reduce((acc, rect) => ({
    left: Math.min(acc.left, rect.left),
    top: Math.min(acc.top, rect.top),
    right: Math.max(acc.right, rect.right),
    bottom: Math.max(acc.bottom, rect.bottom),
  }));
}
