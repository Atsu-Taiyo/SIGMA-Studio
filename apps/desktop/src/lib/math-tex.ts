import katex from "katex";
import { convertLatexToMarkup, validateLatex } from "mathlive";

import { applyMathTypesetStyle } from "@/features/rendering/core";
import { mathRenderEnvironmentCacheKey, type MathRenderEnvironment } from "@/lib/math-environment";
import { DEFAULT_MATH_MACRO_SET, trustSigmaKatexMacro, type MathMacroSet } from "@/lib/math-macros";

const MULTILINE_ENVIRONMENT_PATTERN = /\\begin\{(aligned|alignedat|array|cases|displaylines|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g;
const TEX_ROW_SEPARATOR = "\\\\";
const MATH_TEMPLATE_PLACEHOLDER_PATTERN = /#\?/g;
const MATH_TEMPLATE_PLACEHOLDER_TEX = "\\placeholder{}";
const TEXT_MODE_COMMANDS = new Set(["mbox", "text"]);
const JAPANESE_MATH_TEXT_CHARACTER_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u3000-\u303f\uff01-\uff60\uffe0-\uffee]/u;
const KATEX_RENDER_OPTIONS = {
  macros: DEFAULT_MATH_MACRO_SET.katexMacros,
  maxExpand: 1000,
  maxSize: 100,
  output: "html" as const,
  strict: "ignore" as const,
  throwOnError: true,
  trust: trustSigmaKatexMacro,
};

export interface MathTemplateInsertion {
  cursor: number;
  tex: string;
}

// Converting TeX to HTML markup is expensive and is called once per inline-math
// node on every render. A large document can hold hundreds of math nodes (none of
// which change when body text is typed elsewhere), so re-converting all of them
// per keystroke dominates typing latency. Cache by the source TeX string so
// unchanged formulas are converted only once, regardless of the chosen renderer.
const markupCache = new Map<string, string>();
const commandSupportCache = new Map<string, boolean>();
const MARKUP_CACHE_LIMIT = 5000;

/**
 * MathLive が実際にその式を描けたかの判定。`validateLatex` は**公開 API 上マクロを受け取れない**
 * (`mathlive-ssr.d.ts`) ので、これを分岐に使い続ける限り、前文マクロや `\thickboxed` を含む式は
 * 「MathLive では描けない」と誤判定され、構造的に KaTeX (= 別の既定 mathstyle) へ倒れ続ける。
 * 描いてみてエラー markup が出たかで判定するのが根治。
 *
 * 部分一致 (`includes("ML__error")`) ではなくクラストークンとして照合するのは、本文テキストや
 * 将来のクラス名 (`ML__errorless` のような) を誤検出しないため。
 */
const MATHLIVE_ERROR_CLASS_PATTERN = /class="[^"]*\bML__error\b/;

export function convertLatexToMarkupCached(
  tex: string,
  environment: MathRenderEnvironment,
): string {
  const cacheKey = mathRenderEnvironmentCacheKey(environment, tex);
  const cached = markupCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const html = renderMathMarkup(tex, environment);
  if (markupCache.size >= MARKUP_CACHE_LIMIT) {
    const oldest = markupCache.keys().next().value;
    if (oldest !== undefined) {
      markupCache.delete(oldest);
    }
  }
  markupCache.set(cacheKey, html);
  return html;
}

/**
 * MathLive を第一候補、KaTeX をフォールバックとする 2 段構え。組版スタイルは**どちらの経路でも
 * 同じ TeX 前置**で与える (KaTeX の `displayMode: true` は使わない — `.katex-display` が付いて
 * 行内配置が壊れる)。MathLive の `defaultMode` は静的変換では mathstyle に効かないが、
 * text/math のどちらとして解釈するかには効くので従来どおり `"math"` を渡す。
 *
 * **MathLive が throw した場合は KaTeX へ落とさずそのまま投げる。** throw するのは
 * `\href{javascript:...}` や `\class{x" onmouseover=...}` のような、生成器自身が危険と判断した
 * 入力だけで、ここを KaTeX で描き直すと「危ないものは丸ごと生 TeX 表示へ倒す」不変条件
 * (`math-html.ts` のフォールバック、`math-html.security.test.ts`) が黙って外れる。
 */
