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

/** 通常の数式の組版スタイル。小さく組む場合は TeX で明示する。 */
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
 * 旧教材・公開 API の引数は読み取り互換のため受け付けるが、表示には使わない。
 * 通常は displaystyle。小さく組む場合は TeX 本文の明示的な \textstyle 等を尊重する。
 */
export function resolveMathTypesetStyle(_legacyFractionSizing?: MathFractionSizing | null): MathTypesetStyle {
  void _legacyFractionSizing; // Legacy callers may still pass this value.
  return DEFAULT_MATH_TYPESET_STYLE;
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
  const body = style === "displaystyle" ? growEvaluationBrackets(displayStyleTabularCells(tex)) : tex;
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

    const body = tex.slice(bodyStart, close.start);
    result += tex.slice(copied, bodyStart)
      + (hasExplicitSmallStyleBefore(tex, begin.start) ? body : styleTabularBody(body));
    copied = close.start;
    searchFrom = close.end;
  }

  return copied === 0 ? tex : result + tex.slice(copied);
}

function findTextstyleCellEnvironment(
  tex: string,
  from: number,
): { start: number; end: number; name: string } | null {
  const pattern = new RegExp(ENVIRONMENT_TOKEN.source, "g");
  pattern.lastIndex = from;
  for (let match = pattern.exec(tex); match; match = pattern.exec(tex)) {
    if (match[1] === "begin" && TEXTSTYLE_CELL_ENVIRONMENT.test(match[2] ?? "")) {
      return { start: match.index, end: match.index + match[0].length, name: match[2] ?? "" };
    }
  }
  return null;
}

/** 著者のスタイル指定はグループ内だけに効く。先行する別の環境からは漏らさない。 */
function hasExplicitSmallStyleBefore(tex: string, end: number): boolean {
  let small = false;
  const groups: boolean[] = [];
  for (let index = 0; index < end;) {
    if (tex[index] === "%") {
      const newline = tex.indexOf("\n", index);
      index = newline < 0 ? end : newline + 1;
    } else if (tex[index] === "{") {
      groups.push(small);
      index++;
    } else if (tex[index] === "}") {
      small = groups.pop() ?? false;
      index++;
    } else if (tex[index] === "\\") {
      const environment = /^\\begin\{([^}]+)\}/.exec(tex.slice(index));
      if (environment) {
        const close = findEnvironmentEnd(tex, index + environment[0].length, environment[1]);
        if (close && close.end <= end) {
          index = close.end;
          continue;
        }
      }
      const command = /^\\([A-Za-z]+|[^])/u.exec(tex.slice(index));
      if (!command) break;
      if (command[1] === "displaystyle") small = false;
      else if (/^(?:text|script|scriptscript)style$/.test(command[1])) small = true;
      index += command[0].length;
    } else {
      index++;
    }
  }
  return small;
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

/** 角括弧の左右を作る区切り記号。`\lbrack` は MathLive が `[` の入力から作る綴り。 */
const LEFT_SQUARE_BRACKET = /^\\left\s*(?:\[|\\lbrack(?![A-Za-z]))/;
const RIGHT_SQUARE_BRACKET = /^\\right\s*(?:\]|\\rbrack(?![A-Za-z]))/;
const LEFT_RIGHT_TOKEN = /\\(left|right)(?![A-Za-z])/g;
const EVALUATION_BRACKET_STRUT = String.raw`\vphantom{\int}`;

/**
 * 定積分の値を表す `\left[ F(x) \right]_a^b` の角括弧を、displaystyle の積分記号と同じ高さまで伸ばした TeX を返す。
 * 描画用の写しを作るだけで、保存データは書き換えない。
 *
 * `\left[ \right]` は中身の高さにしか伸びないので、`x^3+x` のような低い中身だと括弧が積分記号より
 * ずっと小さく、上下端も中身の横に詰まる。教科書の `[F(x)]_a^b` は積分記号と同じ高さの括弧で組むので、
 * 括弧の内側に見えない `\vphantom{\int}` を置いて高さの下限にする (中身が高ければ従来どおり中身に合わせて伸びる)。
 * `\Bigl[` などの固定サイズにしないのは、分数を含む中身で括弧が足りなくなり、MathLive では `=` との間隔も詰まるため。
 *
 * 対象は `\right]` の直後に上付き・下付きが続く (= 区間の値を取る) 角括弧だけ。区間 `[a, b]` や、
 * すでに `\vphantom{\int}` を置いた括弧はそのまま残す。対応の取れない入力途中の式も触らない。
 * AI や手書きの TeX に多い `\left` の無い `[F(x)]_a^b` も、先に `\left[ … \right]` へ直してから同じ扱いにする。
 */
