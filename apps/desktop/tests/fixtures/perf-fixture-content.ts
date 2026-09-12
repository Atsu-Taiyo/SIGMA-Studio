/**
 * Deterministic inline content used by the perf-probe fixtures.
 *
 * Every value here is a pure function of its arguments — no `Math.random()`, no `Date.now()`, no
 * `createId()`. The probe compares numbers across branches, so two runs of the same fixture have to
 * produce byte-identical JSON or the comparison measures the fixture instead of the editor.
 */
import type { InlineNode, MathInlineNode, ParagraphNode, TextInlineNode } from "@/types/sigma-doc";

/** Roughly one A4 line each at the default body font, so paragraph count ≈ line count. */
const SENTENCES: readonly string[] = [
  "二次関数の頂点を平方完成で求め、グラフの概形を確認する。",
  "与えられた条件から定義域を絞り込み、端点の値を比較する。",
  "三角比の相互関係を使って式を一つの文字だけで表す。",
  "数列の階差をとり、一般項を推測してから数学的帰納法で示す。",
  "ベクトルの内積が零になる条件から垂直な位置関係を導く。",
  "確率の余事象を考えると場合の数の数え上げが簡単になる。",
  "微分係数の符号の変化を調べて増減表を作り極値を求める。",
  "定積分の値を面積として解釈し、上下の関係を図で確かめる。",
];

const TEX_TEMPLATES: ReadonlyArray<(a: number, b: number) => string> = [
  (a, b) => `x^{2}+${a}x+${b}=0`,
  (a, b) => `\\frac{${a}x+${b}}{x^{2}+1}`,
  (a, b) => `\\sqrt{${a}x+${b}}`,
  (a, b) => `\\sin ${a}\\theta+\\cos ${b}\\theta`,
  (a, b) => `\\int_{0}^{${a}} x^{${b}}\\,dx`,
  (a, b) => `\\lim_{n \\to \\infty}\\frac{${a}n+${b}}{n+1}`,
  (a, b) => `\\sum_{k=1}^{${a}} (2k-${b})`,
  (a, b) => `\\log_{${a}} ${b}x`,
];

export function perfSentence(index: number): string {
  return SENTENCES[index % SENTENCES.length];
}

export function perfTex(index: number): string {
  const template = TEX_TEMPLATES[index % TEX_TEMPLATES.length];
  return template((index % 9) + 1, (index % 5) + 2);
}

export function perfTextNode(index: number, prefix = ""): TextInlineNode {
  return {
    type: "text",
    text: `${prefix}${perfSentence(index)}`,
    fontFamily: "serif",
  };
}

export function perfMathNode(id: string, index: number): MathInlineNode {
  return {
    type: "mathInline",
    id,
    tex: perfTex(index),
    display: "inline",
  };
}

export interface PerfParagraphOptions {
  /** Append one `mathInline` node (plus a trailing text run) to the paragraph. */
  math?: boolean;
  /** Emit a paragraph with no children — the empty line boxes real documents are full of. */
  empty?: boolean;
  /** Text placed before the generated sentence, e.g. a problem number. */
  prefix?: string;
  /** Mark the leading run as a boxed emphasis run (exercises the boxed-run height extension). */
  boxed?: boolean;
}

export function perfParagraph(
  id: string,
  index: number,
  options: PerfParagraphOptions = {},
): ParagraphNode {
  if (options.empty) {
    return { type: "paragraph", id, lineHeight: "1.5", children: [] };
  }

  const leading = perfTextNode(index, options.prefix);
  const children: InlineNode[] = [
    options.boxed ? { ...leading, marks: ["boxed"] } : leading,
  ];
  if (options.math) {
    children.push(perfMathNode(`${id}_math`, index));
    children.push({ type: "text", text: "を満たす。", fontFamily: "serif" });
  }
  return { type: "paragraph", id, lineHeight: "1.5", children };
}
