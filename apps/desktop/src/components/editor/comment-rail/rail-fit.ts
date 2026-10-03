/**
 * 右上に浮かぶカードの並び (CommentRail) を、そのままの大きさで置けるかの判定。DOM にも React にも依存しない。
 * 置けないときは、本文の邪魔にならないよう小さなアイコンだけの並びにする。
 */

/** 並びの幅 (CommentRail.module.css の .rail と同じ)。 */
export const COMMENT_RAIL_WIDTH_PX = 300;
/** 並びと本文の窓の右端の間の余白 (同じく .rail の right)。 */
export const COMMENT_RAIL_EDGE_GAP_PX = 16;
/**
 * 用紙の右の余白 (印刷の余白、17mm ほど) には文字が無いので、並びがそこへ入り込むのは許す。
 * 文字に掛かる前に、アイコンへ切り替える。
 */
export const COMMENT_RAIL_PAPER_MARGIN_OVERLAP_PX = 48;
/** ホワイトボードは用紙が無いので、窓の幅だけで決める。 */
export const COMMENT_RAIL_WHITEBOARD_MIN_CANVAS_WIDTH_PX = 980;

export interface CommentRailFitInput {
  /** 本文の窓の右端と幅。 */
  canvasRight: number;
  canvasWidth: number;
  /** 用紙の右端。用紙の無い面 (ホワイトボード) は null。 */
  paperRight: number | null;
}

export function shouldCompactCommentRail({ canvasRight, canvasWidth, paperRight }: CommentRailFitInput): boolean {
  if (paperRight === null) return canvasWidth < COMMENT_RAIL_WHITEBOARD_MIN_CANVAS_WIDTH_PX;
  const railLeft = canvasRight - COMMENT_RAIL_EDGE_GAP_PX - COMMENT_RAIL_WIDTH_PX;
  return railLeft + COMMENT_RAIL_PAPER_MARGIN_OVERLAP_PX < paperRight;
}
