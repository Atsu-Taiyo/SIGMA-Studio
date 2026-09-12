import type { GraphExpressionVariableName } from "@/lib/graph2d";

/**
 * TeX とグラフ評価式 (graph2d の ExpressionParser が解釈する ASCII 式) の変換境界。
 *
 * SigmaDoc には評価式 (`expr` / 座標 / 範囲の文字列) を正本として保存し、
 * TeX は入力・表示用の投影として扱う。ユーザーが入力した TeX は
 * `texToGraphExpression` で評価式へ正規化してから保存する。
 */

const TEX_FUNCTION_COMMANDS: Record<string, string> = {
  sin: "sin",
  cos: "cos",
  tan: "tan",
  arcsin: "asin",
  arccos: "acos",
  arctan: "atan",
  ln: "ln",
  log: "log",
  exp: "exp",
};

const EXPRESSION_FUNCTION_TEX: Record<string, string> = {
  sin: "\\sin",
  cos: "\\cos",
  tan: "\\tan",
  asin: "\\arcsin",
  acos: "\\arccos",
  atan: "\\arctan",
  ln: "\\ln",
  log: "\\log",
  exp: "\\exp",
};

const IGNORABLE_TEX_COMMANDS = new Set([",", ";", "!", ":", " ", "quad", "qquad", "displaystyle", "textstyle"]);

const LESS_COMPARATORS = new Set(["le", "leq", "leqq", "leqslant", "lt", "<"]);
const GREATER_COMPARATORS = new Set(["ge", "geq", "geqq", "geqslant", "gt", ">"]);

/**
 * 生成した評価式を「いちばんゆるく結んでいる演算子」で分類したもの。丸括弧の中は数えない。
 *
 * 括弧は**付けないと意味が変わるときだけ**付ける。以前は `x^2` を必ず `(x)^(2)` に
 * 書き換えていたが、保存された式はそのまま人の目に触れる: 表示用 TeX が作れなかったときは
 * 評価式がそのまま数式として描かれるので、`x^2` と入力した式が `(x)²` と表示されていた。
 * AI が読む文字列にも、MCP が返す文字列にも同じ式が出る。
 */
type ExpressionBinding = "atom" | "power" | "product" | "sum";

const BINDING_RANK: Record<ExpressionBinding, number> = { sum: 0, product: 1, power: 2, atom: 3 };

function expressionBinding(expression: string): ExpressionBinding {
  const text = expression.trim();
  let depth = 0;
  let loosest: ExpressionBinding = "atom";
  for (const char of text) {
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) {
      continue;
    }
    // 先頭の符号もここで sum になる。`-x` は冪の底に置くと `-(x^2)` に読まれてしまうので、
    // 「括弧が要る位置」の判定としては和と同じ扱いが正しい。
    if (char === "+" || char === "-") return "sum";
    if ((char === "*" || char === "/") && BINDING_RANK.product < BINDING_RANK[loosest]) {
      loosest = "product";
    } else if (char === "^" && BINDING_RANK.power < BINDING_RANK[loosest]) {
      loosest = "power";
    }
  }
  return loosest;
}

/** その位置に置いても読み方が変わらない形にする。すでに十分固く結ばれていれば触らない。 */
function wrapExpression(expression: string, required: ExpressionBinding): string {
  const text = expression.trim();
  return BINDING_RANK[expressionBinding(text)] < BINDING_RANK[required] ? `(${text})` : text;
}

/** 式全体を包んでいる丸括弧だけを外す。`(a)+(b)` は全体を包んでいないので触らない。 */
function unwrapExpression(expression: string): string {
  let text = expression.trim();
  for (;;) {
    if (!text.startsWith("(") || !text.endsWith(")")) return text;
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0 && index < text.length - 1) return text;
      }
    }
    if (depth !== 0) return text;
    text = text.slice(1, -1).trim();
  }
}

export function texToGraphExpression(tex: string): string | null {
  try {
    return new TexToExpressionConverter(tex).convert();
  } catch {
    return null;
  }
}

/**
 * TeX を式へ変換できなかった理由。**文言ではなくコードで返す** (表示は
 * `shape.texError.*`)。`message.includes("unsupported command")` の判定は
 * パーサが投げる**英語の内部メッセージ**に対するもので、表示文言ではない。
 */
