import { countPerformanceEvent } from "@/lib/performance";

/**
 * 装飾プラグインが「文書を丸ごと歩いた」回数の計測。
 *
 * 打鍵のたびに全文を歩く装飾が積み上がると、文書が長いほど 1 打鍵が重くなる (この編集器の
 * 打鍵コストがページ数に比例していた主因の 1 つ)。歩き方には 2 種類あり、コストが桁で違うので
 * 分けて数える。
 *
 * - `countDecorationFullWalk`: **inline 内容まで**降りる走査 (テキスト・数式ノードまで見る)。
 *   ノード数は本文の文字数に比例するので、これが打鍵ごとに走ると効いてくる。目標は 0/打鍵。
 * - `countDecorationBlockWalk`: textblock で降りるのをやめる**構造だけ**の走査。訪問数は
 *   ブロック数どまりなので桁が違う。0 にはしないが、増えていないことを見張る。
 * - `countDecorationInitWalk`: plugin state の初期化 (編集器 1 つにつき 1 回)。
 *
 * 装飾そのものではない走査 (id を配り直す `appendTransaction` など) も、打鍵のたびに文書を
 * 歩くという点は同じなので同じ物差しで数える。名前の `PmDecorations` は「ProseMirror の
 * 拡張が 1 transaction ごとに歩いた回数」と読んでほしい。
 */
export function countDecorationFullWalk(): void {
  countPerformanceEvent("PmDecorations.fullWalk");
}

export function countDecorationBlockWalk(): void {
  countPerformanceEvent("PmDecorations.blockWalk");
}

/**
 * plugin state の初期化 (= 編集器を 1 つ作るたびに 1 回) の走査。
 *
 * 打鍵ごとに走る上の 2 つとは意味が違う (文書を開いた回数・ユニットを作った回数に比例する)
 * ので、混ぜずに数える。ここが打鍵中に増えているなら「打鍵で編集器が作り直されている」。
 */
export function countDecorationInitWalk(): void {
  countPerformanceEvent("PmDecorations.initWalk");
}
