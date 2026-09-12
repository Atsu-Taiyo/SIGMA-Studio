import { parseTexPreamble, type TexPreambleIssue } from "@/lib/tex-preamble";

export const KYOUTSUU_CHOICE_CLASS = "sigma-kyoutsuu-choice";

/**
 * `<math-field>` の Shadow DOM へ入れる、組み込みマクロ専用の最小スタイル。
 * 静的 MathLive / KaTeX / 印刷 / Viewer は document-surface.css の同じ規則を使う。
 * document-surface.test.ts が両者の宣言一致を固定する。
 */
export const SIGMA_MATHLIVE_MACRO_STYLES = String.raw`
.${KYOUTSUU_CHOICE_CLASS} {
  align-items: center;
  block-size: 1.28em;
  border: 0.14em solid currentColor;
  border-radius: 50%;
  box-sizing: border-box;
  display: inline-flex !important;
  font-family: Arial, "Helvetica Neue", sans-serif;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  inline-size: 0.9em;
  justify-content: center;
  line-height: 1;
  vertical-align: 0.14em;
}

.${KYOUTSUU_CHOICE_CLASS} > .ML__text,
.${KYOUTSUU_CHOICE_CLASS} > .text {
  align-items: center;
  display: inline-flex;
  font-family: inherit !important;
  font-size: 0.78em;
  font-style: inherit;
  font-variant-numeric: inherit;
  font-weight: inherit;
  justify-content: center;
  line-height: 1;
}

.${KYOUTSUU_CHOICE_CLASS} > .text > .mord {
  font: inherit;
}`;

/**
 * Sigma Studio-specific math macros shared by MathLive editing and KaTeX output.
 * Keep these as TeX-only expansions so every renderer preserves the same result.
 */
export const SIGMA_MATHLIVE_MACROS = {
  kyoutsuuchoice: {
    def: String.raw`\class{${KYOUTSUU_CHOICE_CLASS}}{\textbf{#1}}`,
    args: 1,
  },
  doubleboxed: {
    def: String.raw`\class{sigma-doubleboxed}{\boxed{#1}}`,
    args: 1,
  },
  thickboxed: {
    def: String.raw`\class{sigma-thickboxed}{\boxed{#1}}`,
    args: 1,
  },
  outerthickdoubleboxed: {
    def: String.raw`\class{sigma-outerthick-doubleboxed}{\boxed{#1}}`,
    args: 1,
  },
} as const;

export const SIGMA_KATEX_MACROS = {
  [String.raw`\kyoutsuuchoice`]: String.raw`\htmlClass{${KYOUTSUU_CHOICE_CLASS}}{\textbf{#1}}`,
  [String.raw`\doubleboxed`]: String.raw`\htmlClass{sigma-doubleboxed}{\boxed{#1}}`,
  [String.raw`\thickboxed`]: String.raw`\htmlClass{sigma-thickboxed}{\boxed{#1}}`,
  [String.raw`\outerthickdoubleboxed`]: String.raw`\htmlClass{sigma-outerthick-doubleboxed}{\boxed{#1}}`,
} as const;

export interface MathMacroSet {
  issues: TexPreambleIssue[];
  katexMacros: Readonly<Record<string, string>>;
  mathLiveMacros: Readonly<Record<string, { args: number; def: string }>>;
  /**
   * このマクロ集合を一意に指す短い印。**前文そのものではなく通し番号**を使う —
   * この値は数式 markup / 採寸の LRU キャッシュキーの先頭に必ず載るので、前文 (スキーマ上限
   * 20,000 字) を直接入れると打鍵ごとに数式の数だけ 20KB の文字列を組み立てて比較することになる。
   * 同じ前文からは必ず同じインスタンス (= 同じ番号) が返るので、ハッシュ衝突の危険も無い。
   */
  signature: string;
}

// 同じ前文からは同じインスタンスを返す。番号を安定させるためだけでなく、前文の再パースも省ける。
// 前文は文書ごとに 1 つで滅多に変わらないので、上限はごく小さくてよい。
const macroSetsByPreamble = new Map<string, MathMacroSet>();
const MACRO_SET_CACHE_LIMIT = 32;
let macroSetSequence = 0;

export function createMathMacroSet(preamble = ""): MathMacroSet {
  const cached = macroSetsByPreamble.get(preamble);
  if (cached) {
    return cached;
  }

  const parsed = parseTexPreamble(preamble);
  const customMathLiveMacros = Object.fromEntries(
    Object.entries(parsed.macros).map(([name, definition]) => [name, definition]),
  );
  const customKatexMacros = Object.fromEntries(
    Object.entries(parsed.macros).map(([name, definition]) => [`\\${name}`, definition.def]),
  );
  macroSetSequence += 1;
  const macroSet: MathMacroSet = {
    issues: parsed.issues,
    katexMacros: { ...SIGMA_KATEX_MACROS, ...customKatexMacros },
    mathLiveMacros: { ...SIGMA_MATHLIVE_MACROS, ...customMathLiveMacros },
    signature: `m${macroSetSequence}`,
  };
  if (macroSetsByPreamble.size >= MACRO_SET_CACHE_LIMIT) {
    const oldest = macroSetsByPreamble.keys().next().value;
    if (oldest !== undefined) {
      macroSetsByPreamble.delete(oldest);
    }
  }
  macroSetsByPreamble.set(preamble, macroSet);
  return macroSet;
}

export const DEFAULT_MATH_MACRO_SET = createMathMacroSet();

/**
 * Sigma 自前の装飾マクロだけが出すクラス。数式 markup の中にしか現れないので、
 * CSS 衝突の門番 (`math-class-collision.test.ts`) はこれを数式コンテナとして扱う。
 */
export const TRUSTED_SIGMA_MATH_CLASSES: ReadonlySet<string> = new Set([
  KYOUTSUU_CHOICE_CLASS,
  "sigma-doubleboxed",
  "sigma-thickboxed",
  "sigma-outerthick-doubleboxed",
]);

/** Trust only fixed classes emitted by Sigma Studio's internal math macros. */
export function trustSigmaKatexMacro(context: { command: string; class?: string }): boolean {
  return context.command === String.raw`\htmlClass` && Boolean(context.class && TRUSTED_SIGMA_MATH_CLASSES.has(context.class));
}
