import { resolveDocumentFontFamily, type InlineNode } from "@/features/document";

import { hasVisibleInlineText } from "./boxed-inline-runs";

/**
 * リストのマーカー (`(1)` / `1.` / `•`) を「項目本文の直後の字体・大きさ」に合わせるための派生値。
 *
 * SigmaDoc には段落レベルのフォントが無く、字体と大きさは inline run が持つ。マーカーは `li` の
 * font を継ぐので、run の内側にある `<span style="font-…">` は `::marker` に絶対届かない。
 * そこで「先頭 run のタイポグラフィ」だけをここで決め、描画側 (編集中の ProseMirror・静的描画・
 * AI プレビュー) が同じ値を `li` のカスタムプロパティとして出す。**保存はしない** —
 * 先頭の文字の書体を変えたら次の描画で自動的に付いてくる派生値であって、SigmaDoc の意味ではない。
 */
export interface ListMarkerTypography {
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * 描画エンジンに依存しない run 記述。SigmaDoc の `InlineNode` も Tiptap の inline ノードも
 * これに写してから同じ判断を通す — 2 つの経路が別々の「先頭」の定義を持たないため。
 */
export interface ListMarkerRun {
  kind: "text" | "math";
  /** 描画されて 1 文字以上のグリフを生むか。空文字の text run は false。 */
  hasGlyph: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * マーカーに使うタイポグラフィ。該当が無ければ `undefined` (＝既定を継ぐ)。
 *
 * 数式 run からは `fontSizePt` と `color` だけを採り `fontFamily` は採らない。数式は
 * KaTeX/MathLive の数式フォントで描かれるため `font-family` が実際には効かず、マーカーだけが
 * その書体で描かれると「実描画と食い違う表示」を新たに作ってしまう (囲み枠のタイトルで同じ
 * 事故があった)。`fontSize` は数式の em に、`color` は currentColor に効くので採ってよい。
 * 太字・斜体も数式では字形そのものが変わる (\mathbf 等) ので、run の mark からは採らない。
 *
 * CSS の `::marker` が受け付けるのは color と font-* だけで、背景色や下線は原理的に効かない
 * (MDN)。だからここも「マーカーに実際に届く書式」しか持たない — 届かないものを持つと、
 * ツールバーの見た目と紙面が食い違う。
 */
export function resolveListMarkerTypography(
  runs: readonly ListMarkerRun[],
): ListMarkerTypography | undefined {
  const first = runs.find((run) => run.hasGlyph);
  if (!first) {
    return undefined;
  }

  const typography: ListMarkerTypography = {};
  const fontFamily = first.kind === "text" ? resolveDocumentFontFamily(first.fontFamily) : undefined;
  if (fontFamily) {
    typography.fontFamily = fontFamily;
  }
  if (first.fontSizePt !== undefined && Number.isFinite(first.fontSizePt) && first.fontSizePt > 0) {
    typography.fontSizePt = first.fontSizePt;
  }
  if (first.color) {
    typography.color = first.color;
  }
  if (first.kind === "text" && first.bold) {
    typography.bold = true;
  }
  if (first.kind === "text" && first.italic) {
    typography.italic = true;
  }
  return Object.keys(typography).length > 0 ? typography : undefined;
}

/**
 * その run が「マーカーの並ぶ行にグリフを出す」か。text と math で 1 つの定義を共有する。
 *
 * 改行を除くのが要点。SigmaDoc は改行を text run の中の `\n` として持つが、編集面では
 * `hardBreak` という別ノードになる。ここで `\n` をグリフとして数えると、改行で始まる項目の
 * 「先頭 run」が面ごとに変わり、編集中と印刷でマーカーの書体が食い違う。ゼロ幅文字を
 * 除くのは、描画側 (`hasVisibleInlineText`) が「描くもの」を判断する定義に合わせるため。
 */
export function listMarkerRunHasGlyph(content: string): boolean {
  return hasVisibleInlineText(content.replace(/[\n\r]/g, ""));
}

/** SigmaDoc の項目本文を run 列へ写す。 */
export function listMarkerRunsFromInlineNodes(children: readonly InlineNode[]): ListMarkerRun[] {
  return children.map((child) => ({
    kind: child.type === "mathInline" ? "math" : "text",
    hasGlyph: listMarkerRunHasGlyph(child.type === "mathInline" ? child.tex : child.text),
    fontFamily: resolveDocumentFontFamily(child.fontFamily),
    fontSizePt: child.fontSize,
    color: child.color,
    // 数式 run の `marks` は underline / boxed しか取れない。太字・斜体は数式では
    // 字形そのものの話 (\mathbf 等) なので、text run からだけ採る。
    bold: child.type === "text" && child.marks?.includes("bold") === true,
    italic: child.type === "text" && child.marks?.includes("italic") === true,
  }));
}
