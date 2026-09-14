import type { GraphCurve } from "@/features/document";

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

/** 評価式を表示用 TeX へ変換する。解釈できない場合は入力をそのまま返す。 */
export function graphExpressionToTex(expression: string): string {
  try {
    const node = new ExpressionAstParser(expression).parse();
    return texFromExprNode(node, 0);
  } catch {
    return expression;
  }
}

/** Use the authored display math; legacy curves share the settings field's conversion. */
export function graphCurveExprTex(curve: Pick<GraphCurve, "expr" | "exprTex">): string {
  return curve.exprTex?.trim() || graphExpressionToTex(curve.expr);
}

export function graphCurveYExprTex(curve: Pick<GraphCurve, "yExpr" | "yExprTex">): string {
  return curve.yExprTex?.trim() || (curve.yExpr ? graphExpressionToTex(curve.yExpr) : "");
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