export type GraphTexErrorCode = "empty" | "hasEquals" | "unsupportedCommand" | "unparsable";

export function texToGraphExpressionWithError(
  tex: string,
): { expression: string } | { error: GraphTexErrorCode } {
  try {
    const expression = new TexToExpressionConverter(tex).convert();
    if (expression) {
      return { expression };
    }
    return { error: "empty" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.includes(`unsupported character "="`)) {
      return { error: "hasEquals" };
    }
    if (message.includes("unsupported command")) {
      return { error: "unsupportedCommand" };
    }
    return { error: "unparsable" };
  }
}

export interface GraphExpressionTexParts {
  expression: string;
  tex: string;
}

/** `f(x,y)=c` や `f(x,y)=g(x,y)` の TeX を、評価式 `F(x,y)=0` へ正規化する。 */
export function parseGraphImplicitEquationTex(tex: string): GraphExpressionTexParts | null {
  const parts = tex.split("=");
  if (parts.length !== 2) {
    return null;
  }

  const leftTex = parts[0].trim();
  const rightTex = parts[1].trim();
  if (!leftTex || !rightTex) {
    return null;
  }

  const leftExpression = texToGraphExpression(leftTex);
  const rightExpression = texToGraphExpression(rightTex);
  if (leftExpression === null || rightExpression === null) {
    return null;
  }

  if (isZeroExpression(rightExpression)) {
    return { expression: leftExpression, tex: `${leftTex}=${rightTex}` };
  }
  if (isZeroExpression(leftExpression)) {
    return {
      expression: `-${wrapExpression(rightExpression, "product")}`,
      tex: `${leftTex}=${rightTex}`,
    };
  }

  return {
    expression: `${leftExpression}-${wrapExpression(rightExpression, "product")}`,
    tex: `${leftTex}=${rightTex}`,
  };
}

export interface GraphPointTexParts {
  x: string;
  y: string;
  xTex: string;
  yTex: string;
}

/** `(x, y)` または `x, y` 形式の TeX を座標ペアに分解する。 */
export function parseGraphPointTex(tex: string): GraphPointTexParts | null {
  const inner = stripOuterTexParens(tex.trim());
  const { segments, delimiters } = splitTexTopLevel(inner, (token) => token === ",");
  if (delimiters.length !== 1 || segments.length !== 2) {
    return null;
  }

  const xTex = segments[0].trim();
  const yTex = segments[1].trim();
  const x = texToGraphExpression(xTex);
  const y = texToGraphExpression(yTex);
  if (x === null || y === null || !xTex || !yTex) {
    return null;
  }

  return { x, y, xTex, yTex };
}

export function formatGraphPointTex(x: string, y: string, xTex?: string, yTex?: string): string {
  const xPart = xTex?.trim() || graphExpressionToTex(x);
  const yPart = yTex?.trim() || graphExpressionToTex(y);
  return `(${xPart},\\ ${yPart})`;
}

export interface GraphRangeTexParts {
  min?: string;
  max?: string;
}

/**
 * `-2 \le x \le 3` のような不等式チェーン (片側のみも可) を数値範囲へ正規化する。
 * `<` / `>` は `\le` / `\ge` と同じ扱いにする。
 */
export function parseGraphRangeTex(tex: string, variableName: GraphExpressionVariableName): GraphRangeTexParts | null {
  const { segments, delimiters } = splitTexTopLevel(tex.trim(), (token) => (
    LESS_COMPARATORS.has(token) || GREATER_COMPARATORS.has(token)
  ));
  if (delimiters.length === 0 || delimiters.length > 2 || segments.length !== delimiters.length + 1) {
    return null;
  }

  const directions = delimiters.map((token) => (LESS_COMPARATORS.has(token) ? "le" : "ge"));
  if (new Set(directions).size !== 1) {
    return null;
  }

  const ascending = directions[0] === "le";
  const isVariable = (segment: string) => texToGraphExpression(segment) === variableName;
  const convert = (segment: string) => {
    const expression = texToGraphExpression(segment);
    return expression === null || expression === variableName ? null : expression;
  };

  if (segments.length === 3) {
    if (!isVariable(segments[1])) {
      return null;
    }
    const lower = convert(segments[0]);
    const upper = convert(segments[2]);
    if (lower === null || upper === null) {
      return null;
    }
    return ascending ? { min: lower, max: upper } : { min: upper, max: lower };
  }

  if (isVariable(segments[0])) {
    const bound = convert(segments[1]);
    if (bound === null) {
      return null;
    }
    return ascending ? { max: bound } : { min: bound };
  }

  if (isVariable(segments[1])) {
    const bound = convert(segments[0]);
    if (bound === null) {
      return null;
    }
    return ascending ? { min: bound } : { max: bound };
  }

  return null;
}

