import katex from "katex";
// `katex/src/fontMetricsData.js` is a deep import into KaTeX's own generated font metrics table
// (package.json exposes `"./*": "./*"`). We use it only to recover the true per-character width
// of KaTeX symbol nodes that its own `buildCommon.tryCombineChars` corrupts when merging adjacent
// glyphs (see `computeLeafWidthEm` below) -- we never invent our own TeX box-layout model, we only
// re-derive widths KaTeX's own renderer already computed but stopped tracking correctly.
import fontMetricsData from "katex/src/fontMetricsData.js";

import { applyMathTypesetStyle } from "@/features/rendering/core";
import {
  mathRenderEnvironmentCacheKey,
  type MathRenderEnvironment,
} from "@/lib/math-environment";
import { convertLatexToMarkupCached, toKatexPreviewTex } from "@/lib/math-tex";
import { trustSigmaKatexMacro, type MathMacroSet } from "@/lib/math-macros";

/**
 * Box metrics for a TeX formula, in em units relative to the formula's own font size (i.e. not
 * yet multiplied by any `fontSizePx`). `ascentEm`/`descentEm` describe the vertical box (from the
 * text baseline) and `widthEm` the horizontal box. `source` records which measurement strategy
 * produced the numbers, mostly for tests/debugging.
 */
export interface MathBoxMetricsEm {
  ascentEm: number;
  descentEm: number;
  widthEm: number;
  source: "mathlive" | "katex" | "heuristic";
}

interface KatexTreeNode {
  classes?: string[];
  style?: Record<string, string>;
  text?: string;
  width?: number;
  height?: number;
  depth?: number;
  children?: KatexTreeNode[];
}

const FONT_METRICS_TABLE = fontMetricsData as unknown as Record<string, Record<string, number[]>>;

// `__renderToHTMLTree` is KaTeX's own internal DOM-free tree renderer (used by its test suite),
// exposed on the runtime object but intentionally left off the public `.d.ts` types.
const katexRenderToHTMLTree = (
  katex as unknown as {
    __renderToHTMLTree: (
      tex: string,
      options: typeof KATEX_MEASURE_OPTIONS & { macros?: MathMacroSet["katexMacros"] },
    ) => KatexTreeNode;
  }
).__renderToHTMLTree;

// MathLive's SSR/DOM markup always wraps a formula in a leading pair of struts: `ML__strut`'s
// height is the ascent, and (when the formula has any depth) `ML__strut--bottom`'s height is
// ascent+depth with `vertical-align` carrying `-depth`. This is the exact markup
// `convertLatexToMarkupCached` returns for `dangerouslySetInnerHTML`, so reading it keeps
// measurement and rendering from ever disagreeing structurally.
const MATHLIVE_STRUT_ASCENT_PATTERN = /class="ML__strut" style="height:([0-9.]+)em"/;
const MATHLIVE_STRUT_TOTAL_PATTERN = /class="ML__strut--bottom" style="height:([0-9.]+)em;vertical-align:-([0-9.]+)em"/;

