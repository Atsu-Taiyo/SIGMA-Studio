/**
 * The delimiter subset of physics, expanded before either math renderer parses it.
 * These commands need delimiter-aware parsing (ordinary #1 macros cannot parse
 * `\\qty(...)`). This does not load a TeX engine or redefine existing operators.
 * See https://mirrors.ibiblio.org/CTAN/macros/latex/contrib/physics/physics.pdf §2.1.
 */
const FIXED_FENCES: Readonly<Record<string, readonly [string, string]>> = {
  pqty: ["(", ")"],
  bqty: ["[", "]"],
  Bqty: [String.raw`\{`, String.raw`\}`],
  vqty: ["|", "|"],
  abs: [String.raw`\lvert`, String.raw`\rvert`],
  absolutevalue: [String.raw`\lvert`, String.raw`\rvert`],
  norm: [String.raw`\lVert`, String.raw`\rVert`],
};
const VARIABLE_FENCES = new Set(["qty", "quantity"]);
const COMMAND_PATTERN = /[a-zA-Z]/;
const CLOSE_FENCE: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}", "|": "|" };
const MAX_NESTING = 64;
// MathLive's explicit text-mode commands (also documented in math-markup.ts).
// Their contents are literal text; physics shorthand must not rewrite it.
const TEXT_COMMANDS = new Set([
  "text", "mbox", "textrm", "textbf", "textit", "texttt", "textsf", "textup",
  "textnormal", "textmd", "textsl", "textsc", "operatorname",
]);

export function isPhysicsTexCommand(command: string): boolean {
  const name = command.startsWith("\\") ? command.slice(1) : command;
  return VARIABLE_FENCES.has(name) || Object.hasOwn(FIXED_FENCES, name);
}

/** Complete a typed command when its opening delimiter arrives. */
export function physicsFenceInputTemplate(
  command: string,
  opening: string,
  overrides?: ReadonlySet<string>,
): string | null {
  const name = command.startsWith("\\") ? command.slice(1) : command;
  if (overrides?.has(name) || !isPhysicsTexCommand(name)) return null;
  const variable = VARIABLE_FENCES.has(name);
  if (!CLOSE_FENCE[opening] || (!variable && opening !== "{")) return null;
  const [left, right] = variable
    ? opening === "{" ? [String.raw`\{`, String.raw`\}`] : [opening, CLOSE_FENCE[opening]]
    : FIXED_FENCES[name]!;
  return `\\left${left}\\placeholder{}\\right${right}`;
}

interface Expansion { end: number; tex: string }

/** Leave incomplete input and document-defined commands untouched. */
export function normalizePhysicsTex(tex: string, overrides?: ReadonlySet<string>): string {
  if (!/\\(?:qty|quantity|pqty|bqty|Bqty|vqty|abs|absolutevalue|norm)\b/.test(tex)) return tex;
  return normalizeRange(tex, overrides, 0);
}

function normalizeRange(source: string, overrides: ReadonlySet<string> | undefined, depth: number): string {
  if (depth > MAX_NESTING) return source;
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "%") {
      const end = source.indexOf("\n", cursor);
      if (end < 0) return result + source.slice(cursor);
      result += source.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }
    if (char !== "\\") {
      result += char;
      cursor += 1;
      continue;
    }
    const command = readCommand(source, cursor);
    if (TEXT_COMMANDS.has(command.name)) {
      const start = skipSpace(source, command.end);
      const end = readFenceEnd(source, start, overrides, depth);
      if (source[start] === "{" && end !== null) {
        result += source.slice(cursor, end);
        cursor = end;
        continue;
      }
    }
    const expansion = expandInvocation(source, cursor, overrides, depth);
    if (expansion) {
      result += expansion.tex;
      cursor = expansion.end;
      continue;
    }
    result += source.slice(cursor, command.end);
    cursor = command.end;
  }
  return result;
}

