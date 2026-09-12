import type { MathFractionSizing } from "@/features/document";

/**
 * 数式の組版スタイル (TeX の mathstyle)。**文書の組版スタイルの唯一の出典**で、
 * 静的描画 (MathLive / KaTeX) と編集中の `math-field` は必ずここから導く。
 *
 * なぜ 1 箇所に集約するのか (実測、mathlive 0.109.2 / katex 0.16.45):
 *
 * - 静的な `convertLatexToMarkup` は `defaultMode` を**無視して常に displaystyle** で描く。
 *   `defaultMode` が mathstyle に効くのは `MathfieldElement` (= 編集中の `math-field`) だけ
 *   (`mathlive.mjs` の `makeBox` が `defaultMode === "inline-math" ? "textstyle" : "displaystyle"`)。
 * - KaTeX の既定は逆に textstyle。
 *
 * つまり組版スタイルの出典が「静的 MathLive の暗黙 displaystyle」「KaTeX の暗黙 textstyle」
 * 「math-field の `defaultMode`」の 3 つに割れていたのが、同じ TeX が面ごとに別の組版で
 * 描かれていた根本原因。**静的側は TeX への前置で、field 側は `defaultMode` で**、
 * どちらもこのモジュールの 1 つの値から導くことで一致させる。
 *
 * KaTeX を `displayMode: true` にはしない — `.katex-display` (block + 中央寄せ + margin) が
 * 付いて行内配置が壊れる。`\displaystyle` 前置は同じ組版を `.katex-display` 無しで出す (実測)。
 */
export type MathTypesetStyle = "displaystyle" | "textstyle";

/** 用紙設定が無い文書の組版スタイル。印刷/静的表示の現行既定 (displaystyle) に合わせる。 */
export const DEFAULT_MATH_TYPESET_STYLE: MathTypesetStyle = "displaystyle";

/** 静的レンダラ (MathLive / KaTeX) に組版スタイルを伝える TeX コマンド。 */
const MATH_TYPESET_STYLE_COMMAND: Readonly<Record<MathTypesetStyle, string>> = {
  displaystyle: "\\displaystyle",
  textstyle: "\\textstyle",
};

/** `MathfieldElement` に組版スタイルを伝える `defaultMode` の値。 */
const MATH_FIELD_DEFAULT_MODE: Readonly<Record<MathTypesetStyle, "inline-math" | "math">> = {
  displaystyle: "math",
  textstyle: "inline-math",
};

/**
 * 用紙設定「分数を常に同じ大きさで表示」(`metadata.mathFractionSizing`) を組版スタイルへ写す。
 * `uniform` (既定) = displaystyle、`texDefault` = TeX 既定のインライン組版 = textstyle。
 */
export function resolveMathTypesetStyle(fractionSizing?: MathFractionSizing | null): MathTypesetStyle {
  return fractionSizing === "texDefault" ? "textstyle" : DEFAULT_MATH_TYPESET_STYLE;
}

/**
 * 静的レンダラへ渡す TeX に組版スタイルを前置する。**保存される SigmaDoc の TeX は書き換えない**
 * (描画時にだけ前置する) ので、確定時に `\dfrac` などが本文へ焼き付くことはない。
 */
export function applyMathTypesetStyle(tex: string, style: MathTypesetStyle): string {
  return `${MATH_TYPESET_STYLE_COMMAND[style]} ${tex}`;
}

/** 編集中の `math-field` に与える `defaultMode`。静的側の前置と同じ 1 つの値から導く。 */
export function mathFieldDefaultMode(style: MathTypesetStyle): "inline-math" | "math" {
  return MATH_FIELD_DEFAULT_MODE[style];
}
