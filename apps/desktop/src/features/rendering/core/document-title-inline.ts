import type { InlineNode } from "@/features/document";

import { splitDelimitedInlineMathText } from "./inline-math-delimiters";

/**
 * 教材タイトルは `metadata.title` に素の文字列で保存され、本文先頭行から導出される場合も
 * `inlineNodesToPlainText` が数式を `$tex$` として吐く。つまり「タイトルの数式」は
 * 保存形ではなく**表示の解釈**の問題なので、射影はここ (描画コア) にだけ置き、
 * 保存値・台帳・ファイル名・検索には一切触れない。
 *
 * ここに XSS ガードは置かない。数式 markup の無害化は
 * `features/rendering/adapters/math-html.ts` の `renderMathHtml` という**唯一の出口**が引き受け、
 * 本文・AI 提案・素材・図形テキスト・表・コメント・印刷/PDF・publish 済み viewer を含む
 * すべての描画面が同じ保証を受ける (`adapters/math-html.security.test.ts`)。
 * 以前ここにあった「`<` `>` `&` を含む候補は数式にしない」という入口フィルタは、
 * `$a<b$` や `\begin{aligned}…&…\end{aligned}` のようなごく普通の数学まで潰していたので撤去した。
 */

const TITLE_INLINE_NODES_CACHE_LIMIT = 200;
const titleInlineNodesCache = new Map<string, InlineNode[] | null>();

/** かな・カタカナ・漢字・全角記号。`lib/math-tex.ts` の日本語判定と同じ範囲。 */
const CJK_CHARACTER_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}　-〿！-｠￠-￮]/u;

/** 空白で区切られた英小文字 2 文字以上の語 (`and` / `for` / `items`)。 */
const ASCII_PROSE_WORD_PATTERN = /(?:^|\s)[a-z]{2,}(?:\s|$)/;

/** 二項演算子で始まる / 終わる区間。片側の項が無い式は書きかけではなく区切りの誤検出。 */
const DANGLING_OPERATOR_PATTERN = /^\s*[-+*/<>=,&|]|[-+*/<>=,&|]\s*$/;

/**
 * タイトル文字列の `$…$` を数式として読む射影。数式が 1 つも無ければ `null` を返し、
 * 呼び出し側が素の文字列描画へ 0 コストで落ちられるようにする。
 *
 * 結果は上限付きキャッシュに載せる。教材一覧やタブは同じタイトルを何度も描き直すので、
 * 行ごと・描画ごとに区切りの走査と散文判定をやり直さないため。
 */
export function parseDocumentTitleInlineNodes(title: string): InlineNode[] | null {
  const cached = titleInlineNodesCache.get(title);
  if (cached !== undefined) {
    // 参照し直したものを末尾へ送り、よく使うタイトルが打鍵中の一時的な文字列に
    // 押し出されないようにする (打鍵のたびに新しいキーが 1 つ増えるため)。
    titleInlineNodesCache.delete(title);
    titleInlineNodesCache.set(title, cached);
    return cached;
  }

  const nodes = projectDocumentTitleInlineNodes(title);
  if (titleInlineNodesCache.size >= TITLE_INLINE_NODES_CACHE_LIMIT) {
    const oldest = titleInlineNodesCache.keys().next().value;
    if (oldest !== undefined) {
      titleInlineNodesCache.delete(oldest);
    }
  }
  titleInlineNodesCache.set(title, nodes);
  return nodes;
}

function projectDocumentTitleInlineNodes(title: string): InlineNode[] | null {
  const segments = splitDelimitedInlineMathText(title);
  const mathSegments = segments.filter((segment) => segment.type === "math");
  if (mathSegments.length === 0) {
    return null;
  }

  // 散文ガード。1 区間でも該当すれば**タイトル全体**を素の文字列に落とす。
  // 区間ごとに戻すと、区切りの種類 (`$` / `$$` / `\(`) と前後の空白がパーサで失われている
  // ため元の文字列を復元できず、下の不変条件が崩れる。
  if (mathSegments.some((segment) => isProse(segment.tex))) {
    return null;
  }

  const nodes: InlineNode[] = segments.map((segment, index) => (
    segment.type === "text"
      ? { type: "text", text: segment.text }
      : { type: "mathInline", id: `t${index}`, tex: segment.tex, display: "inline" }
  ));

  // 不変条件「リッチ表示の可視テキスト = 生文字列 (数式部分を除く)」を実装で保証する。
  // パーサは AI 応答の取り込みも兼ねていて `$$…$$` や `\(…\)` も受け、`$ x^2 $` の内側の
  // 空白は落とし、`$ $` のように中身が空の区切りは文字ごと捨てる。復元できない書き方を
  // そのまま描くと画面から文字が消えるので、素の文字列表示へ倒す。
  return toTitleSourceText(nodes) === title ? nodes : null;
}

function toTitleSourceText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : `$${node.tex}$`)).join("");
}

/**
 * 「セール $100 と $200」の `100 と `、「Sale $100 and $200」の `100 and ` のような散文を
 * 数式と誤認しないための判定。
 *
 * KaTeX / MathLive の検証では代替できない — `lib/math-tex.ts` の `normalizeMathTextRuns` が
 * 日本語の連続を `\text{…}` へ自動で包むので `validateMathTex("100 と ")` は `[]` (問題なし)
 * を返し、markup も正常に生成されてしまう。よって「日本語か英単語を含み、かつ TeX コマンドを
 * 1 つも含まない」ことを散文の印として使う。
 *
 * 英字は「空白で区切られた小文字 2 文字以上」だけを散文とみなす。`$AB = CD$` (線分名) や
 * `$y = ax^2+bx+c$` (変数の積) を巻き込まないため。`$\sin x$` のようにコマンドを使う式は
 * バックスラッシュを含むので常に数式として通る。
 *
 * 二項演算子で始まる / 終わる区間も散文とみなす。`セール $100<$200` の `100<` のように
 * 片側の項が無い式は、数式ではなく「値段の `$` を区切りだと読み違えた」印だからで、
 * そのまま数式にすると画面から `$` が黙って消える。`$a<b$` は両側に項があるので通る。
 */
function isProse(tex: string): boolean {
  if (tex.includes("\\")) {
    return false;
  }
  return CJK_CHARACTER_PATTERN.test(tex) ||
    ASCII_PROSE_WORD_PATTERN.test(tex) ||
    DANGLING_OPERATOR_PATTERN.test(tex);
}