function expandInvocation(source: string, start: number, overrides: ReadonlySet<string> | undefined, depth: number): Expansion | null {
  if (depth > MAX_NESTING) return null;
  const command = readCommand(source, start);
  if (overrides?.has(command.name) || !isPhysicsTexCommand(command.name)) return null;
  let cursor = skipSpace(source, command.end);
  let size = "";
  if (source[cursor] === "*") {
    size = "*";
    cursor = skipSpace(source, cursor + 1);
  } else if (source[cursor] === "\\") {
    const sizing = readCommand(source, cursor);
    if (["big", "Big", "bigg", "Bigg"].includes(sizing.name)) {
      size = sizing.name;
      cursor = skipSpace(source, sizing.end);
    }
  }
  const opening = source[cursor];
  const variable = VARIABLE_FENCES.has(command.name);
  if (!opening || !CLOSE_FENCE[opening] || (!variable && opening !== "{")) return null;
  const end = readFenceEnd(source, cursor, overrides, depth + 1);
  if (end === null) return null;
  // siunitx uses \\qty{number}{unit}. Do not silently reinterpret that syntax.
  if (variable && opening === "{" && source[skipSpace(source, end)] === "{") return null;
  const body = normalizeRange(source.slice(cursor + 1, end - 1), overrides, depth + 1);
  const fences = variable
    ? opening === "{" ? [String.raw`\{`, String.raw`\}`] : [opening, CLOSE_FENCE[opening]]
    : FIXED_FENCES[command.name]!;
  const [left, right] = fences;
  const tex = size === "*" ? `${left} ${body} ${right}`
    : size ? `\\${size}l${left} ${body} \\${size}r${right}`
      : `\\left${left} ${body} \\right${right}`;
  return { end, tex };
}

/** Match TeX groups and literal parentheses/brackets without consuming escaped tokens. */
function readFenceEnd(source: string, start: number, overrides: ReadonlySet<string> | undefined, depth: number): number | null {
  if (depth > MAX_NESTING) return null;
  const opening = source[start];
  if (!opening || !CLOSE_FENCE[opening]) return null;
  if (opening === "{") return readTexGroupEnd(source, start);
  const stack = [CLOSE_FENCE[opening]];
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "%") {
      const end = source.indexOf("\n", cursor);
      if (end < 0) return null;
      cursor = end + 1;
      continue;
    }
    if (char === "\\") {
      const command = readCommand(source, cursor);
      // A nested \qty|...| opens another pair; an ordinary | inside (or
      // a braced set condition) is a math symbol, not a grouping token.
      if (VARIABLE_FENCES.has(command.name) && !overrides?.has(command.name)) {
        let next = skipSpace(source, command.end);
        if (source[next] === "*") next = skipSpace(source, next + 1);
        if (source[next] === "\\") {
          const sizing = readCommand(source, next);
          if (["big", "Big", "bigg", "Bigg"].includes(sizing.name)) next = skipSpace(source, sizing.end);
        }
        if (source[next] === "|") {
          stack.push("|");
          if (stack.length + depth > MAX_NESTING) return null;
          cursor = next + 1;
          continue;
        }
      }
      cursor = command.end;
      continue;
    }
    // TeX groups protect their contents from an outer delimiter scan. Literal
    // '(' or '[' inside \text{...}, a macro argument, or a subscript group need
    // no matching ')' or ']' to make the surrounding quantity complete.
    if (char === "{") {
      const end = readTexGroupEnd(source, cursor);
      if (end === null) return null;
      cursor = end;
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return cursor + 1;
    } else if (char && char !== "|" && CLOSE_FENCE[char]) {
      stack.push(CLOSE_FENCE[char]);
      if (stack.length + depth > MAX_NESTING) return null;
    }
    cursor += 1;
  }
  return null;
}

function readTexGroupEnd(source: string, start: number): number | null {
  let depth = 1;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "\\") {
      cursor = readCommand(source, cursor).end - 1;
    } else if (char === "%") {
      const end = source.indexOf("\n", cursor);
      if (end < 0) return null;
      cursor = end;
    } else if (char === "{") {
      depth += 1;
      // Every malformed \qty{ can be another starting point. Bound each scan
      // so repeated unclosed groups cannot make normalization quadratic.
      if (depth > MAX_NESTING) return null;
    } else if (char === "}" && --depth === 0) {
      return cursor + 1;
    }
  }
  return null;
}

function readCommand(source: string, start: number): { end: number; name: string } {
  let end = start + 1;
  while (end < source.length && COMMAND_PATTERN.test(source[end]!)) end += 1;
  return end === start + 1 ? { end: Math.min(start + 2, source.length), name: "" }
    : { end, name: source.slice(start + 1, end) };
}

function skipSpace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
  return cursor;
}
