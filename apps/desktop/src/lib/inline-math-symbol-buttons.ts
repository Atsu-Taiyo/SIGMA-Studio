export type InlineMathSymbolButton = {
  label: string;
  tex: string;
  title?: string;
};

export type InlineMathSymbolGroup = {
  id: string;
  heading: string;
  buttons: InlineMathSymbolButton[];
};

export const INLINE_MATH_SYMBOL_GROUPS: InlineMathSymbolGroup[] = [
  {
    id: "templates",
    heading: "テンプレート",
    buttons: [
      { label: "x²", tex: "^{#?}", title: "上付き" },
      { label: "x₁", tex: "_{#?}", title: "下付き" },
      { label: "ab", tex: "\\frac{#?}{#?}", title: "分数" },
      { label: "√x", tex: "\\sqrt{#?}", title: "平方根" },
      { label: "ⁿ√x", tex: "\\sqrt[#?]{#?}", title: "n乗根" },
      { label: "( )", tex: "\\left(#?\\right)", title: "丸かっこ" },
      { label: "[ ]", tex: "\\left[#?\\right]", title: "角かっこ" },
      { label: "{ }", tex: "\\left\\{#?\\right\\}", title: "波かっこ" },
      { label: "|x|", tex: "\\left|#?\\right|", title: "絶対値" },
    ],
  },
  {
    id: "operators",
    heading: "演算子",
    buttons: [
      { label: "+", tex: "+" },
      { label: "−", tex: "-" },
      { label: "×", tex: "\\times" },
      { label: "÷", tex: "\\div" },
      { label: "·", tex: "\\cdot" },
      { label: "±", tex: "\\pm" },
      { label: "∓", tex: "\\mp" },
      { label: "∘", tex: "\\circ" },
    ],
  },
  {
    id: "relations",
    heading: "関係",
    buttons: [
      { label: "=", tex: "=" },
      { label: "≠", tex: "\\neq" },
      { label: "≤", tex: "\\leqq" },
      { label: "≥", tex: "\\geqq" },
      { label: "≪", tex: "\\ll" },
      { label: "≫", tex: "\\gg" },
      { label: "≈", tex: "\\approx" },
      { label: "≡", tex: "\\equiv" },
      { label: "∼", tex: "\\sim" },
      { label: "∝", tex: "\\propto" },
    ],
  },
  {
    id: "big-operators",
    heading: "大型演算子",
    buttons: [
      { label: "Σ", tex: "\\sum_{#?}^{#?} #?", title: "総和" },
      { label: "Π", tex: "\\prod_{#?}^{#?} #?", title: "総乗" },
      { label: "∫", tex: "\\int_{#?}^{#?} #?", title: "定積分" },
      { label: "∮", tex: "\\oint" },
      { label: "lim", tex: "\\lim_{#?} #?", title: "極限" },
      { label: "log", tex: "\\log" },
      { label: "ln", tex: "\\ln" },
    ],
  },
  {
    id: "arrows",
    heading: "矢印",
    buttons: [
      { label: "→", tex: "\\to" },
      { label: "←", tex: "\\leftarrow" },
      { label: "↔", tex: "\\leftrightarrow" },
      { label: "⇒", tex: "\\Rightarrow" },
      { label: "⇐", tex: "\\Leftarrow" },
      { label: "⇔", tex: "\\Leftrightarrow" },
      { label: "↦", tex: "\\mapsto" },
    ],
  },
  {
    id: "greek",
    heading: "ギリシャ文字",
    buttons: [
      { label: "α", tex: "\\alpha" },
      { label: "β", tex: "\\beta" },
      { label: "γ", tex: "\\gamma" },
      { label: "δ", tex: "\\delta" },
      { label: "ε", tex: "\\epsilon" },
      { label: "θ", tex: "\\theta" },
      { label: "λ", tex: "\\lambda" },
      { label: "μ", tex: "\\mu" },
      { label: "π", tex: "\\pi" },
      { label: "ρ", tex: "\\rho" },
      { label: "σ", tex: "\\sigma" },
      { label: "τ", tex: "\\tau" },
      { label: "φ", tex: "\\phi" },
      { label: "χ", tex: "\\chi" },
      { label: "ψ", tex: "\\psi" },
      { label: "ω", tex: "\\omega" },
      { label: "Δ", tex: "\\Delta" },
      { label: "Γ", tex: "\\Gamma" },
      { label: "Θ", tex: "\\Theta" },
      { label: "Λ", tex: "\\Lambda" },
      { label: "Σ", tex: "\\Sigma" },
      { label: "Φ", tex: "\\Phi" },
      { label: "Ψ", tex: "\\Psi" },
      { label: "Ω", tex: "\\Omega" },
    ],
  },
  {
    id: "sets",
    heading: "集合・論理",
    buttons: [
      { label: "∈", tex: "\\in" },
      { label: "∉", tex: "\\notin" },
      { label: "⊂", tex: "\\subset" },
      { label: "⊃", tex: "\\supset" },
      { label: "⊆", tex: "\\subseteq" },
      { label: "⊇", tex: "\\supseteq" },
      { label: "∪", tex: "\\cup" },
      { label: "∩", tex: "\\cap" },
      { label: "∅", tex: "\\emptyset" },
      { label: "∀", tex: "\\forall" },
      { label: "∃", tex: "\\exists" },
      { label: "∞", tex: "\\infty" },
      { label: "∂", tex: "\\partial" },
      { label: "∇", tex: "\\nabla" },
    ],
  },
];