export type GraphInequalityOperator = "<=" | ">=" | "<" | ">";

export interface GraphInequalityTexParts {
  left: string;
  operator: GraphInequalityOperator;
  right: string;
  leftTex: string;
  rightTex: string;
}

const INEQUALITY_OPERATOR_BY_COMMAND: Record<string, GraphInequalityOperator> = {
  le: "<=", leq: "<=", leqq: "<=", leqslant: "<=",
  ge: ">=", geq: ">=", geqq: ">=", geqslant: ">=",
  lt: "<", "<": "<",
  gt: ">", ">": ">",
};

const TEX_BY_INEQUALITY_OPERATOR: Record<GraphInequalityOperator, string> = {
  "<=": "\\leqq",
  ">=": "\\geqq",
  "<": "<",
  ">": ">",
};

/**
 * `x + y \leqq 1` のような不等式ひとつを、評価式の左辺・不等号・右辺へ分解する。
 * 不等号が2つ以上ある連鎖 (`a \le x \le b`) は範囲入力の担当なのでここでは受け付けない。
 */
export function parseGraphInequalityTex(tex: string): GraphInequalityTexParts | null {
  const { segments, delimiters } = splitTexTopLevel(tex.trim(), (token) => (
    Object.hasOwn(INEQUALITY_OPERATOR_BY_COMMAND, token)
  ));
  if (delimiters.length !== 1 || segments.length !== 2) {
    return null;
  }
  const leftTex = segments[0].trim();
  const rightTex = segments[1].trim();
  if (!leftTex || !rightTex) {
    return null;
  }
  const left = texToGraphExpression(leftTex);
  const right = texToGraphExpression(rightTex);
  if (left === null || right === null) {
    return null;
  }
  return {
    left,
    right,
    leftTex,
    rightTex,
    operator: INEQUALITY_OPERATOR_BY_COMMAND[delimiters[0]],
  };
}

export function formatGraphInequalityTex(
  left: string,
  operator: GraphInequalityOperator,
  right: string,
): string {
  return `${graphExpressionToTex(left)} ${TEX_BY_INEQUALITY_OPERATOR[operator]} ${graphExpressionToTex(right)}`;
}

export function formatGraphRangeTex(
  min: string | undefined,
  max: string | undefined,
  variableName: GraphExpressionVariableName,
): string {
  const minTex = min?.trim() ? graphExpressionToTex(min) : null;
  const maxTex = max?.trim() ? graphExpressionToTex(max) : null;
  if (minTex !== null && maxTex !== null) {
    return `${minTex} \\le ${variableName} \\le ${maxTex}`;
  }
  if (minTex !== null) {
    return `${minTex} \\le ${variableName}`;
  }
  if (maxTex !== null) {
    return `${variableName} \\le ${maxTex}`;
  }
  return "";
}

/** 評価式を表示用 TeX へ変換する。解釈できない場合は入力をそのまま返す。 */
export function graphExpressionToTex(expression: string): string {
  try {
    const node = new ExpressionAstParser(expression).parse();
    return texFromExprNode(node, 0);
  } catch {
    return expression;
  }
}

function isZeroExpression(expression: string): boolean {
  const numeric = Number(expression);
  return Number.isFinite(numeric) && Math.abs(numeric) < 1e-9;
}

// ---------------------------------------------------------------------------
// TeX → 評価式
// ---------------------------------------------------------------------------

class TexToExpressionConverter {
  private index = 0;

  constructor(private readonly source: string) {}

  convert(): string {
    const expression = this.parseSequence(new Set(), new Set());
    this.skipIgnorable();
    if (this.index < this.source.length) {
      throw new Error(`unexpected trailing input at ${this.index}`);
    }
    return expression;
  }

