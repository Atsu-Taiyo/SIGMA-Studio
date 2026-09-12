import { readCommandAt, readBraceGroup, readBracketGroup, skipWhitespace, isEscaped, type TexGroup } from "./scanner";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const t = createCurrentLocaleTranslator("tex");
const SEMANTIC_CUSTOM_COMMANDS = new Set(["anaume", "maru", "rulecenter", "sanaume"]);
const DECLARATIONS = new Set(["newcommand", "renewcommand", "providecommand"]);
const MAX_MACRO_EXPANSION_DEPTH = 32;
const MAX_EXPANDED_CHARS = 2 * 1024 * 1024;

export interface TexMacroDefinition {
  name: string;
  argCount: number;
  defaultArg?: string;
  replacement: string;
}

export function collectTexMacroDefinitions(source: string): Map<string, TexMacroDefinition> {
  const macros = new Map<string, TexMacroDefinition>();
  let index = 0;

  while (index < source.length) {
    const command = readCommandAt(source, index);
    if (!command || !DECLARATIONS.has(command.name)) {
      index += 1;
      continue;
    }

    const definition = readTexMacroDefinition(source, command.endIndex);
    if (!definition) {
      index = command.endIndex;
      continue;
    }

    if (!SEMANTIC_CUSTOM_COMMANDS.has(definition.name)
      && !(command.name === "providecommand" && macros.has(definition.name))) {
      macros.set(definition.name, definition);
    }
    index = definition.endIndex;
  }

  return macros;
}

function readTexMacroDefinition(
  source: string,
  index: number,
): (TexMacroDefinition & { endIndex: number }) | null {
  const nameResult = readMacroName(source, index);
  if (!nameResult) {
    return null;
  }

  let cursor = nameResult.endIndex;
  const argCountGroup = readBracketGroup(source, cursor);
  if (argCountGroup && !/^[0-9]$/.test(argCountGroup.value.trim())) return null;
  const argCount = argCountGroup ? Number(argCountGroup.value.trim()) : 0;
  if (argCountGroup) {
    cursor = argCountGroup.endIndex;
  }

  let defaultArg: string | undefined;
  const defaultGroup = readBracketGroup(source, cursor);
  if (defaultGroup && argCount > 0) {
    defaultArg = defaultGroup.value;
    cursor = defaultGroup.endIndex;
  }

  const replacement = readBraceGroup(source, cursor);
  if (!replacement) {
    return null;
  }

  return {
    name: nameResult.name,
    argCount: Number.isFinite(argCount) ? Math.max(0, Math.min(9, argCount)) : 0,
    defaultArg,
    replacement: replacement.value,
    endIndex: replacement.endIndex,
  };
}

function readMacroName(source: string, index: number): { name: string; endIndex: number } | null {
  const group = readBraceGroup(source, index);
  if (group) {
    const commandName = group.value.trim().match(/^\\([A-Za-z]+)\*?$/)?.[1];
    return commandName ? { name: commandName, endIndex: group.endIndex } : null;
  }

  const command = readCommandAt(source, skipWhitespace(source, index));
  return command ? { name: command.name, endIndex: command.endIndex } : null;
}

/** Strip declarations before expanding: a declaration's name and body are not invocations. */
export function removeTexMacroDefinitions(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const command = readCommandAt(source, index);
    if (command && DECLARATIONS.has(command.name)) {
      const definition = readTexMacroDefinition(source, command.endIndex);
      if (!definition) throw new Error(t("import.macroDefinition"));
      index = definition.endIndex;
    } else {
      output += source[index++];
    }
  }
  return output;
}

/** Bound both output size and total work, including macros which discard their arguments. */
export function expandTexMacros(source: string, macros: Map<string, TexMacroDefinition>): string {
  const budget = { remaining: MAX_EXPANDED_CHARS, invocations: 50_000 };
  const expand = (input: string, depth: number): string => {
    if (depth > MAX_MACRO_EXPANSION_DEPTH) throw new Error(t("import.macroLimit"));
    const chunks: string[] = [];
    let index = 0;
    let rawStart = 0;
    const append = (value: string) => {
      budget.remaining -= value.length;
      if (budget.remaining < 0) throw new Error(t("import.macroLimit"));
      chunks.push(value);
    };
    while (index < input.length) {
      const command = readCommandAt(input, index);
      const macro = command ? macros.get(command.name) : undefined;
      if (!command || !macro) {
        index += 1;
        continue;
      }
      append(input.slice(rawStart, index));
      const invocation = readMacroInvocation(input, command.endIndex - (command.starred ? 1 : 0), macro);
      if (!invocation) throw new Error(t("import.macroArguments", { name: macro.name }));
      if (--budget.invocations < 0) throw new Error(t("import.macroLimit"));
      // Children account for their own output; do not count the same bytes twice.
      chunks.push(expand(applyTexMacroReplacement(macro, invocation.args), depth + 1));
      index = invocation.endIndex;
      rawStart = index;
    }
    append(input.slice(rawStart));
    return joinTexTokens(chunks);
  };
  return expand(source, 0);
}

function readMacroInvocation(
  source: string,
  index: number,
  macro: TexMacroDefinition,
): { args: string[]; endIndex: number } | null {
  const args: string[] = [];
  let cursor = index;

  if (macro.defaultArg !== undefined && macro.argCount > 0) {
    const optionalArg = readBracketGroup(source, cursor);
    if (optionalArg) {
      args.push(optionalArg.value);
      cursor = optionalArg.endIndex;
    } else {
      args.push(macro.defaultArg);
    }
  }

  while (args.length < macro.argCount) {
    const arg = readMacroInvocationArgument(source, cursor);
    if (!arg) {
      return null;
    }
    args.push(arg.value);
    cursor = arg.endIndex;
  }

  return { args, endIndex: cursor };
}

function readMacroInvocationArgument(source: string, index: number): TexGroup | null {
  const group = readBraceGroup(source, index);
  if (group) {
    return group;
  }

  const cursor = skipWhitespace(source, index);
  const command = readCommandAt(source, cursor);
  if (command) {
    return {
      value: source.slice(cursor, command.endIndex),
      endIndex: command.endIndex,
    };
  }

  const value = source[cursor];
  if (!value || /[{}\[\]\s]/.test(value)) {
    return null;
  }
  return {
    value,
    endIndex: cursor + 1,
  };
}

/** Preserve control-word token boundaries when a macro argument/replacement touches a letter. */
function joinTexTokens(chunks: string[]): string {
  let previous = "";
  const output: string[] = [];
  let length = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    const tail = previous.match(/\\[A-Za-z]+$/);
    const separator = /^[A-Za-z]/.test(chunk) && tail && !isEscaped(previous, tail.index!) ? " " : "";
    length += separator.length + chunk.length;
    if (length > MAX_EXPANDED_CHARS) throw new Error(t("import.macroLimit"));
    output.push(separator, chunk);
    previous = chunk;
  }
  return output.join("");
}

function applyTexMacroReplacement(macro: TexMacroDefinition, args: string[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  let length = macro.replacement.length;
  for (const match of macro.replacement.matchAll(/#([1-9])/g)) {
    const replacement = args[Number(match[1]) - 1] ?? match[0];
    length += replacement.length - match[0].length;
    if (length > MAX_EXPANDED_CHARS) throw new Error(t("import.macroLimit"));
    chunks.push(macro.replacement.slice(cursor, match.index), replacement);
    cursor = match.index + match[0].length;
  }
  chunks.push(macro.replacement.slice(cursor));
  return joinTexTokens(chunks);
}
