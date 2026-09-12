import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

const MAX_TEX_PREAMBLE_LENGTH = 20_000;
const MAX_TEX_MACRO_COUNT = 100;
const SUPPORTED_DECLARATIONS = new Set(["newcommand", "renewcommand", "providecommand"]);
const DEFAULT_TEX_TRANSLATE = createCurrentLocaleTranslator("tex");

export interface TexPreambleIssue {
  line: number;
  message: string;
}

export interface TexMacroDefinition {
  args: number;
  def: string;
}

export interface ParsedTexPreamble {
  issues: TexPreambleIssue[];
  macros: Record<string, TexMacroDefinition>;
}

/**
 * Parse the safe, renderer-independent subset of a LaTeX preamble that both
 * MathLive and KaTeX can represent as macro expansion tables.
 */
export function parseTexPreamble(
  source: string,
  t: Translate<"tex"> = DEFAULT_TEX_TRANSLATE,
): ParsedTexPreamble {
  const issues: TexPreambleIssue[] = [];
  const macros: Record<string, TexMacroDefinition> = {};
  if (source.length > MAX_TEX_PREAMBLE_LENGTH) {
    return {
      issues: [{ line: 1, message: t("preamble.tooLong", { max: MAX_TEX_PREAMBLE_LENGTH }) }],
      macros,
    };
  }

  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipTrivia(source, cursor);
    if (cursor >= source.length) {
      break;
    }
    const declarationStart = cursor;
    const declaration = readControlSequence(source, cursor);
    if (!declaration) {
      issues.push({ line: lineAt(source, cursor), message: t("preamble.unreadable") });
      cursor = nextLine(source, cursor);
      continue;
    }
    cursor = declaration.end;
    if (!SUPPORTED_DECLARATIONS.has(declaration.name)) {
      issues.push({
        line: lineAt(source, declarationStart),
        message: t("preamble.unsupported", { name: declaration.name }),
      });
      cursor = nextLine(source, cursor);
      continue;
    }

    cursor = skipTrivia(source, cursor);
    const nameResult = readMacroName(source, cursor);
    if (!nameResult) {
      issues.push({ line: lineAt(source, declarationStart), message: t("preamble.nameRequired") });
      cursor = nextLine(source, cursor);
      continue;
    }
    cursor = skipTrivia(source, nameResult.end);

    let args = 0;
    if (source[cursor] === "[") {
      const argsResult = readBracket(source, cursor);
      if (!argsResult || !/^\d+$/.test(argsResult.value.trim())) {
        issues.push({ line: lineAt(source, declarationStart), message: t("preamble.argInteger") });
        cursor = nextLine(source, cursor);
        continue;
      }
      args = Number(argsResult.value.trim());
      if (args < 0 || args > 9) {
        issues.push({ line: lineAt(source, declarationStart), message: t("preamble.argRange") });
        cursor = nextLine(source, cursor);
        continue;
      }
      cursor = skipTrivia(source, argsResult.end);
      if (source[cursor] === "[") {
        issues.push({ line: lineAt(source, declarationStart), message: t("preamble.optionalUnsupported") });
        cursor = nextLine(source, cursor);
        continue;
      }
    }

    const bodyResult = readBalancedGroup(source, cursor);
    if (!bodyResult) {
      issues.push({ line: lineAt(source, declarationStart), message: t("preamble.bodyUnclosed") });
      cursor = nextLine(source, cursor);
      continue;
    }
    cursor = bodyResult.end;

    const existing = macros[nameResult.name];
    if (declaration.name === "newcommand" && existing) {
      issues.push({ line: lineAt(source, declarationStart), message: t("preamble.alreadyDefined", { name: nameResult.name }) });
      continue;
    }
    if (declaration.name === "renewcommand" && !existing) {
      issues.push({ line: lineAt(source, declarationStart), message: t("preamble.notDefined", { name: nameResult.name }) });
      continue;
    }
    if (declaration.name === "providecommand" && existing) {
      continue;
    }
    if (!existing && Object.keys(macros).length >= MAX_TEX_MACRO_COUNT) {
      issues.push({ line: lineAt(source, declarationStart), message: t("preamble.tooMany", { max: MAX_TEX_MACRO_COUNT }) });
      continue;
    }
    macros[nameResult.name] = { args, def: bodyResult.value };
  }

  return { issues, macros };
}

function skipTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "%" && source[cursor - 1] !== "\\") {
      cursor = nextLine(source, cursor);
      continue;
    }
    break;
  }
  return cursor;
}

function nextLine(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function readControlSequence(source: string, start: number): { end: number; name: string } | null {
  if (source[start] !== "\\") return null;
  let cursor = start + 1;
  while (cursor < source.length && /[A-Za-z@]/.test(source[cursor])) cursor += 1;
  return cursor === start + 1 ? null : { end: cursor, name: source.slice(start + 1, cursor) };
}

function readMacroName(source: string, start: number): { end: number; name: string } | null {
  if (source[start] === "{") {
    const group = readBalancedGroup(source, start);
    if (!group) return null;
    const command = readControlSequence(group.value.trim(), 0);
    return command && command.end === group.value.trim().length
      ? { end: group.end, name: command.name }
      : null;
  }
  return readControlSequence(source, start);
}

function readBracket(source: string, start: number): { end: number; value: string } | null {
  const end = source.indexOf("]", start + 1);
  return source[start] === "[" && end >= 0 ? { end: end + 1, value: source.slice(start + 1, end) } : null;
}

function readBalancedGroup(source: string, start: number): { end: number; value: string } | null {
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === "%" && source[cursor - 1] !== "\\") {
      cursor = nextLine(source, cursor) - 1;
      continue;
    }
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return { end: cursor + 1, value: source.slice(start + 1, cursor) };
    }
  }
  return null;
}