  private parseSequence(
    charTerminators: ReadonlySet<string>,
    commandTerminators: ReadonlySet<string>,
  ): string {
    let output = "";
    let previousWasFactor = false;

    for (;;) {
      this.skipIgnorable();
      if (this.index >= this.source.length) {
        break;
      }
      const char = this.source[this.index];
      if (charTerminators.has(char)) {
        break;
      }

      if (char === "+" || char === "-") {
        this.index += 1;
        output += char;
        previousWasFactor = false;
        continue;
      }
      if (char === "−") {
        this.index += 1;
        output += "-";
        previousWasFactor = false;
        continue;
      }
      if (char === "*" || char === "/") {
        this.index += 1;
        output += char;
        previousWasFactor = false;
        continue;
      }

      if (char === "\\") {
        const command = this.peekCommandName();
        if (commandTerminators.has(command)) {
          break;
        }
        if (command === "cdot" || command === "times") {
          this.consumeCommand();
          output += "*";
          previousWasFactor = false;
          continue;
        }
        if (command === "div") {
          this.consumeCommand();
          output += "/";
          previousWasFactor = false;
          continue;
        }
      }

      const factor = this.parseFactor();
      if (previousWasFactor) {
        output += "*";
      }
      output += factor;
      previousWasFactor = true;
    }

    if (!output || !previousWasFactor) {
      throw new Error("incomplete expression");
    }
    return output;
  }

  private parseFactor(): string {
    this.skipIgnorable();
    const char = this.source[this.index];
    if (char === undefined) {
      throw new Error("unexpected end of input");
    }

    let base: string;
    if (/[0-9.]/.test(char)) {
      base = this.readNumber();
    } else if (char === "(") {
      base = this.parseParenGroup();
    } else if (char === "{") {
      this.index += 1;
      base = wrapExpression(this.parseSequence(new Set(["}"]), new Set()), "atom");
      this.expectChar("}");
    } else if (char === "|") {
      this.index += 1;
      base = `abs(${unwrapExpression(this.parseSequence(new Set(["|"]), new Set()))})`;
      this.expectChar("|");
    } else if (char === "π") {
      this.index += 1;
      base = "pi";
    } else if (/[a-zA-Z]/.test(char)) {
      this.index += 1;
      base = char;
    } else if (char === "\\") {
      base = this.parseCommandFactor();
    } else {
      throw new Error(`unsupported character "${char}"`);
    }

    return this.applyPostfix(base);
  }

  private parseCommandFactor(): string {
    const command = this.peekCommandName();
    this.consumeCommand();

    if (command === "pi") {
      return "pi";
    }
    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      const numerator = this.parseBracedGroup();
      const denominator = this.parseBracedGroup();
      // 分子は積のままで足りる (`a*b/c` は `(a*b)/c`)。分母は次の因子と結ばれてしまうので冪まで固める。
      return `${wrapExpression(numerator, "product")}/${wrapExpression(denominator, "power")}`;
    }
    if (command === "sqrt") {
      this.skipIgnorable();
      if (this.source[this.index] === "[") {
        this.index += 1;
        const degree = this.parseSequence(new Set(["]"]), new Set());
        this.expectChar("]");
        const radicand = this.parseBracedGroup();
        const exponent = `1/${wrapExpression(degree, "power")}`;
        return `${wrapExpression(radicand, "atom")}^${wrapExpression(exponent, "atom")}`;
      }
      const radicand = this.parseBracedGroup();
      return `sqrt(${radicand})`;
    }
    if (command === "left") {
      return this.parseLeftRightGroup();
    }
    if (command === "lvert" || command === "vert") {
      const inner = this.parseSequence(new Set(), new Set(["rvert", "vert"]));
      this.expectCommand(new Set(["rvert", "vert"]));
      return `abs(${unwrapExpression(inner)})`;
    }
    if (command === "mathrm" || command === "mathit" || command === "text") {
      const content = this.parseBracedRawGroup().trim();
      if (!/^[a-zA-Z]$/.test(content)) {
        throw new Error(`unsupported ${command} content "${content}"`);
      }
      return content;
    }
    if (command === "operatorname") {
      const name = this.parseBracedRawGroup().trim().toLowerCase();
      const mapped = TEX_FUNCTION_COMMANDS[name];
      if (!mapped) {
        throw new Error(`unsupported operator "${name}"`);
      }
      return this.parseFunctionApplication(mapped);
    }

