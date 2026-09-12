/**
 * TeXを直接書かずに数式を組み立てるためのテンプレート一覧。
 * ツールバーの「数式」ポップオーバー (`InlineMathDetails`) がそのままボタンとして描画する。
 *
 * `#?` はMathLiveのプレースホルダー。挿入後に順番へ入力できる箇所を表し、
 * ボタン上のプレビューでは `\placeholder{\square}` として描かれる。
 */
export interface MathTemplateButton {
  id: string;
  label: string;
  tex: string;
}

/**
 * 見出しの辞書キー (`shape.mathTemplateGroup.<id>`) をそのまま作れるように、
 * id は文字列ではなくリテラルの列挙で持つ。`string` にすると `t()` の型検査が効かず、
 * 綴り間違いが実行時の生キー表示になる。
 */
export type MathTemplateGroupId =
  | "functions"
  | "sigma-limit"
  | "combinatorics"
  | "arrows"
  | "scripts"
  | "fractions-roots"
  | "brackets"
  | "matrices"
  | "accents"
  | "exponential-log"
  | "inverse-trig"
  | "hyperbolic"
  | "sets-products"
  | "integrals"
  | "max-min"
  | "sup-inf"
  | "limit-variants"
  | "linear-algebra";

export interface MathTemplateGroup {
  id: MathTemplateGroupId;
  /**
   * 見出しは持たない。**`shape` namespace の `mathTemplateGroup.<id>` が唯一の出典**で、
   * 描画する面が `t()` で引く。ここに日本語を焼くと、パレットの外枠だけ訳されて
   * 見出しだけ日本語で残る (WI-6b の code-review 指摘)。
   */
  templates: MathTemplateButton[];
}