function renderMathMarkup(tex: string, environment: MathRenderEnvironment): string {
  const { macroSet, typesetStyle } = environment;
  const mathLiveMarkup = convertLatexToMarkup(
    applyMathTypesetStyle(toMathLivePreviewTex(tex) || "\\square", typesetStyle),
    { defaultMode: "math", macros: macroSet.mathLiveMacros },
  );

  if (!MATHLIVE_ERROR_CLASS_PATTERN.test(mathLiveMarkup)) {
    return mathLiveMarkup;
  }

  // MathLive が描けなかった式だけ KaTeX へ。どちらも駄目なら MathLive のエラー markup を見せる。
  return renderKatexIfValid(
    applyMathTypesetStyle(toKatexPreviewTex(tex) || "\\square", typesetStyle),
    macroSet,
  ) ?? mathLiveMarkup;
}

/**
 * SigmaDocの数式として、MathLiveまたは静的表示のKaTeXで解釈できるTeXを受理する。
 * MathLive固有のプレースホルダーを保ちつつ、\\dots や配列内の\\hlineなど
 * KaTeX側で扱える標準的なコマンドも保存・表示できるようにする。
 */
export function validateMathTex(
  tex: string,
  macroSet: MathMacroSet = DEFAULT_MATH_MACRO_SET,
): ReturnType<typeof validateLatex> {
  const mathLiveIssues = validateLatex(tex);
  if (mathLiveIssues.length === 0) {
    return [];
  }

  return renderKatexIfValid(toKatexPreviewTex(tex) || "\\square", macroSet) === null
    ? mathLiveIssues
    : [];
}

/** TeX入力中のコマンド名がMathLiveまたはKaTeXで定義済みかを判定する。 */
export function isMathTexCommandSupported(command: string): boolean {
  const cached = commandSupportCache.get(command);
  if (cached !== undefined) {
    return cached;
  }

  const mathLiveRecognizesCommand = !validateLatex(command).some((issue) => (
    issue.code === "unknown-command" && issue.arg === command
  ));
  let supported = mathLiveRecognizesCommand;

  if (!supported) {
    try {
      katex.renderToString(command, KATEX_RENDER_OPTIONS);
      supported = true;
    } catch (error) {
      // 引数不足や「配列内のみ有効」はコマンド自体は既知。未定義だけを除外する。
      supported = !(error instanceof Error && error.message.includes("Undefined control sequence"));
    }
  }

  commandSupportCache.set(command, supported);
  return supported;
}

export function toMathLivePreviewTex(tex: string): string {
  return normalizeMathTextRuns(normalizeMathLiveLineBreakTex(tex))
    .replace(/\\placeholder(?:\[([^\]]*)\])?\{\s*\}/g, (_match, id: string | undefined) => {
      return `\\placeholder[${id || "?"}]{\\square}`;
    })
    .replace(/\\placeholder\{([^{}]+)\}/g, (_match, body: string) => {
      return `\\placeholder[?]{${body}}`;
    });
}

export function toKatexPreviewTex(tex: string): string {
  return normalizeMathTextRuns(normalizeMathLiveLineBreakTex(tex))
    .replace(/\\placeholder(?:\[[^\]]*\])?\{([^{}]*)\}/g, (_match, body: string) => {
      return body.trim() ? `{${body}}` : "\\square";
    });
}

export function toEditableMathTemplateTex(templateTex: string): string {
  return templateTex.replace(MATH_TEMPLATE_PLACEHOLDER_PATTERN, MATH_TEMPLATE_PLACEHOLDER_TEX);
}

export function insertEditableMathTemplateTex(
  currentTex: string,
  cursor: number,
  templateTex: string,
): MathTemplateInsertion {
  const boundedCursor = clampMathTexCursor(cursor, currentTex);
  const insertedTex = toEditableMathTemplateTex(templateTex);
  const placeholderCursor = insertedTex.indexOf(MATH_TEMPLATE_PLACEHOLDER_TEX);
  const nextTex = `${currentTex.slice(0, boundedCursor)}${insertedTex}${currentTex.slice(boundedCursor)}`;

  return {
    cursor: boundedCursor + (placeholderCursor >= 0 ? placeholderCursor : insertedTex.length),
    tex: nextTex,
  };
}

