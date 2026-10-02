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
 *
 * **先頭の前置はセルの中へ届かない。** `array` / `matrix` 系 / `cases` のセルは、MathLive も
 * KaTeX も TeX の仕様どおり textstyle に戻す (`\dfrac` だけ大きく `\sum` の上下端が横に付く)。
 * 静的側は `displayStyleTabularCells` でセルごとに前置を足して揃える。編集中の `math-field` は
 * MathLive が環境ごとにセルの mathstyle を固定しており (`ArrayAtom.mathstyleName`)、公開 API では
 * 変えられないので、これらの環境だけは編集中が textstyle のまま (確定すると displaystyle) になる。
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
 *
 * displaystyle のときは、先頭の前置が届かない**表形式環境のセル**にも同じ前置を付ける
 * (`displayStyleTabularCells`)。TeX は `array` / `matrix` 系 / `cases` のセルを textstyle に戻すので、
 * 先頭の `\displaystyle` だけでは `\sum` の上下端が横に付いたまま、分数だけが大きくなる。
 */
export function applyMathTypesetStyle(tex: string, style: MathTypesetStyle): string {
  const body = style === "displaystyle" ? displayStyleTabularCells(tex) : tex;
  return `${MATH_TYPESET_STYLE_COMMAND[style]} ${body}`;
}

/**
 * セルを textstyle で組む表形式環境。`smallmatrix` / `subarray` は小さく組むのが仕様なので含めない。
 * `rcases` は MathLive では既に displaystyle だが、KaTeX 側と揃えて対象にする (前置は冪等)。
 */
const TEXTSTYLE_CELL_ENVIRONMENT = /^(?:array|[pbBvV]?matrix\*?|cases|rcases)$/;

/** セルの先頭に置く、明示的な組版スタイル指定。書かれていれば著者の指定を優先して触らない。 */
const EXPLICIT_STYLE_PREFIX = /^\\(?:display|text|script|scriptscript)style(?![A-Za-z])/;

/** セルの前に置く罫線コマンド。`\displaystyle` はこれらの**後**、中身の直前に入れる。 */
const CELL_LEADING_RULES = /^(?:\s|\\(?:hline|hdashline)(?![A-Za-z])|\\cline\{[^}]*\})*/;

const ENVIRONMENT_TOKEN = /\\(begin|end)\{([^}]*)\}/g;
const ROW_SPACING_ARGUMENT = /^\[\s*-?(?:\d+\.?\d*|\.\d+)\s*(?:pt|em|ex|mm|cm|in|bp|pc|sp|mu)\s*\]/;

/**
 * `array` / `matrix` 系 / `cases` の各セルの先頭に `\displaystyle` を付けた TeX を返す。
 * 描画用の写しを作るだけで、呼び出し側の保存データは書き換えない。
 *
 * 触るのは「セルの中身の前」だけ。列指定 (`{ll}` / `[c]`)、`\hline`、行間 (`\\[2pt]`)、
 * 空セル、すでに `\displaystyle` / `\textstyle` などで始まるセルはそのまま残す。
 * 入れ子の環境はセルの中身として再帰的に処理する。閉じていない環境や名前の合わない
 * `\end` (入力途中の式) は、そこから先を一切触らない。
 */
export function displayStyleTabularCells(tex: string): string {
  if (!tex.includes("\\begin{")) {
    return tex;
  }

  let result = "";
  let copied = 0;
  let searchFrom = 0;

  while (searchFrom < tex.length) {
    const begin = findTextstyleCellEnvironment(tex, searchFrom);
    if (!begin) {
      break;
    }
    const bodyStart = skipEnvironmentArguments(tex, begin.name, begin.end);
    const close = findEnvironmentEnd(tex, begin.end, begin.name);
    if (!close || bodyStart > close.start) {
      break;
    }

    result += tex.slice(copied, bodyStart) + styleTabularBody(tex.slice(bodyStart, close.start));
    copied = close.start;
    searchFrom = close.end;
  }

  return copied === 0 ? tex : result + tex.slice(copied);
}