export const INLINE_MATH_TEMPLATE_GROUPS: MathTemplateGroup[] = [
  {
    id: "functions",
    templates: [
      { id: "sin", label: "sin", tex: "\\sin #?" },
      { id: "cos", label: "cos", tex: "\\cos #?" },
      { id: "tan", label: "tan", tex: "\\tan #?" },
      { id: "sin-power", label: "sin power", tex: "\\sin^{#?} #?" },
      { id: "log-base", label: "log base", tex: "\\log_{#?} #?" },
      { id: "function", label: "f(x)", tex: "f\\left(#?\\right)" },
    ],
  },
  {
    id: "sigma-limit",
    templates: [
      { id: "sum", label: "sum", tex: "\\sum_{#?}^{#?} #?" },
      { id: "integral", label: "integral", tex: "\\int #?" },
      { id: "definite-integral", label: "definite integral", tex: "\\int_{#?}^{#?} #?" },
      { id: "limit", label: "limit", tex: "\\lim_{#?\\to#?}" },
      { id: "arg", label: "arg", tex: "\\arg #?" },
      { id: "mod", label: "mod", tex: "\\bmod #?" },
    ],
  },
  {
    // 左下の添字は **`{}` を前置しない**。TeXの教科書表記は `{}_n\mathrm{C}_r` だが、
    // MathLiveはこの空グループを往復のたびに `{}` として吐き直し、編集して閉じるたびに
    // 末尾の `{}` が3個ずつ増え続ける (3→15→…)。`_n\mathrm{C}_r` ならMathLive・KaTeXとも
    // 同じ見た目で、往復しても文字列が変わらない。
    // C/P/H を立体 (`\mathrm`) にするのは日本の教科書表記に合わせるため。
    id: "combinatorics",
    templates: [
      { id: "combination", label: "nCr", tex: "_{#?}\\mathrm{C}_{#?}" },
      { id: "permutation", label: "nPr", tex: "_{#?}\\mathrm{P}_{#?}" },
      { id: "repeated-combination", label: "nHr", tex: "_{#?}\\mathrm{H}_{#?}" },
      { id: "binomial-coefficient", label: "binomial coefficient", tex: "\\binom{#?}{#?}" },
      { id: "factorial", label: "factorial", tex: "#?!" },
    ],
  },
  {
    id: "arrows",
    templates: [
      { id: "to", label: "to", tex: "\\to" },
      { id: "leftarrow", label: "left arrow", tex: "\\leftarrow" },
      { id: "leftrightarrow", label: "left right arrow", tex: "\\leftrightarrow" },
      { id: "implies", label: "implies", tex: "\\Rightarrow" },
      { id: "iff", label: "iff", tex: "\\Leftrightarrow" },
      { id: "tex-iff", label: "iff command", tex: "\\iff" },
    ],
  },
  {
    id: "scripts",
    templates: [
      { id: "superscript", label: "superscript", tex: "{#?}^{#?}" },
      { id: "subscript", label: "subscript", tex: "{#?}_{#?}" },
      { id: "subscript-superscript", label: "subscript superscript", tex: "{#?}_{#?}^{#?}" },
      { id: "superscript-subscript", label: "superscript subscript", tex: "{#?}^{#?}_{#?}" },
    ],
  },
  {
    id: "fractions-roots",
    templates: [
      { id: "fraction", label: "fraction", tex: "\\frac{#?}{#?}" },
      { id: "sqrt", label: "square root", tex: "\\sqrt{#?}" },
      { id: "nth-root", label: "nth root", tex: "\\sqrt[#?]{#?}" },
    ],
  },
  {
    id: "brackets",
    templates: [
      { id: "parentheses", label: "parentheses", tex: "\\left(#?\\right)" },
      { id: "braces", label: "braces", tex: "\\left\\{#?\\right\\}" },
      { id: "brackets", label: "brackets", tex: "\\left[#?\\right]" },
      { id: "absolute-value", label: "absolute value", tex: "\\left|#?\\right|" },
    ],
  },
  {
    id: "matrices",
    templates: [
      { id: "matrix-2x2", label: "2 by 2 matrix", tex: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}" },
      { id: "vector-2", label: "2 vector", tex: "\\begin{pmatrix}#?\\\\#?\\end{pmatrix}" },
      { id: "cases-2", label: "2 cases", tex: "\\begin{cases}#?\\\\#?\\end{cases}" },
    ],
  },
  {
    id: "accents",
    templates: [
      { id: "vector-accent", label: "vector", tex: "\\vec{#?}" },
      { id: "overline", label: "overline", tex: "\\overline{#?}" },
      { id: "hat", label: "hat", tex: "\\hat{#?}" },
      { id: "dot", label: "dot", tex: "\\dot{#?}" },
    ],
  },
  {
    id: "exponential-log",
    templates: [
      { id: "exp", label: "exp", tex: "\\exp #?" },
      { id: "ln", label: "ln", tex: "\\ln #?" },
      { id: "lg", label: "lg", tex: "\\operatorname{lg} #?" },
    ],
  },
  {
    id: "inverse-trig",
    templates: [
      { id: "sin-inverse-power", label: "sin inverse power", tex: "\\sin^{-1} #?" },
      { id: "cos-inverse-power", label: "cos inverse power", tex: "\\cos^{-1} #?" },
      { id: "tan-inverse-power", label: "tan inverse power", tex: "\\tan^{-1} #?" },
      { id: "sin-inverse", label: "Sin inverse", tex: "\\operatorname{Sin}^{-1} #?" },
      { id: "cos-inverse", label: "Cos inverse", tex: "\\operatorname{Cos}^{-1} #?" },
      { id: "tan-inverse", label: "Tan inverse", tex: "\\operatorname{Tan}^{-1} #?" },
      { id: "arcsin", label: "arcsin", tex: "\\arcsin #?" },
      { id: "arccos", label: "arccos", tex: "\\arccos #?" },
      { id: "arctan", label: "arctan", tex: "\\arctan #?" },
      { id: "Arcsin", label: "Arcsin", tex: "\\operatorname{Arcsin} #?" },
      { id: "Arccos", label: "Arccos", tex: "\\operatorname{Arccos} #?" },
      { id: "Arctan", label: "Arctan", tex: "\\operatorname{Arctan} #?" },
    ],
  },
  {
    id: "hyperbolic",
    templates: [
      { id: "sinh", label: "sinh", tex: "\\sinh #?" },
      { id: "cosh", label: "cosh", tex: "\\cosh #?" },
      { id: "tanh", label: "tanh", tex: "\\tanh #?" },
      { id: "sinh-power", label: "sinh power", tex: "\\sinh^{#?} #?" },
      { id: "cosh-power", label: "cosh power", tex: "\\cosh^{#?} #?" },
      { id: "tanh-power", label: "tanh power", tex: "\\tanh^{#?} #?" },
    ],
  },
  {
    id: "sets-products",
    templates: [
      { id: "sum-indexed", label: "indexed sum", tex: "\\sum_{#?} #?" },
      { id: "product-indexed", label: "indexed product", tex: "\\prod_{#?} #?" },
      { id: "coproduct-indexed", label: "indexed coproduct", tex: "\\coprod_{#?} #?" },
      { id: "bigcup-indexed", label: "indexed union", tex: "\\bigcup_{#?} #?" },
      { id: "cup-indexed", label: "union", tex: "\\cup_{#?} #?" },
      { id: "bigcap-indexed", label: "indexed intersection", tex: "\\bigcap_{#?} #?" },
      { id: "cap-indexed", label: "intersection", tex: "\\cap_{#?} #?" },
      { id: "bigoplus-indexed", label: "indexed direct sum", tex: "\\bigoplus_{#?} #?" },
      { id: "oplus-indexed", label: "direct sum", tex: "\\oplus_{#?} #?" },
    ],
  },
  {
    id: "integrals",
    templates: [
      { id: "integral-with-differential", label: "integral with differential", tex: "\\int #?\\,d#?" },
      { id: "double-integral", label: "double integral", tex: "\\iint #?\\,d#?" },
      { id: "triple-integral", label: "triple integral", tex: "\\iiint #?\\,d#?" },
      { id: "contour-integral", label: "contour integral", tex: "\\oint #?\\,d#?" },
    ],
  },
  {
    id: "max-min",
    templates: [
      { id: "max", label: "max", tex: "\\max #?" },
      { id: "min", label: "min", tex: "\\min #?" },
      { id: "max-under", label: "max with condition", tex: "\\max_{#?} #?" },
      { id: "min-under", label: "min with condition", tex: "\\min_{#?} #?" },
    ],
  },
  {
    id: "sup-inf",
    templates: [
      { id: "sup", label: "sup", tex: "\\sup #?" },
      { id: "inf", label: "inf", tex: "\\inf #?" },
      { id: "sup-under", label: "sup with condition", tex: "\\sup_{#?} #?" },
      { id: "inf-under", label: "inf with condition", tex: "\\inf_{#?} #?" },
    ],
  },
  {
    id: "limit-variants",
    templates: [
      { id: "limsup-overline", label: "overline limit", tex: "\\overline{\\lim}_{#?\\to#?} #?" },
      { id: "limit-to", label: "limit to", tex: "\\lim_{#?\\to#?} #?" },
      { id: "limsup", label: "limsup", tex: "\\limsup_{#?\\to#?} #?" },
      { id: "liminf", label: "liminf", tex: "\\liminf_{#?\\to#?} #?" },
    ],
  },
  {
    id: "linear-algebra",
    templates: [
      { id: "det", label: "det", tex: "\\det #?" },
      { id: "sgn", label: "sgn", tex: "\\operatorname{sgn} #?" },
      { id: "rank", label: "rank", tex: "\\operatorname{rank} #?" },
      { id: "dim", label: "dim", tex: "\\dim #?" },
      { id: "tr", label: "tr", tex: "\\operatorname{tr} #?" },
      { id: "Tr", label: "Tr", tex: "\\operatorname{Tr} #?" },
      { id: "Ker", label: "Ker", tex: "\\operatorname{Ker} #?" },
      { id: "Im", label: "Im", tex: "\\operatorname{Im} #?" },
    ],
  },
];

/**
 * 画像から起こして後から足したグループ。既存の並びを崩さないよう、パレットの末尾へ回す。
 */
const IMAGE_ADDED_INLINE_MATH_TEMPLATE_GROUP_IDS = new Set([
  "exponential-log",
  "inverse-trig",
  "hyperbolic",
  "sets-products",
  "integrals",
  "max-min",
  "sup-inf",
  "limit-variants",
  "linear-algebra",
]);

export const ORDERED_INLINE_MATH_TEMPLATE_GROUPS = [
  ...INLINE_MATH_TEMPLATE_GROUPS.filter((group) => !IMAGE_ADDED_INLINE_MATH_TEMPLATE_GROUP_IDS.has(group.id)),
  ...INLINE_MATH_TEMPLATE_GROUPS.filter((group) => IMAGE_ADDED_INLINE_MATH_TEMPLATE_GROUP_IDS.has(group.id)),
];
