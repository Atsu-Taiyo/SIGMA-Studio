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
 * - 新しい固定先 (点や図形の位置から選ぶもの): 選ばない。見えないブロックに付けない。削除後の付け替えだけは
 *   候補に含め、結果を表示の切り替えに依らせない (`isPickableAnchorBlock`)。
 * - 既に固定されている図形: 固定先が描かれていなければ、固定先も dx/dy も書き換えない。位置を読めないので
 *   逆算しない (`isUndrawnAnchorBlock`)。
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

/** 点や図形の位置から新しく選ぶ固定先に出してよいか。`includeUndrawn` は削除後の付け替えだけが使う。 */
export function isPickableAnchorBlock(block: MeasuredBlock, options: { includeUndrawn?: boolean } = {}): boolean {
  return options.includeUndrawn === true || block.undrawn !== true;
}

/**
 * 図形の固定先が、在るが描かれていないブロックか。計測が残した印 (`measured.undrawn`) か、幾何を知らずに
 * 計測から外した id (`undrawnIds`) のどちらかで分かる。真なら保存済みの固定をそのまま残す。
 */
export function isUndrawnAnchorBlock(
  blockId: string,
  measured: MeasuredBlock | undefined,
  undrawnIds?: ReadonlySet<string>,
): boolean {
  return measured?.undrawn === true || undrawnIds?.has(blockId) === true;
}