    const functionName = TEX_FUNCTION_COMMANDS[command];
    if (functionName) {
      return this.parseFunctionApplication(functionName);
    }

    throw new Error(`unsupported command "\\${command}"`);
  }

  private parseFunctionApplication(functionName: string): string {
    this.skipIgnorable();

    let exponent: string | null = null;
    if (this.source[this.index] === "^") {
      this.index += 1;
      exponent = this.parseExponentArgument();
    }

    // 丸括弧グループの引数はそこで関数適用が閉じる。後続の `^` は引数ではなく
    // 関数適用全体へ掛かる (parseFactor 側の applyPostfix が担当するのでここでは呼ばない)。
    const argument = this.tryParseParenGroupArgument() ?? this.parseFunctionArgument();
    // 関数呼び出しの丸括弧が引数を囲むので、引数側の括弧は重ねない (`cos((2*x))` になっていた)。
    const call = `${functionName}(${unwrapExpression(argument)})`;
    return exponent === null ? call : `${call}^${wrapExpression(exponent, "atom")}`;
  }

  /**
   * 関数適用の引数が丸括弧グループ (`(...)` / `\left(...\right)`) のときだけ、
   * 後置演算子を適用せずに読み取る。`\sin\left(x\right)^{2}` の `^` を引数ではなく
   * 関数適用全体へ結合させるため (`\sqrt{...}^{2}` と同じ責務分担)。
   * `\left|`・`\left[` など丸括弧以外は index を戻し、従来の引数解釈に委ねる
   * (絶対値や角括弧の結合規則は現状維持する意図的な非対称)。
   */
  private tryParseParenGroupArgument(): string | null {
    this.skipIgnorable();
    if (this.source[this.index] === "(") {
      return this.parseParenGroup();
    }
    if (this.source[this.index] === "\\" && this.peekCommandName() === "left") {
      // 可変状態は index だけなので、この退避と復元で完全にロールバックできる
      // (フィールドを追加したらこの前提が崩れる)。
      const start = this.index;
      this.consumeCommand();
      this.skipIgnorable();
      if (this.source[this.index] === "(") {
        // `\left` 消費済みの状態で既存実装へ委譲し、`\right` の整合チェックを維持する。
        return this.parseLeftRightGroup();
      }
      this.index = start;
    }
    return null;
  }

  /** 素の `(...)` グループを読み取る (現在位置が `(` であることは呼び出し側で確認済み)。 */
  private parseParenGroup(): string {
    this.index += 1;
    const inner = this.parseSequence(new Set([")"]), new Set());
    this.expectChar(")");
    return wrapExpression(inner, "atom");
  }

  private parseFunctionArgument(): string {
    this.skipIgnorable();
    let argument = this.parseFactor();

    // `\sin 2\pi` のような数係数付き引数は係数×後続因子まで取り込む。
    if (/^[0-9.]/.test(argument)) {
      for (;;) {
        this.skipIgnorable();
        const char = this.source[this.index];
        if (char === undefined) {
          break;
        }
        const isFactorStart = /[a-zA-Z(π]/.test(char) ||
          (char === "\\" && !this.isOperatorOrTerminatorCommand());
        if (!isFactorStart) {
          break;
        }
        argument += `*${this.parseFactor()}`;
      }
    }

    return argument;
  }

  private isOperatorOrTerminatorCommand(): boolean {
    const command = this.peekCommandName();
    return command === "cdot" || command === "times" || command === "div" || command === "right" ||
      command === "rvert" || command === "vert";
  }

  private parseLeftRightGroup(): string {
    this.skipIgnorable();
    const open = this.readDelimiterToken();
    const inner = this.parseSequence(new Set(), new Set(["right"]));
    this.skipIgnorable();
    this.expectCommand(new Set(["right"]));
    this.skipIgnorable();
    const close = this.readDelimiterToken();
    const isAbs = open === "|" || open === "lvert" || open === "vert";
    const closesAbs = close === "|" || close === "rvert" || close === "vert";
    if (isAbs !== closesAbs) {
      throw new Error(`mismatched \\left${open} ... \\right${close}`);
    }
    return isAbs ? `abs(${unwrapExpression(inner)})` : wrapExpression(inner, "atom");
  }

  private readDelimiterToken(): string {
    const char = this.source[this.index];
    if (char === "(" || char === ")" || char === "[" || char === "]" || char === "|" || char === ".") {
      this.index += 1;
      return char;
    }
    if (char === "\\") {
      const command = this.peekCommandName();
      if (command === "{" || command === "}") {
        this.consumeCommand();
        return command;
      }
      if (command === "lvert" || command === "rvert" || command === "vert") {
        this.consumeCommand();
        return command;
      }
    }
    throw new Error(`unsupported delimiter at ${this.index}`);
  }

  private applyPostfix(base: string): string {
    let result = base;
    for (;;) {
      this.skipIgnorable();
      const char = this.source[this.index];
      if (char === "^") {
        this.index += 1;
        const exponent = this.parseExponentArgument();
        result = `${wrapExpression(result, "atom")}^${wrapExpression(exponent, "atom")}`;
        continue;
      }
      if (char === "_") {
        throw new Error("subscripts are not supported");
      }
      return result;
    }
  }

  private parseExponentArgument(): string {
    this.skipIgnorable();
    const char = this.source[this.index];
    if (char === "{") {
      this.index += 1;
      const inner = this.parseSequence(new Set(["}"]), new Set());
      this.expectChar("}");
      return inner;
    }
    if (char !== undefined && /[0-9]/.test(char)) {
      this.index += 1;
      return char;
    }
    if (char !== undefined && /[a-zA-Z]/.test(char)) {
      this.index += 1;
      return char;
    }
    if (char === "\\" && this.peekCommandName() === "pi") {
      this.consumeCommand();
      return "pi";
    }
    throw new Error("unsupported exponent");
  }

  private parseBracedGroup(): string {
    this.skipIgnorable();
    this.expectChar("{");
    const inner = this.parseSequence(new Set(["}"]), new Set());
    this.expectChar("}");
    return inner;
  }

  private parseBracedRawGroup(): string {
    this.skipIgnorable();
    this.expectChar("{");
    let depth = 1;
    let content = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          this.index += 1;
          return content;
        }
      }
      content += char;
      this.index += 1;
    }
    throw new Error("unterminated group");
  }

  private readNumber(): string {
    const match = /^(?:\d+\.?\d*|\.\d+)/.exec(this.source.slice(this.index));
    if (!match) {
      throw new Error("invalid number");
    }
    this.index += match[0].length;
    return match[0];
  }

  private skipIgnorable(): void {
    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) {
        return;
      }
      if (/\s/.test(char) || char === "~") {
        this.index += 1;
        continue;
      }
      if (char === "\\") {
        const command = this.peekCommandName();
        if (IGNORABLE_TEX_COMMANDS.has(command)) {
          this.consumeCommand();
          continue;
        }
      }
      return;
    }
  }

  private peekCommandName(): string {
    if (this.source[this.index] !== "\\") {
      return "";
    }
    const rest = this.source.slice(this.index + 1);
    const letters = /^[a-zA-Z]+/.exec(rest);
    if (letters) {
      return letters[0];
    }
    return rest.slice(0, 1);
  }

  private consumeCommand(): void {
    const name = this.peekCommandName();
    this.index += 1 + name.length;
  }

  private expectChar(char: string): void {
    this.skipIgnorable();
    if (this.source[this.index] !== char) {
      throw new Error(`expected "${char}" at ${this.index}`);
    }
    this.index += 1;
  }

  private expectCommand(names: ReadonlySet<string>): void {
    this.skipIgnorable();
    if (this.source[this.index] !== "\\" || !names.has(this.peekCommandName())) {
      throw new Error(`expected \\${[...names][0]} at ${this.index}`);
    }
    this.consumeCommand();
  }
}

