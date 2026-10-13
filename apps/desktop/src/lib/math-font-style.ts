/**
 * 数式の一部に選んだフォント。TeX には `\htmlStyle{font-family:…}{…}` として書く
 * (MathLive も静的な描画も読める標準の命令で、SigmaDoc の TeX にそのまま残る)。
 *
 * 数式の文字・数字・`\text` は MathLive の書体クラス (`ML__mathit` など) が自前のフォントを持つので、
 * 包んだ要素の指定を継がせる CSS は `document-surface.css` と `SIGMA_MATHLIVE_MACRO_STYLES` にある。
 * 個別に選んだフォントは本文のフォントより優先する (数式の外側の書式は届かない)。
 */

const MATH_FONT_STYLE_PREFIX = "\\htmlStyle{font-family:";

/**
 * フォントメニューの中身に付ける印。数式の入力欄は焦点を失うと確定して閉じるが、この印の中へ
 * 焦点が移ったとき (検索欄に打つとき) は閉じずに待ち、選んでいた範囲へフォントを付けられるようにする
 * (`components/tiptap/inline-math-font.ts`)。
 */
export const INLINE_MATH_FONT_MENU_ATTRIBUTE = "data-inline-math-font-menu";

/**
 * 本文の書式と同じフォントの値 (CSS のフォント名の並び) を、TeX に書ける形へ直す。
 * 二重引用符は描画の属性で `&quot;` になって落とされるので単引用符にし、TeX の区切り
 * (`{` `}` `\`) と CSS の区切り (`;`) は取り除く。
 */
export function toMathFontFamilyValue(cssFontFamily: string): string {
  return cssFontFamily
    .replace(/"/g, "'")
    .replace(/[{}\\;]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 選んだ範囲 (TeX) を、そのフォントで包む。範囲の中にあった別のフォント指定は外して付け直す。 */
export function wrapMathWithFont(latex: string, cssFontFamily: string): string {
  const value = toMathFontFamilyValue(cssFontFamily);
  const body = unwrapMathFontStyles(latex);
  if (!value) {
    return body;
  }
  return `${MATH_FONT_STYLE_PREFIX}${value}}{${body}}`;
}

/** `\htmlStyle{font-family:…}{…}` を外して中身だけにする (入れ子もすべて)。 */
export function unwrapMathFontStyles(latex: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < latex.length) {
    const start = latex.indexOf(MATH_FONT_STYLE_PREFIX, cursor);
    if (start < 0) {
      break;
    }
    const valueEnd = latex.indexOf("}", start + MATH_FONT_STYLE_PREFIX.length);
    const bodyEnd = valueEnd >= 0 && latex[valueEnd + 1] === "{" ? findClosingBrace(latex, valueEnd + 1) : -1;
    if (bodyEnd < 0) {
      // 閉じていない (打ちかけの) 指定は触らない。
      result += latex.slice(cursor, start + MATH_FONT_STYLE_PREFIX.length);
      cursor = start + MATH_FONT_STYLE_PREFIX.length;
      continue;
    }
    result += latex.slice(cursor, start) + unwrapMathFontStyles(latex.slice(valueEnd + 2, bodyEnd));
    cursor = bodyEnd + 1;
  }
  return result + latex.slice(cursor);
}

/** `open` の `{` に対応する `}` の位置。`\{` `\}` は数えない。無ければ -1。 */
function findClosingBrace(latex: string, open: number): number {
  let depth = 0;
  for (let index = open; index < latex.length; index += 1) {
    const character = latex[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