const KATEX_MEASURE_OPTIONS = {
  maxExpand: 1000,
  maxSize: 100,
  output: "html" as const,
  strict: "ignore" as const,
  throwOnError: true,
  // This tree is inspected for dimensions and is never inserted into the DOM.
  // Without accepting a font-only wrapper, KaTeX measures the red unsupported
  // command name instead of its operand, inflating editable formula boxes.
  // The displayed markup continues to use the separate sanitizer/trust policy.
  trust: (context: { command: string; class?: string; style?: string }) =>
    trustSigmaKatexMacro(context)
    || (context.command === "\\htmlStyle"
      && /^\s*font-family\s*:\s*[\p{L}\p{N} ,'_.-]+\s*;?\s*$/u.test(context.style ?? "")),
};

// Macros whose rendered box is reliably taller than one text line even when both measurers fail
// (unknown macro, parse error, etc.) -- used only by the last-resort heuristic branch.
const STRUCTURAL_MACRO_PATTERN = /\\(?:frac|dfrac|tfrac|cfrac|sqrt|int|oint|iint|iiint|sum|prod|coprod|lim|begin|binom|dbinom|tbinom|overbrace|underbrace)\b/;

// KaTeX's CSS scale ladder for `reset-sizeN sizeM` wrapper classes (nested script/sizing spans).
// Index 0 = size1 ... index 10 = size11. Taken from KaTeX's own `sizeStyleMap`/`SIZES` table.
const KATEX_SIZES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488];
const RESET_SIZE_CLASS_PATTERN = /^reset-size(\d+)$/;
const SIZE_CLASS_PATTERN = /^size(\d+)$/;

const NULLDELIMITER_WIDTH_EM = 0.12;
const CJK_FALLBACK_CHAR_WIDTH_EM = 1.0;
const DEFAULT_FALLBACK_CHAR_WIDTH_EM = 0.6;
const FONT_METRIC_MATCH_EPSILON = 1e-4;

// Applied to the combined ascent+descent whenever MathLive's own struts were readable: MathLive is
// the actual renderer for most formulas (see `convertLatexToMarkupCached`), so its struts are
// already close to the true box; a small margin absorbs remaining sub-pixel/rounding drift.
const MATHLIVE_HEIGHT_SAFETY_FACTOR = 1.05;
// Applied instead when only KaTeX's tree is available (e.g. the Electron-main/MCP MathLive stub):
// KaTeX's own displaystyle box is a reasonable proxy but was not observed to be pixel-identical to
// MathLive's renderer, so this keeps a larger margin.
const KATEX_ONLY_HEIGHT_SAFETY_FACTOR = 1.25;
// Applied to width regardless of source: widths recovered by walking KaTeX's tree (or the plain
// heuristic) are approximations, and overestimating width only wastes horizontal space while
// underestimating it reintroduces the clipping bug this feature exists to fix.
const WIDTH_SAFETY_FACTOR = 1.05;

const HEURISTIC_STRUCTURAL_HEIGHT_EM = 1.6;
const HEURISTIC_PLAIN_HEIGHT_EM = 1.0;

// Measuring a formula (running MathLive's renderer, parsing KaTeX's tree, walking it for widths)
// is comparatively expensive, and the same
// TeX strings recur across every shape/print/AI-preview pass. Keyed on the raw TeX string; a
// bounded LRU-ish eviction mirrors `lib/math-tex.ts`'s `MARKUP_CACHE_LIMIT` pattern.
const metricsCache = new Map<string, MathBoxMetricsEm>();
const METRICS_CACHE_LIMIT = 5000;

export function measureTexBoxEm(
  tex: string,
  environment: MathRenderEnvironment,
): MathBoxMetricsEm {
  const cacheKey = mathRenderEnvironmentCacheKey(environment, tex);
  const cached = metricsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = computeTexBoxEm(tex, environment);
  if (metricsCache.size >= METRICS_CACHE_LIMIT) {
    const oldest = metricsCache.keys().next().value;
    if (oldest !== undefined) {
      metricsCache.delete(oldest);
    }
  }
  metricsCache.set(cacheKey, result);
  return result;
}

function computeTexBoxEm(tex: string, environment: MathRenderEnvironment): MathBoxMetricsEm {
  const mathLive = measureMathLiveStrut(tex, environment);
  const katexResult = measureKatexTree(tex, environment);
  const widthEm = (katexResult ? katexResult.widthEm : estimateFallbackWidthEm(tex)) * WIDTH_SAFETY_FACTOR;

  if (mathLive) {
    const ascentEm = katexResult ? Math.max(mathLive.ascentEm, katexResult.ascentEm) : mathLive.ascentEm;
    const descentEm = katexResult ? Math.max(mathLive.descentEm, katexResult.descentEm) : mathLive.descentEm;
    return {
      ascentEm: ascentEm * MATHLIVE_HEIGHT_SAFETY_FACTOR,
      descentEm: descentEm * MATHLIVE_HEIGHT_SAFETY_FACTOR,
      widthEm,
      source: "mathlive",
    };
  }

  if (katexResult) {
    return {
      ascentEm: katexResult.ascentEm * KATEX_ONLY_HEIGHT_SAFETY_FACTOR,
      descentEm: katexResult.descentEm * KATEX_ONLY_HEIGHT_SAFETY_FACTOR,
      widthEm,
      source: "katex",
    };
  }

  return {
    ascentEm: STRUCTURAL_MACRO_PATTERN.test(tex) ? HEURISTIC_STRUCTURAL_HEIGHT_EM : HEURISTIC_PLAIN_HEIGHT_EM,
    descentEm: 0,
    widthEm,
    source: "heuristic",
  };
}

function measureMathLiveStrut(tex: string, environment: MathRenderEnvironment): { ascentEm: number; descentEm: number } | null {
  let markup: string;
  try {
    markup = convertLatexToMarkupCached(tex, environment);
  } catch {
    return null;
  }

  const ascentMatch = markup.match(MATHLIVE_STRUT_ASCENT_PATTERN);
  if (!ascentMatch) {
    // The Electron-main/MCP stub echoes `tex` verbatim (no ML__strut markup at all), and some
    // malformed input can also fail to render struts -- both mean "no signal from MathLive".
    return null;
  }

  const totalMatch = markup.match(MATHLIVE_STRUT_TOTAL_PATTERN);
  const ascentEm = Number.parseFloat(ascentMatch[1]);
  const descentEm = totalMatch ? Number.parseFloat(totalMatch[2]) : 0;
  if (!Number.isFinite(ascentEm) || !Number.isFinite(descentEm)) {
    return null;
  }

  return { ascentEm, descentEm };
}

function measureKatexTree(tex: string, environment: MathRenderEnvironment): { ascentEm: number; descentEm: number; widthEm: number } | null {
  try {
    // 採寸に使う組版スタイルは描画と同じ出典から取る。ここだけ display 組版を直書きすると、
    // 用紙設定を textstyle にした文書で図形テキストの箱だけが過大なまま取り残される。
    const styledTex = applyMathTypesetStyle(toKatexPreviewTex(normalizeMathLiveBboxForMeasurement(tex), environment.macroSet) || "\\square", environment.typesetStyle);
    const tree = katexRenderToHTMLTree(styledTex, {
      ...KATEX_MEASURE_OPTIONS,
      macros: environment.macroSet.katexMacros,
    });
    const ascentEm = typeof tree.height === "number" ? tree.height : 0;
    const descentEm = typeof tree.depth === "number" ? tree.depth : 0;
    return {
      ascentEm,
      descentEm,
      widthEm: computeTreeWidthEm(tree, 1),
    };
  } catch {
    return null;
  }
}

function computeTreeWidthEm(node: KatexTreeNode, scale: number): number {
  const classes = node.classes ?? [];

  if (classes.includes("strut") || classes.includes("pstrut")) {
    return 0;
  }
  if (classes.includes("nulldelimiter")) {
    return NULLDELIMITER_WIDTH_EM * scale;
  }
  if (node.text !== undefined) {
    return computeLeafWidthEm(node) * scale;
  }

  const nextScale = scale * resolveSizeScale(classes);
  const children = node.children ?? [];
  const isVlistContainer = classes.includes("vlist") || classes.includes("vlist-r") ||
    classes.includes("vlist-t") || classes.includes("vlist-t2");

  const contentWidth = isVlistContainer
    ? Math.max(0, ...children.map((child) => computeTreeWidthEm(child, nextScale)))
    : children.reduce((sum, child) => sum + computeTreeWidthEm(child, nextScale), 0);

  const style = node.style ?? {};
  const spacing = (
    (parseEmStyleValue(style.marginLeft) ?? 0) +
    (parseEmStyleValue(style.marginRight) ?? 0) +
    (parseEmStyleValue(style.paddingLeft) ?? 0) +
    (parseEmStyleValue(style.paddingRight) ?? 0)
  ) * scale;

  // KaTeX supplies frame padding through its .boxpad CSS class rather than
  // inline styles. Include that advance when walking its DOM-free tree.
  let total = contentWidth + spacing + (classes.includes("boxpad") ? .6 * nextScale : 0);

  const explicitWidth = parseEmStyleValue(style.width) ?? parseEmStyleValue(style.minWidth);
  if (explicitWidth !== undefined) {
    total = Math.max(total, explicitWidth * scale);
  }
  if (typeof node.width === "number") {
    total = Math.max(total, node.width * scale);
  }

  return total;
}

function resolveSizeScale(classes: string[]): number {
  let resetSize: number | undefined;
  let size: number | undefined;

  for (const cls of classes) {
    const resetMatch = RESET_SIZE_CLASS_PATTERN.exec(cls);
    if (resetMatch) {
      resetSize = Number(resetMatch[1]);
    }
    const sizeMatch = SIZE_CLASS_PATTERN.exec(cls);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
    }
  }

  if (resetSize === undefined || size === undefined) {
    return 1;
  }

  const from = KATEX_SIZES[resetSize - 1];
  const to = KATEX_SIZES[size - 1];
  return from && to ? to / from : 1;
}

function parseEmStyleValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(-?[0-9.]+)em$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Width of a KaTeX symbol-node's `.text`. KaTeX's `buildCommon.tryCombineChars` merges adjacent
 * text nodes with matching classes/style by concatenating `.text` but leaves `.width` at the
 * *first* character's width, silently dropping the rest (verified: rendering "a" alone and "ab"
 * both report `width: 0.52859`). A single character's own `.width` is trustworthy (nothing to
 * combine), so we only re-derive width for merged (2+ character) nodes: identify which font(s)
 * produce the first character at the reported width via KaTeX's own font metrics table, then sum
 * each character's width in that font. Characters missing from the matched font's table (e.g. CJK
 * text, which KaTeX's `cjk_fallback` class has no real metrics for) fall back to a fixed per-char
 * width.
 */
function computeLeafWidthEm(node: KatexTreeNode): number {
  const text = node.text ?? "";
  const chars = Array.from(text);
  if (chars.length === 0) {
    return 0;
  }
  if (chars.length === 1) {
    // KaTeX gives CJK fallback leaves a Latin placeholder advance. The actual
    // browser face draws these characters in a full-em cell.
    if (classesIncludeCjkFallback(node) && isFullWidthChar(chars[0])) return CJK_FALLBACK_CHAR_WIDTH_EM;
    // KaTeX emits a zero-width symbol node for visible Unicode glyphs absent
    // from its fonts. Browser fallback still paints those glyphs (e.g. ❲❳).
    // Preserve real zero-width format/combining characters, but reserve an
    // advance for visible letters, numbers, punctuation and symbols.
    if (node.width === 0 && /[\p{L}\p{N}\p{P}\p{S}]/u.test(chars[0])) {
      return estimateFallbackCharWidthEm(chars[0]);
    }
    return typeof node.width === "number" ? node.width : estimateFallbackCharWidthEm(chars[0]);
  }

  const firstCodePoint = chars[0].codePointAt(0);
  const candidateFonts = typeof node.width === "number" && firstCodePoint !== undefined
    ? findMatchingFonts(firstCodePoint, node.width)
    : [];

  if (candidateFonts.length === 0) {
    return chars.reduce((sum, char) => sum + estimateFallbackCharWidthEm(char), 0);
  }

  const sums = candidateFonts.map((font) => (
    chars.reduce((sum, char) => sum + widthForCharInFont(char, font), 0)
  ));
  return Math.max(...sums);
}

function classesIncludeCjkFallback(node: KatexTreeNode): boolean {
  return node.classes?.includes("cjk_fallback") ?? false;
}

/** MathLive bbox padding is explicit; KaTeX boxed uses fixed .3em padding. */
function normalizeMathLiveBboxForMeasurement(tex: string): string {
  const command = /\\bbox\[([0-9.]+)em(?:,border:[^\]]+)?\]\{/g;
  const match = command.exec(tex);
  if (!match) return tex;
  const padding = Number(match[1]);
  if (!Number.isFinite(padding) || padding < 0 || padding > 100) return tex;
  const start = match.index + match[0].length;
  let end = start, depth = 1;
  for (; end < tex.length; end += 1) {
    if (tex[end] === "{" && tex[end - 1] !== "\\") depth += 1;
    if (tex[end] === "}" && tex[end - 1] !== "\\" && --depth === 0) break;
  }
  if (depth !== 0) return tex;
  const spacing = Number((padding - .3).toFixed(8));
  const content = normalizeMathLiveBboxForMeasurement(tex.slice(start, end));
  return tex.slice(0, match.index) + `\\boxed{\\hspace{${spacing}em}${content}\\hspace{${spacing}em}}`
    + normalizeMathLiveBboxForMeasurement(tex.slice(end + 1));
}

function findMatchingFonts(codePoint: number, width: number): string[] {
  const matches: string[] = [];
  for (const font of Object.keys(FONT_METRICS_TABLE)) {
    const entry = FONT_METRICS_TABLE[font][String(codePoint)];
    if (entry && Math.abs(entry[4] - width) < FONT_METRIC_MATCH_EPSILON) {
      matches.push(font);
    }
  }
  return matches;
}

function widthForCharInFont(char: string, font: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  const entry = FONT_METRICS_TABLE[font][String(codePoint)];
  return entry ? entry[4] : estimateFallbackCharWidthEm(char);
}

function estimateFallbackCharWidthEm(char: string): number {
  return isFullWidthChar(char) ? CJK_FALLBACK_CHAR_WIDTH_EM : DEFAULT_FALLBACK_CHAR_WIDTH_EM;
}

function isFullWidthChar(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    // Private-use glyphs have no KaTeX font metrics. A custom font often uses a
    // full-em symbol cell, so keep one glyph cell instead of counting its TeX code.
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

/** Used only when KaTeX's own tree render throws (unknown macro, parse error, etc). */
function estimateFallbackWidthEm(tex: string): number {
  const visible = tex
    // Font selectors carry metadata, not visible characters. KaTeX does not
    // support MathLive's custom-family command, so this is a fallback-only path.
    .replace(/\\fontfamily\s*\{[^}]*\}/g, "")
    .replace(/\\selectfont\b/g, "")
    .replace(/\\char\s*"([0-9a-fA-F]+)/g, (command, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : command;
    })
    // Text/font wrappers draw their contents but have no advance of their own.
    .replace(/\\(?:text|textrm|textsf|texttt|textbf|textit|mathrm|mathbf|mathsf|mathtt|mathit|mathnormal)\b(?=\s*\{)/g, "")
    .replace(/\\(?:begin|end)\s*\{[^}]*\}/g, "")
    .replace(/\\[a-zA-Z]+/g, "M")
    .replace(/[{}^_\\]/g, "");

  let width = 0;
  for (const char of visible) {
    width += estimateFallbackCharWidthEm(char);
  }
  return Math.max(width, DEFAULT_FALLBACK_CHAR_WIDTH_EM);
}