// ---------------------------------------------------------------------------
// トップレベル分割 (点座標のカンマ・範囲の比較演算子)
// ---------------------------------------------------------------------------

function splitTexTopLevel(
  tex: string,
  isDelimiter: (token: string) => boolean,
): { segments: string[]; delimiters: string[] } {
  const segments: string[] = [];
  const delimiters: string[] = [];
  let depth = 0;
  let current = "";
  let index = 0;

  while (index < tex.length) {
    const char = tex[index];
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const letters = /^[a-zA-Z]+/.exec(tex.slice(index + 1));
      const command = letters ? letters[0] : tex.slice(index + 1, index + 2);
      if (command === "left") {
        depth += 1;
      } else if (command === "right") {
        depth -= 1;
      } else if (depth === 0 && isDelimiter(command)) {
        segments.push(current);
        delimiters.push(command);
        current = "";
        index += 1 + command.length;
        continue;
      }
      current += tex.slice(index, index + 1 + command.length);
      index += 1 + command.length;
      continue;
    }
    if (depth === 0 && isDelimiter(char)) {
      segments.push(current);
      delimiters.push(char);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }

  segments.push(current);
  return { segments, delimiters };
}

function stripOuterTexParens(tex: string): string {
  for (const [open, close] of [["\\left(", "\\right)"], ["(", ")"]] as const) {
    if (!tex.startsWith(open) || !tex.endsWith(close) || tex.length <= open.length + close.length) {
      continue;
    }
    const inner = tex.slice(open.length, tex.length - close.length);
    const { delimiters } = splitTexTopLevel(inner, (token) => token === ")" || token === "(");
    if (delimiters.length === 0) {
      return inner;
    }
  }
  return tex;
}

