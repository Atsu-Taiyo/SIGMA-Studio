export interface TexCommand {
  name: string;
  starred: boolean;
  endIndex: number;
}

export interface TexGroup {
  value: string;
  endIndex: number;
}

export interface TexEnvironmentOpen {
  name: string;
  option?: string;
  contentStartIndex: number;
}

export interface TexEnvironment extends TexEnvironmentOpen {
  body: string;
  endIndex: number;
}

export function readEnvironmentAt(source: string, index: number): TexEnvironment | null {
  const open = readEnvironmentOpenAt(source, index);
  if (!open) {
    return null;
  }

  let depth = 1;
  let cursor = open.contentStartIndex;

  while (cursor < source.length) {
    const nextSlashIndex = source.indexOf("\\", cursor);
    if (nextSlashIndex < 0) {
      return null;
    }
    const command = readCommandAt(source, nextSlashIndex);
    if (!command || (command.name !== "begin" && command.name !== "end")) {
      cursor = nextSlashIndex + 1;
      continue;
    }

    const group = readBraceGroup(source, command.endIndex);
    if (!group) {
      cursor = command.endIndex;
      continue;
    }

    if (group.value.trim() === open.name) {
      if (command.name === "begin") {
        depth += 1;
      } else {
        depth -= 1;
        if (depth === 0) {
          return {
            ...open,
            body: source.slice(open.contentStartIndex, nextSlashIndex),
            endIndex: group.endIndex,
          };
        }
      }
    }
    cursor = group.endIndex;
  }

  return null;
}

export function readEnvironmentOpenAt(source: string, index: number): TexEnvironmentOpen | null {
  const command = readCommandAt(source, index);
  if (command?.name !== "begin") {
    return null;
  }

  const group = readBraceGroup(source, command.endIndex);
  if (!group) {
    return null;
  }

  const option = readBracketGroup(source, group.endIndex);
  return {
    name: group.value.trim(),
    option: option?.value,
    contentStartIndex: option?.endIndex ?? group.endIndex,
  };
}

export function readCommandAt(source: string, index: number): TexCommand | null {
  if (source[index] !== "\\" || isEscaped(source, index) || !/[A-Za-z]/.test(source[index + 1] ?? "")) {
    return null;
  }

  let cursor = index + 1;
  while (/[A-Za-z]/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  const name = source.slice(index + 1, cursor);
  const starred = source[cursor] === "*";
  if (starred) {
    cursor += 1;
  }
  return { name, starred, endIndex: cursor };
}

export function readCommandContentGroup(source: string, index: number): TexGroup | null {
  let cursor = index;
  while (true) {
    const option = readBracketGroup(source, cursor);
    if (!option) {
      break;
    }
    cursor = option.endIndex;
  }
  return readBraceGroup(source, cursor);
}

export function readCommandArgument(source: string, index: number): TexGroup | null {
  const group = readCommandContentGroup(source, index);
  if (group) {
    return group;
  }

  const cursor = skipWhitespace(source, index);
  const value = source[cursor];
  if (!value || /[\\{}\[\]\s]/.test(value)) {
    return null;
  }
  return {
    value,
    endIndex: cursor + 1,
  };
}

export function readBraceGroup(source: string, index: number): TexGroup | null {
  let cursor = skipWhitespace(source, index);
  if (source[cursor] !== "{") {
    return null;
  }
  cursor += 1;
  const start = cursor;
  let depth = 1;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          value: source.slice(start, cursor),
          endIndex: cursor + 1,
        };
      }
    }
    cursor += 1;
  }

  return null;
}

export function readBracketGroup(source: string, index: number): TexGroup | null {
  let cursor = skipWhitespace(source, index);
  if (source[cursor] !== "[") {
    return null;
  }
  cursor += 1;
  const start = cursor;
  let depth = 1;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "{") {
      const group = readBraceGroup(source, cursor);
      if (!group) return null;
      cursor = group.endIndex;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          value: source.slice(start, cursor),
          endIndex: cursor + 1,
        };
      }
    }
    cursor += 1;
  }

  return null;
}

export function skipCommandArguments(source: string, index: number): number {
  let cursor = index;
  let consumed = false;

  for (let count = 0; count < 3; count += 1) {
    const bracketGroup = readBracketGroup(source, cursor);
    if (bracketGroup) {
      cursor = bracketGroup.endIndex;
      consumed = true;
      continue;
    }

    const braceGroup = readBraceGroup(source, cursor);
    if (braceGroup) {
      cursor = braceGroup.endIndex;
      consumed = true;
      continue;
    }

    break;
  }

  return consumed ? cursor : index;
}

export function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

export function stripTexComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] === "%" && !isEscaped(line, index)) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

export function startsWithUnescaped(source: string, index: number, token: string): boolean {
  return source.startsWith(token, index) && !isEscaped(source, index);
}

export function findUnescaped(source: string, token: string, startIndex: number): number {
  let cursor = source.indexOf(token, startIndex);
  while (cursor >= 0) {
    if (!isEscaped(source, cursor)) {
      return cursor;
    }
    cursor = source.indexOf(token, cursor + token.length);
  }
  return -1;
}

export function findInlineDollarEnd(source: string, startIndex: number): number {
  let cursor = source.indexOf("$", startIndex);
  while (cursor >= 0) {
    if (!isEscaped(source, cursor) && !source.startsWith("$$", cursor)) {
      return cursor;
    }
    cursor = source.indexOf("$", cursor + 1);
  }
  return -1;
}

export function isEscaped(source: string, index: number): boolean {
  let slashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && source[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }
  return slashCount % 2 === 1;
}