export function normalizeMathLiveLineBreakTex(tex: string): string {
  if (!tex.includes(TEX_ROW_SEPARATOR)) {
    return tex;
  }
  if (/^\s*\\displaylines\{/.test(tex)) {
    return tex;
  }

  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MULTILINE_ENVIRONMENT_PATTERN.lastIndex = 0;

  while ((match = MULTILINE_ENVIRONMENT_PATTERN.exec(tex)) !== null) {
    result += wrapBareLineBreaksInAligned(tex.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }

  result += wrapBareLineBreaksInAligned(tex.slice(lastIndex));
  return result;
}

export function normalizeMathTextRuns(tex: string): string {
  let result = "";
  let index = 0;

  while (index < tex.length) {
    if (tex[index] === "\\") {
      const command = readTexCommand(tex, index);
      const commandGroupEnd = command.name && TEXT_MODE_COMMANDS.has(command.name)
        ? findTexCommandGroupEnd(tex, command.end)
        : -1;
      if (commandGroupEnd >= 0) {
        result += tex.slice(index, commandGroupEnd + 1);
        index = commandGroupEnd + 1;
        continue;
      }

      result += tex.slice(index, command.end);
      index = command.end;
      continue;
    }

    if (isJapaneseMathTextCharacter(tex, index)) {
      const start = index;
      do {
        index += codePointLengthAt(tex, index);
      } while (index < tex.length && isJapaneseMathTextCharacter(tex, index));
      result += `\\text{${tex.slice(start, index)}}`;
      continue;
    }

    const length = codePointLengthAt(tex, index);
    result += tex.slice(index, index + length);
    index += length;
  }

  return result;
}

function wrapBareLineBreaksInAligned(value: string): string {
  const rows = splitByTexRowSeparator(value.trim())
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length < 2) {
    return value;
  }

  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
  return `${leadingWhitespace}\\begin{aligned}${rows.map(addAlignedRelationMarker).join(TEX_ROW_SEPARATOR)}\\end{aligned}${trailingWhitespace}`;
}

function splitByTexRowSeparator(value: string): string[] {
  const rows: string[] = [];
  let rowStart = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (isSimpleTexRowSeparator(value, index)) {
      rows.push(value.slice(rowStart, index));
      index += 1;
      rowStart = index + 1;
    }
  }
  rows.push(value.slice(rowStart));
  return rows;
}

function isSimpleTexRowSeparator(value: string, index: number): boolean {
  return (
    value[index] === "\\" &&
    value[index + 1] === "\\" &&
    value[index - 1] !== "\\" &&
    value[index + 2] !== "\\"
  );
}

function addAlignedRelationMarker(row: string): string {
  if (row.includes("&")) {
    return row;
  }

  return row.replace(
    /\s*(=|<|>|\\leq{0,2}\b|\\geq{0,2}\b|\\neq?\b|\\approx\b|\\equiv\b|\\iff\b|\\to\b|\\Rightarrow\b|\\Leftarrow\b)/,
    "&$1",
  );
}

function readTexCommand(tex: string, start: number): { end: number; name: string | null } {
  let index = start + 1;
  while (index < tex.length && /[a-zA-Z]/.test(tex[index] ?? "")) {
    index += 1;
  }

  if (index > start + 1) {
    return { end: index, name: tex.slice(start + 1, index) };
  }

  return { end: Math.min(start + 2, tex.length), name: null };
}

function findTexCommandGroupEnd(tex: string, start: number): number {
  let index = start;
  while (index < tex.length && /\s/.test(tex[index] ?? "")) {
    index += 1;
  }

  if (tex[index] !== "{") {
    return -1;
  }

  let depth = 0;
  for (; index < tex.length; index += 1) {
    const char = tex[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isJapaneseMathTextCharacter(tex: string, index: number): boolean {
  const codePoint = tex.codePointAt(index);
  if (codePoint === undefined) {
    return false;
  }

  return JAPANESE_MATH_TEXT_CHARACTER_PATTERN.test(String.fromCodePoint(codePoint));
}

function codePointLengthAt(value: string, index: number): number {
  const codePoint = value.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function clampMathTexCursor(cursor: number, tex: string): number {
  if (!Number.isFinite(cursor)) {
    return tex.length;
  }

  return Math.min(Math.max(Math.round(cursor), 0), tex.length);
}

function renderKatexIfValid(tex: string, macroSet: MathMacroSet = DEFAULT_MATH_MACRO_SET): string | null {
  try {
    return katex.renderToString(tex, { ...KATEX_RENDER_OPTIONS, macros: macroSet.katexMacros });
  } catch {
    return null;
  }
}