// ---------------------------------------------------------------------------
// 評価式 → TeX
// ---------------------------------------------------------------------------

type ExprNode =
  | { kind: "number"; text: string }
  | { kind: "identifier"; name: string }
  | { kind: "call"; name: string; argument: ExprNode }
  | { kind: "unary"; operator: "+" | "-"; operand: ExprNode }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "^"; left: ExprNode; right: ExprNode };

const PRECEDENCE_ADDITIVE = 1;
const PRECEDENCE_UNARY = 1.5;
const PRECEDENCE_MULTIPLICATIVE = 2;
const PRECEDENCE_POWER = 3;
const PRECEDENCE_ATOM = 4;

class ExpressionAstParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): ExprNode {
    const node = this.parseAdditive();
    this.skipSpaces();
    if (this.index < this.source.length) {
      throw new Error(`unexpected input at ${this.index}`);
    }
    return node;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    for (;;) {
      this.skipSpaces();
      const char = this.source[this.index];
      if (char !== "+" && char !== "-") {
        return left;
      }
      this.index += 1;
      const right = this.parseMultiplicative();
      left = { kind: "binary", operator: char, left, right };
    }
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      this.skipSpaces();
      const char = this.source[this.index];
      if (char === "*" || char === "/") {
        this.index += 1;
        const right = this.parseUnary();
        left = { kind: "binary", operator: char, left, right };
        continue;
      }
      if (char !== undefined && /[0-9a-zA-Z(.]/.test(char)) {
        const right = this.parseUnaryWithoutSign();
        left = { kind: "binary", operator: "*", left, right };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): ExprNode {
    this.skipSpaces();
    const char = this.source[this.index];
    if (char === "+" || char === "-") {
      this.index += 1;
      return { kind: "unary", operator: char, operand: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parseUnaryWithoutSign(): ExprNode {
    return this.parsePower();
  }

  private parsePower(): ExprNode {
    const base = this.parsePrimary();
    this.skipSpaces();
    if (this.source[this.index] !== "^") {
      return base;
    }
    this.index += 1;
    const exponent = this.parseUnary();
    return { kind: "binary", operator: "^", left: base, right: exponent };
  }

  private parsePrimary(): ExprNode {
    this.skipSpaces();
    const char = this.source[this.index];
    if (char === undefined) {
      throw new Error("unexpected end of expression");
    }

    if (char === "(") {
      this.index += 1;
      const inner = this.parseAdditive();
      this.skipSpaces();
      if (this.source[this.index] !== ")") {
        throw new Error("missing closing paren");
      }
      this.index += 1;
      return inner;
    }

    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(this.source.slice(this.index));
      if (!match) {
        throw new Error("invalid number");
      }
      this.index += match[0].length;
      return { kind: "number", text: match[0] };
    }

    if (/[a-zA-Z_]/.test(char)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(this.source.slice(this.index));
      if (!match) {
        throw new Error("invalid identifier");
      }
      this.index += match[0].length;
      const name = match[0];
      this.skipSpaces();
      if (this.source[this.index] === "(") {
        this.index += 1;
        const argument = this.parseAdditive();
        this.skipSpaces();
        if (this.source[this.index] !== ")") {
          throw new Error("missing closing paren");
        }
        this.index += 1;
        return { kind: "call", name, argument };
      }
      return { kind: "identifier", name };
    }

    throw new Error(`unsupported character "${char}"`);
  }

  private skipSpaces(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) {
      this.index += 1;
    }
  }
}

function texFromExprNode(node: ExprNode, minPrecedence: number): string {
  switch (node.kind) {
    case "number":
      return node.text;
    case "identifier":
      return node.name === "pi" ? "\\pi" : node.name;
    case "call": {
      if (node.name === "sqrt") {
        return `\\sqrt{${texFromExprNode(node.argument, 0)}}`;
      }
      if (node.name === "abs") {
        return `\\left|${texFromExprNode(node.argument, 0)}\\right|`;
      }
      const command = EXPRESSION_FUNCTION_TEX[node.name];
      if (!command) {
        return `${node.name}\\left(${texFromExprNode(node.argument, 0)}\\right)`;
      }
      return `${command}\\left(${texFromExprNode(node.argument, 0)}\\right)`;
    }
    case "unary": {
      const operand = texFromExprNode(node.operand, PRECEDENCE_UNARY);
      const tex = `${node.operator === "-" ? "-" : ""}${operand}`;
      return PRECEDENCE_UNARY < minPrecedence ? wrapTexParens(tex) : tex;
    }
    case "binary":
      return texFromBinaryNode(node, minPrecedence);
  }
}

function texFromBinaryNode(
  node: Extract<ExprNode, { kind: "binary" }>,
  minPrecedence: number,
): string {
  if (node.operator === "/") {
    if (node.left.kind === "unary" && node.left.operator === "-") {
      const tex = `-\\frac{${texFromExprNode(node.left.operand, 0)}}{${texFromExprNode(node.right, 0)}}`;
      return PRECEDENCE_UNARY < minPrecedence ? wrapTexParens(tex) : tex;
    }
    return `\\frac{${texFromExprNode(node.left, 0)}}{${texFromExprNode(node.right, 0)}}`;
  }

  if (node.operator === "^") {
    const base = texFromExprNode(node.left, PRECEDENCE_ATOM);
    const exponent = texFromExprNode(node.right, 0);
    const tex = `${base}^{${exponent}}`;
    return PRECEDENCE_POWER < minPrecedence ? wrapTexParens(tex) : tex;
  }

  if (node.operator === "*") {
    // 先頭の符号は積の前に出しても読み方が変わらない (`-2x`)。積そのものが二項演算子の右に
    // 裸で置かれるときだけ `3 - -2x` になってしまうので、そこは従来どおり括弧で守る。
    const wrapsWhole = PRECEDENCE_MULTIPLICATIVE < minPrecedence;
    const left = texFromExprNode(
      node.left,
      wrapsWhole || minPrecedence <= PRECEDENCE_ADDITIVE ? PRECEDENCE_UNARY : PRECEDENCE_MULTIPLICATIVE,
    );
    const right = texFromExprNode(node.right, PRECEDENCE_MULTIPLICATIVE + 0.1);
    const needsCdot = /^[0-9.]/.test(right) || right.startsWith("-");
    const tex = needsCdot ? `${left} \\cdot ${right}` : `${left} ${right}`;
    return wrapsWhole ? wrapTexParens(tex) : tex;
  }

  const left = texFromExprNode(node.left, PRECEDENCE_ADDITIVE);
  const right = texFromExprNode(node.right, node.operator === "-" ? PRECEDENCE_MULTIPLICATIVE : PRECEDENCE_ADDITIVE + 0.1);
  const tex = `${left} ${node.operator} ${right}`;
  return PRECEDENCE_ADDITIVE < minPrecedence ? wrapTexParens(tex) : tex;
}

function wrapTexParens(tex: string): string {
  return `\\left(${tex}\\right)`;
}
