import type { MeasuredBlock } from "@/features/drawing";

/**
 * 描かれていないブロック (undrawn) の扱いを決める唯一の場所。
 *
 * 機能 (適用後だけを見せる AI 提案など) が本文のブロックを display: none で紙面から畳むと、そのブロックと
 * 中のブロックは外接矩形がすべて 0 になり、描画矩形を 1 つも持たない。畳むのは表示だけなので、保存される
 * 内容は畳む前と変わってはいけない。本文を測る 3 本と図形の固定は、すべてここの規則を通る。
 *
 * - 判定 (`isUndrawnElement`): 0 の矩形は読まない。読むと負の位置・大きさ 0 のブロックになる。
 * - ページ割り (`probeFlow`): 行を作らない。畳んだ間は無いものとして割る。
 * - 固定先の計測 (page canvas の `measureFlowBlocks`・overlay の `measureBlockTops`): 最後に描かれていた
 *   幾何を知っていれば印 (`undrawn`) を付けて残し、知らなければ計測から外す (`keepUndrawnBlock`)。
 * - 計測の比較 (`isSameBlockGeometry`・`sameMeasuredBlockMap`・`anchorMeasurementKey`): 印の有無も差に
 *   する。畳んでも戻しても他が 1px も動かないことがあり、比べないと下流に古い印が残る (`isSameDrawState`)。
 * - 固定先の候補: どの経路 (点や図形の位置から選ぶ新しい固定先・削除後の付け替え・保存時の付け替え・図形の
 *   移動) でも選ばない (`isPickableAnchorBlock`)。描かれていないブロックに固定された図形を作らない。
 *
 * 機能は図形が固定されたブロックを畳まない (AI の「適用後だけ」は、図形が固定されたブロックを畳まずに注記へ
 * 回す)。畳んだブロックに固定された図形が無いので、付け替え・保存・変更口のどれにも例外を持たない。
 */

/**
 * 要素が描かれていない (自身か祖先が display: none で、描画矩形を 1 つも持たない) か。そのときの外接矩形は
 * すべて 0 なので、0 の大きさのときだけ `getClientRects` を引く (打鍵ごとの計測を重くしない)。高さ 0 で
 * 描かれた要素は矩形を持つので描かれている。
 */
export function isUndrawnElement(element: Element, rect: DOMRect | DOMRectReadOnly): boolean {
  return rect.width === 0 && rect.height === 0 && element.getClientRects().length === 0;
}

/**
 * 描かれていない要素について、固定先の計測が残すもの: 最後に描かれていた幾何に印を付けたもの。矩形は紙面の
 * 座標 (ズームに依らない) なので、ズームを変えた後も使える。一度も描かれていなければ残さない (undefined)。
 */
export function keepUndrawnBlock(lastDrawn: MeasuredBlock | undefined): MeasuredBlock | undefined {
  if (!lastDrawn) {
    return undefined;
  }
  return lastDrawn.undrawn ? lastDrawn : { ...lastDrawn, undrawn: true };
}

/** 2 つの計測で、ブロックが描かれているかどうかが同じか。 */
export function isSameDrawState(a: MeasuredBlock, b: MeasuredBlock): boolean {
  return (a.undrawn === true) === (b.undrawn === true);
}

/** 図形の固定先の候補にしてよいか (描かれていないブロックは、どの経路でも候補にしない)。 */
export function isPickableAnchorBlock(block: MeasuredBlock): boolean {
  return block.undrawn !== true;
}
