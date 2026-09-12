export type MathExpressionVariables = Readonly<Record<string, number>>;

/** Evaluates one already-parsed expression against a variable scope. */
export type CompiledMathExpression = (variables: MathExpressionVariables) => number;

const MAX_EXPRESSION_LENGTH = 4_096;
const MAX_PARSE_STEPS = 20_000;
const MAX_RECURSION_DEPTH = 128;
/**
 * Compiled forms are pure functions of the source text, so they are cached across calls.
 * A surface sample grid evaluates the same expression thousands of times per rebuild, and
 * re-parsing it each time dominated the 3D scene build.
 */
const MAX_COMPILED_CACHE_ENTRIES = 512;

const compiledCache = new Map<string, CompiledMathExpression | Error>();

/**
 * Compile the constrained expression language shared by 2D and 3D graphs.
 * It intentionally does not use `eval`, `Function`, dynamic imports, or
 * user-provided callbacks: parsing produces a tree of small closures.
 *
 * Syntax errors are raised here, once per distinct expression, instead of once
 * per sample point.
 */
export function compileMathExpression(expression: string): CompiledMathExpression {
  const cached = compiledCache.get(expression);
  if (cached) {
    if (cached instanceof Error) {
      throw cached;
    }
    return cached;
  }

  let compiled: CompiledMathExpression | Error;
  try {
    compiled = compile(expression);
  } catch (error) {
    // Failures are cached too: an in-progress expression is re-evaluated on every keystroke
    // and re-parsing a known-bad string is the same wasted work as re-parsing a good one.
    compiled = error instanceof Error ? error : new Error("Expression could not be parsed");
  }

  if (compiledCache.size >= MAX_COMPILED_CACHE_ENTRIES) {
    // Insertion-ordered eviction. Expressions churn while typing, so the oldest entry is
    // the least likely to be needed again.
    const oldest = compiledCache.keys().next().value;
    if (oldest !== undefined) {
      compiledCache.delete(oldest);
    }
  }
  compiledCache.set(expression, compiled);

  if (compiled instanceof Error) {
    throw compiled;
  }
  return compiled;
}

/**
 * Evaluate the constrained expression language shared by 2D and 3D graphs.
 *
 * Prefer `compileMathExpression` in sampling loops: this wrapper looks the compiled
 * form up by string on every call.
 */
export function evaluateMathExpression(
  expression: string,
  variables: MathExpressionVariables = {},
): number {
  return compileMathExpression(expression)(variables);
}

/** Returns `left - right` for an equation, or the expression value otherwise. */
export function compileMathEquation(expression: string): CompiledMathExpression {
  const parts = expression.split("=");
  if (parts.length === 1) {
    return compileMathExpression(expression);
  }
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error("Equation must contain exactly one equals sign");
  }
  const left = compileMathExpression(parts[0]);
  const right = compileMathExpression(parts[1]);
  return (variables) => left(variables) - right(variables);
}

/** Returns `left - right` for an equation, or the expression value otherwise. */
export function evaluateMathEquation(
  expression: string,
  variables: MathExpressionVariables = {},
): number {
  return compileMathEquation(expression)(variables);
}

function compile(expression: string): CompiledMathExpression {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error("Expression is too long");
  }
  const node = new MathExpressionParser(expression).parse();
  return (variables) => {
    const value = node(variables);
    if (!Number.isFinite(value)) {
      throw new Error("Expression produced a non-finite value");
    }
    return value;
  };
}

/**
 * Variable lookup is case-insensitive, but callers pass lowercase names in the hot paths,
 * so the exact-match fast path is what actually runs. A referenced name that is missing or
 * non-finite is an error at the point of use, which is also the only place it can matter.
 */