function findTextstyleCellEnvironment(
  tex: string,
  from: number,
): { end: number; name: string } | null {
  const pattern = new RegExp(ENVIRONMENT_TOKEN.source, "g");
  pattern.lastIndex = from;
  for (let match = pattern.exec(tex); match; match = pattern.exec(tex)) {
    if (match[1] === "begin" && TEXTSTYLE_CELL_ENVIRONMENT.test(match[2] ?? "")) {
      return { end: match.index + match[0].length, name: match[2] ?? "" };
    }
  }
  return null;
}

/** `\begin{name}` の対応する `\end{name}`。入れ子は種類を問わず数え、名前が合わなければ null。 */
function findEnvironmentEnd(
  tex: string,
  from: number,
  name: string,
): { end: number; start: number } | null {
  const pattern = new RegExp(ENVIRONMENT_TOKEN.source, "g");
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(tex); match; match = pattern.exec(tex)) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth === 0) {
      return match[2] === name ? { end: match.index + match[0].length, start: match.index } : null;
    }
  }
  return null;
}

/**
 * 環境名の直後にある引数 (`array` の `[pos]{cols}`、`matrix*` の `[cols]`) の終わり。
 * `[` で始まる本文 (`\begin{pmatrix}[1,2]…`) を列指定と取り違えないよう、`[lcrtb|]` だけを引数とみなす。
 */
function skipEnvironmentArguments(tex: string, name: string, from: number): number {
  let index = from;
  const optional = /^\[[lcrtb|\s]*\]/.exec(tex.slice(index, index + 40));
  if (optional) {
    index += optional[0].length;
  }
  if (name === "array" && tex[index] === "{") {
    const close = findBalancedBraceEnd(tex, index);
    index = close < 0 ? index : close + 1;
  }
  return index;
}

function findBalancedBraceEnd(tex: string, open: number): number {
  let depth = 0;
  for (let index = open; index < tex.length; index += 1) {
    const char = tex[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "{") {
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

/** 環境の中身を `&` と `\\` で区切り、各セルの先頭へ前置を付ける。 */
function styleTabularBody(body: string): string {
  let result = "";
  let cellStart = 0;
  let braceDepth = 0;
  let environmentDepth = 0;
  let index = 0;

  while (index < body.length) {
    const char = body[index];

    if (char === "\\") {
      const environment = /^\\(begin|end)\{/.exec(body.slice(index, index + 8));
      if (environment) {
        environmentDepth += environment[1] === "begin" ? 1 : -1;
        index += environment[0].length;
        continue;
      }
      if (body[index + 1] === "\\" && braceDepth === 0 && environmentDepth === 0) {
        const spacing = ROW_SPACING_ARGUMENT.exec(body.slice(index + 2))?.[0] ?? "";
        const separatorEnd = index + 2 + spacing.length;
        result += styleTabularCell(body.slice(cellStart, index)) + body.slice(index, separatorEnd);
        cellStart = separatorEnd;
        index = separatorEnd;
        continue;
      }
      // `\&` `\{` `\}` のような 1 文字の制御記号と、制御語の頭をまとめて読み飛ばす。
      index += 2;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (char === "&" && braceDepth === 0 && environmentDepth === 0) {
      result += `${styleTabularCell(body.slice(cellStart, index))}&`;
      cellStart = index + 1;
    }
    index += 1;
  }

  return result + styleTabularCell(body.slice(cellStart));
}

function styleTabularCell(cell: string): string {
  const leading = CELL_LEADING_RULES.exec(cell)?.[0] ?? "";
  const content = cell.slice(leading.length);
  if (content.trim() === "") {
    return cell;
  }

  const nested = displayStyleTabularCells(content);
  return EXPLICIT_STYLE_PREFIX.test(content)
    ? leading + nested
    : `${leading}${MATH_TYPESET_STYLE_COMMAND.displaystyle} ${nested}`;
}

/** 編集中の `math-field` に与える `defaultMode`。静的側の前置と同じ 1 つの値から導く。 */
export function mathFieldDefaultMode(style: MathTypesetStyle): "inline-math" | "math" {
  return MATH_FIELD_DEFAULT_MODE[style];
}
