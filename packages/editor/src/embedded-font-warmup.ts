/**
 * Warms the webfonts the embedded editor's first layout pass depends on.
 *
 * Math is rendered by MathLive (`convertLatexToMarkup`) using the same KaTeX_*
 * font families KaTeX itself ships (see katex.min.css / mathlive-static.css —
 * both declare the same @font-face set, no extra families). Body text uses
 * the `M PLUS 1p` faces from @fontsource/m-plus-1p. Until these are loaded,
 * math nodes measure as blank/zero-size boxes, so anything whose layout
 * depends on measuring them (in particular block-anchored overlay shapes)
 * gets positioned from the wrong geometry and visibly snaps into place once
 * the fonts land. Loading them up front lets the first real layout pass
 * already be correct.
 */

type FontStyle = "normal" | "italic";

// KaTeX's own font files carry no `unicode-range` (one file per family/weight/
// style, see katex.min.css), so the sample text below doesn't need to cover
// any particular glyph set for them — `document.fonts.load` just needs to
// resolve the @font-face and fetch it. `M PLUS 1p` (from @fontsource) *is*
// split into per-block unicode-range subsets, so the sample text is chosen to
// span the scripts a Japanese math document actually uses (ASCII letters/
// digits, hiragana, katakana, common kanji) so the right subsets get pulled.
const FONT_WARMUP_SAMPLE_TEXT = "0123456789ABCabcあいうえおアイウエオ数式問題解答";

const MATH_FONT_FACES: ReadonlyArray<readonly [family: string, weight: number, style: FontStyle]> = [
  ["KaTeX_AMS", 400, "normal"],
  ["KaTeX_Caligraphic", 700, "normal"],
  ["KaTeX_Caligraphic", 400, "normal"],
  ["KaTeX_Fraktur", 700, "normal"],
  ["KaTeX_Fraktur", 400, "normal"],
  ["KaTeX_Main", 700, "normal"],
  ["KaTeX_Main", 700, "italic"],
  ["KaTeX_Main", 400, "italic"],
  ["KaTeX_Main", 400, "normal"],
  ["KaTeX_Math", 700, "italic"],
  ["KaTeX_Math", 400, "italic"],
  ["KaTeX_SansSerif", 700, "normal"],
  ["KaTeX_SansSerif", 400, "italic"],
  ["KaTeX_SansSerif", 400, "normal"],
  ["KaTeX_Script", 400, "normal"],
  ["KaTeX_Size1", 400, "normal"],
  ["KaTeX_Size2", 400, "normal"],
  ["KaTeX_Size3", 400, "normal"],
  ["KaTeX_Size4", 400, "normal"],
  ["KaTeX_Typewriter", 400, "normal"],
];

const BODY_FONT_FACES: ReadonlyArray<readonly [family: string, weight: number, style: FontStyle]> = [
  ["M PLUS 1p", 400, "normal"],
  ["M PLUS 1p", 500, "normal"],
  ["M PLUS 1p", 700, "normal"],
];

/** A font that never loads (blocked request, host CSP, ...) must never wedge the editor behind the loading cover. */
const FONT_WARMUP_TIMEOUT_MS = 2000;

function toFontShorthand(family: string, weight: number, style: FontStyle): string {
  const quotedFamily = family.includes(" ") ? `"${family}"` : family;
  return style === "italic" ? `italic ${weight} 1em ${quotedFamily}` : `${weight} 1em ${quotedFamily}`;
}

/**
 * Resolves once the math/body fonts are loaded (or best-effort after they
 * fail/hang) — never rejects, and never takes longer than
 * FONT_WARMUP_TIMEOUT_MS. Safe to call in SSR/older-browser environments
 * without the CSS Font Loading API (see docs/embedding-guide.md Compatibility).
 */
export async function warmEmbeddedEditorFonts(): Promise<void> {
  if (typeof document === "undefined" || typeof document.fonts?.load !== "function") {
    return;
  }

  const fontSet = document.fonts;
  const specs = [...MATH_FONT_FACES, ...BODY_FONT_FACES].map(([family, weight, style]) => toFontShorthand(family, weight, style));

  const warmup = Promise.allSettled(
    specs.map((spec) => fontSet.load(spec, FONT_WARMUP_SAMPLE_TEXT)),
  ).then(() => fontSet.ready).then(() => undefined).catch(() => undefined);

  await Promise.race([
    warmup,
    new Promise<void>((resolve) => setTimeout(resolve, FONT_WARMUP_TIMEOUT_MS)),
  ]);
}