function readVariable(variables: MathExpressionVariables, name: string): number | undefined {
  const direct = variables[name];
  if (direct !== undefined) {
    if (!Number.isFinite(direct)) {
      throw new Error(`Invalid variable ${name}`);
    }
    return direct;
  }
  for (const key of Object.keys(variables)) {
    if (key.toLowerCase() !== name) {
      continue;
    }
    const value = variables[key];
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid variable ${key}`);
    }
    return value;
  }
  return undefined;
}

type MathExpressionNode = (variables: MathExpressionVariables) => number;

class MathExpressionParser {
  private index = 0;
  private steps = 0;
  private depth = 0;

  constructor(private readonly input: string) {}

  parse(): MathExpressionNode {
    const node = this.parseAdditive();
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw new Error(`Unexpected token at ${this.index}`);
    }
    return node;
  }

  private parseAdditive(): MathExpressionNode {
    let node = this.parseMultiplicative();
    while (true) {
      this.step();
      this.skipWhitespace();
      if (this.consume("+")) {
        const left = node;
        const right = this.parseMultiplicative();
        node = (variables) => left(variables) + right(variables);
      } else if (this.consume("-")) {
        const left = node;
        const right = this.parseMultiplicative();
        node = (variables) => left(variables) - right(variables);
      } else {
        return node;
      }
    }
  }

  private parseMultiplicative(): MathExpressionNode {
    let node = this.parseUnary();
    while (true) {
      this.step();
      this.skipWhitespace();
      if (this.consume("*")) {
        const left = node;
        const right = this.parseUnary();
        node = (variables) => left(variables) * right(variables);
      } else if (this.consume("/")) {
        const left = node;
        const right = this.parseUnary();
        node = (variables) => left(variables) / right(variables);
      } else if (this.startsImplicitFactor()) {
        const left = node;
        const right = this.parsePower();
        node = (variables) => left(variables) * right(variables);
      } else {
        return node;
      }
    }
  }

  /** Unary signs bind looser than exponentiation: `-x^2` is `-(x^2)`. */
  private parseUnary(): MathExpressionNode {
    this.step();
    this.skipWhitespace();
    if (this.consume("+")) {
      return this.withDepth(() => this.parseUnary());
    }
    if (this.consume("-")) {
      const operand = this.withDepth(() => this.parseUnary());
      return (variables) => -operand(variables);
    }
    return this.parsePower();
  }

  private parsePower(): MathExpressionNode {
    const base = this.parsePrimary();
    this.skipWhitespace();
    if (this.consume("^")) {
      const exponent = this.withDepth(() => this.parseUnary());
      return (variables) => base(variables) ** exponent(variables);
    }
    return base;
  }

  private parsePrimary(): MathExpressionNode {
    this.step();
    this.skipWhitespace();
    if (this.consume("(")) {
      const node = this.withDepth(() => this.parseAdditive());
      this.skipWhitespace();
      if (!this.consume(")")) {
        throw new Error("Expected closing parenthesis");
      }
      return node;
    }

    const numberValue = this.parseNumber();
    if (numberValue !== null) {
      return () => numberValue;
    }

    const identifier = this.parseIdentifier();
    if (identifier) {
      return this.resolveIdentifier(identifier);
    }
    throw new Error(`Expected value at ${this.index}`);
  }

  private resolveIdentifier(identifier: string): MathExpressionNode {
    const normalized = identifier.toLowerCase();
    this.skipWhitespace();
    if (this.consume("(")) {
      const argument = this.withDepth(() => this.parseAdditive());
      this.skipWhitespace();
      if (!this.consume(")")) {
        throw new Error("Expected closing parenthesis");
      }
      const operation = getMathFunction(normalized);
      return (variables) => operation(argument(variables));
    }

    if (normalized === "pi" || normalized === "tau" || normalized === "e") {
      const constant = normalized === "pi"
        ? Math.PI
        : normalized === "tau"
          ? Math.PI * 2
          : Math.E;
      // A variable of the same name still wins, as it did when constants were resolved last.
      return (variables) => readVariable(variables, normalized) ?? constant;
    }

    return (variables) => {
      const value = readVariable(variables, normalized);
      if (value === undefined) {
        throw new Error(`Unknown identifier ${identifier}`);
      }
      return value;
    };
  }

  private parseNumber(): number | null {
    const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iu.exec(this.input.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseIdentifier(): string | null {
    const match = /^[a-zA-Z_][a-zA-Z0-9_]*/u.exec(this.input.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  private consume(token: string): boolean {
    if (!this.input.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.index] ?? "")) this.index += 1;
  }

  private startsImplicitFactor(): boolean {
    this.skipWhitespace();
    const next = this.input[this.index] ?? "";
    return next === "(" || next === "." || /\d|[a-zA-Z_]/u.test(next);
  }

  private withDepth<T>(operation: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_RECURSION_DEPTH) {
      throw new Error("Expression is too complex");
    }
    try {
      return operation();
    } finally {
      this.depth -= 1;
    }
  }

  private step(): void {
    this.steps += 1;
    if (this.steps > MAX_PARSE_STEPS) {
      throw new Error("Expression is too complex");
    }
  }
}

const MATH_FUNCTIONS: Readonly<Record<string, (value: number) => number>> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  cosh: Math.cosh,
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
};

function getMathFunction(name: string): (value: number) => number {
  // `Object.hasOwn` keeps inherited names such as `constructor` from resolving to a function.
  if (!Object.hasOwn(MATH_FUNCTIONS, name)) {
    throw new Error(`Unknown function ${name}`);
  }
  return MATH_FUNCTIONS[name];
}