export function growEvaluationBrackets(tex: string): string {
  // This delimiter scanner does not parse comments. Preserve their original TeX rather than
  // inserting a closing delimiter inside a comment, where the renderer would discard it.
  if (containsTexComment(tex)) return tex;
  tex = stretchPlainEvaluationBrackets(tex);
  if (!tex.includes("\\left")) {
    return tex;
  }

  const opens: { start: number; end: number; square: boolean }[] = [];
  const inserts: number[] = [];
  const pattern = new RegExp(LEFT_RIGHT_TOKEN.source, "g");
  for (let match = pattern.exec(tex); match; match = pattern.exec(tex)) {
    const rest = tex.slice(match.index);
    if (match[1] === "left") {
      const square = LEFT_SQUARE_BRACKET.exec(rest);
      opens.push({ start: match.index, end: match.index + (square?.[0].length ?? match[0].length), square: Boolean(square) });
      continue;
    }
    const open = opens.pop();
    if (!open) {
      return tex;
    }
    if (!open.square) {
      continue;
    }
    const close = RIGHT_SQUARE_BRACKET.exec(rest);
    if (!close) {
      continue;
    }
    const after = tex.slice(match.index + close[0].length).trimStart();
    const inside = tex.slice(open.end).trimStart();
    if (/^[_^]/.test(after) && !inside.startsWith(EVALUATION_BRACKET_STRUT)) {
      inserts.push(open.end);
    }
  }

  if (opens.length > 0 || inserts.length === 0) {
    return tex;
  }
  let result = tex;
  for (const index of inserts.sort((a, b) => b - a)) {
    result = `${result.slice(0, index)} ${EVALUATION_BRACKET_STRUT}${result.slice(index)}`;
  }
  return result;
}

function containsTexComment(tex: string): boolean {
  for (let index = 0; index < tex.length; index += 1) {
    if (tex[index] === "\\") index += 1;
    else if (tex[index] === "%") return true;
  }
  return false;
}

/**
 * `\left` の無い `[ … ]_a^b` を `\left[ … \right]_a^b` にする。素の `[` `]` は伸びないので、このままでは
 * 括弧を積分記号の高さにできない。
 *
 * 同じ波括弧の深さで対になる `[` と `]` のうち、`]` の直後に `_` か `^` が続くものだけを直す。
 * `\sqrt[3]`・`\\[2pt]` の省略可能引数と、`\bigl[`・`\right]` などの大きさ指定済みの区切りは数えない。中の `\left` と `\right` の数が合わないときは、包むと対応が崩れるので触らない。
 */
function stretchPlainEvaluationBrackets(tex: string): string {
  if (!tex.includes("[") || !tex.includes("]")) {
    return tex;
  }

  const opens: { index: number; depth: number }[] = [];
  const pairs: { open: number; close: number }[] = [];
  let depth = 0;
  for (let index = 0; index < tex.length; index += 1) {
    const char = tex[index];
    if (char === "\\") {
      const command = /^\\(?:[A-Za-z]+|[^])/u.exec(tex.slice(index))?.[0] ?? "\\";
      index += command.length - 1;
      const rest = /^\s*[[\]]/.exec(tex.slice(index + 1));
      if (!rest) {
        continue;
      }
      if (SIZED_DELIMITER_COMMAND.test(command)) {
        // `\left[`・`\bigr]` などの括弧は、大きさがもう決まっている区切り。
        index += rest[0].length;
      } else if (rest[0].endsWith("[") && OPTIONAL_ARGUMENT_COMMAND.test(command)) {
        // `\sqrt[3]`・`\\[2pt]` の省略可能引数は、対の `]` まで丸ごと読み飛ばす。
        const close = findOptionalArgumentEnd(tex, index + rest[0].length);
        if (close < 0) {
          return tex;
        }
        index = close;
      }
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
      while (opens.length > 0 && opens[opens.length - 1].depth > depth) opens.pop();
    } else if (char === "[") {
      opens.push({ index, depth });
    } else if (char === "]") {
      const open = opens[opens.length - 1];
      if (open?.depth !== depth) {
        continue;
      }
      opens.pop();
      if (/^\s*[_^]/.test(tex.slice(index + 1))) {
        const inside = tex.slice(open.index + 1, index);
        const lefts = inside.match(/\\left(?![A-Za-z])/g)?.length ?? 0;
        const rights = inside.match(/\\right(?![A-Za-z])/g)?.length ?? 0;
        if (lefts === rights) {
          pairs.push({ open: open.index, close: index });
        }
      }
    }
  }

  let result = tex;
  for (const { index, text } of pairs
    .flatMap(({ open, close }) => [{ index: open, text: "\\left[" }, { index: close, text: "\\right]" }])
    .sort((a, b) => b.index - a.index)) {
    result = `${result.slice(0, index)}${text}${result.slice(index + 1)}`;
  }
  return result;
}

/** `[` で省略可能引数を取る命令。ほかの命令 (`\quad`・`\displaystyle` など) の後の `[` は本文の括弧として数える。 */
const OPTIONAL_ARGUMENT_COMMAND = /^\\(?:sqrt|x[A-Za-z]*arrow|\\|newline|placeholder)$/;
const SIZED_DELIMITER_COMMAND = /^\\(?:left|right|middle|[bB]igg?[lrm]?)$/;

/** `open` にある `[` と対になる `]` の位置。入れ子の `[` `]` と波括弧を数える。閉じていなければ -1。 */
function findOptionalArgumentEnd(tex: string, open: number): number {
  let brackets = 0;
  let braces = 0;
  for (let index = open; index < tex.length; index += 1) {
    const char = tex[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "{") {
      braces += 1;
    } else if (char === "}") {
      braces -= 1;
    } else if (char === "[" && braces === 0) {
      brackets += 1;
    } else if (char === "]" && braces === 0) {
      brackets -= 1;
      if (brackets === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** 編集中の `math-field` に与える `defaultMode`。静的側の前置と同じ 1 つの値から導く。 */
export function mathFieldDefaultMode(style: MathTypesetStyle): "inline-math" | "math" {
  return MATH_FIELD_DEFAULT_MODE[style];
}
