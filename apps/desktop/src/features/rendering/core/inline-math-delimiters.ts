export type DelimitedInlineMathSegment =
  | { type: "text"; text: string }
  | { type: "math"; tex: string };

export function splitDelimitedInlineMathText(text: string): DelimitedInlineMathSegment[] {
  const segments: DelimitedInlineMathSegment[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (value.length > 0) {
      segments.push({ type: "text", text: value });
    }
  };

  const pushMath = (value: string) => {
    const tex = value.trim();
    if (tex.length > 0) {
      segments.push({ type: "math", tex });
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const delimiter = getOpeningDelimiter(text, index);
    if (!delimiter) {
      continue;
    }

    const closeIndex = findClosingDelimiter(text, index + delimiter.open.length, delimiter.close);
    if (closeIndex < 0) {
      continue;
    }

    pushText(text.slice(cursor, index));
    pushMath(text.slice(index + delimiter.open.length, closeIndex));
    index = closeIndex + delimiter.close.length - 1;
    cursor = index + 1;
  }

  pushText(text.slice(cursor));
  return segments.length > 0 ? segments : [{ type: "text", text }];
}

function getOpeningDelimiter(text: string, index: number): { open: string; close: string } | null {
  if (text.startsWith("\\(", index)) {
    return { open: "\\(", close: "\\)" };
  }

  if (text.startsWith("\\[", index)) {
    return { open: "\\[", close: "\\]" };
  }

  // $$...$$ (display-math delimiter) is checked before the single-$ case so
  // that a "$$" pair is not mistaken for two independent single-$ opens (the
  // model is told never to emit $$, but the app still splits it correctly as
  // a fallback so that promise holds even when it does).
  if (
    text.startsWith("$$", index) &&
    text[index - 1] !== "\\"
  ) {
    return { open: "$$", close: "$$" };
  }

  if (
    text[index] === "$" &&
    text[index - 1] !== "\\" &&
    text[index + 1] !== "$"
  ) {
    return { open: "$", close: "$" };
  }

  return null;
}

function findClosingDelimiter(text: string, startIndex: number, close: string): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (!text.startsWith(close, index)) {
      continue;
    }

    if (close === "$" && (text[index - 1] === "\\" || text[index + 1] === "$")) {
      continue;
    }

    return index;
  }

  return -1;
}
