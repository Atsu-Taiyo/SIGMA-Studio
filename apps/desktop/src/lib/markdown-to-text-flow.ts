import type { InlineNode, ListNode, TextMark } from "@/features/document";
import { normalizeCodeLanguage } from "@/features/rendering/adapters";
import type { TextFlowBlock } from "@/features/text-editing";
import { createId } from "@/lib/id";

const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/;
/** groups: 1 indent, 2 marker, 3 `(n)` number, 4 `n.` / `n)` number, 5 item text. */
const LIST_ITEM_PATTERN = /^(\s*)([-+*]|\((\d+)\)|(\d+)[.)])[\t ]+(.+?)\s*$/;

interface MarkdownListItemLine {
  indent: number;
  listType: ListNode["listType"];
  markerStyle?: ListNode["markerStyle"];
  start?: number;
  text: string;
}

interface MarkdownListParseResult {
  list: ListNode;
  nextLineIndex: number;
}

interface MarkdownCodeFenceParseResult {
  block: Extract<TextFlowBlock, { type: "codeBlock" }>;
  nextLineIndex: number;
}

/**
 * Converts Markdown text into canonical text-flow blocks. Paste callers keep
 * the conservative default so ordinary prose stays on Tiptap's native path;
 * trusted Markdown entry points can set requireMarkdownSyntax to false.
 */
export function parseMarkdownToTextFlowBlocks(
  text: string,
  options: { requireMarkdownSyntax?: boolean } = {},
): TextFlowBlock[] | null {
  const lines = normalizePastedLines(text);
  if (options.requireMarkdownSyntax !== false && !looksLikeMarkdown(lines)) {
    return null;
  }

  const blocks: TextFlowBlock[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if (!lines[lineIndex].trim()) {
      lineIndex += 1;
      continue;
    }

    const fencedCode = parseMarkdownCodeFence(lines, lineIndex);
    if (fencedCode) {
      blocks.push(fencedCode.block);
      lineIndex = fencedCode.nextLineIndex;
      continue;
    }

    const heading = matchHeading(lines[lineIndex]);
    if (heading) {
      blocks.push({
        type: "heading",
        id: createId("heading"),
        level: heading.level,
        children: parseInlineMarkdown(heading.text),
      });
      lineIndex += 1;
      continue;
    }

    const listItem = matchListItem(lines[lineIndex]);
    if (listItem) {
      const parsed = parseMarkdownList(lines, lineIndex, listItem.indent, {
        listType: listItem.listType,
        markerStyle: listItem.markerStyle,
      });
      blocks.push(parsed.list);
      lineIndex = parsed.nextLineIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (lineIndex < lines.length) {
      const line = lines[lineIndex];
      if (!line.trim() || matchCodeFenceOpening(line) || matchHeading(line) || matchListItem(line)) {
        break;
      }
      paragraphLines.push(line.trim());
      lineIndex += 1;
    }
    blocks.push({
      type: "paragraph",
      id: createId("p"),
      children: parseInlineMarkdown(joinParagraphLines(paragraphLines)),
    });
  }

  return blocks.length > 0 ? blocks : null;
}

function normalizePastedLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n");
}

function looksLikeMarkdown(lines: readonly string[]): boolean {
  return lines.some((line) => Boolean(
    matchCodeFenceOpening(line) ||
    matchHeading(line) ||
    matchListItem(line) ||
    hasDelimitedInlineMath(line)
  ));
}

function parseMarkdownCodeFence(
  lines: readonly string[],
  startLineIndex: number,
): MarkdownCodeFenceParseResult | null {
  const opening = matchCodeFenceOpening(lines[startLineIndex]);
  if (!opening) {
    return null;
  }

  const bodyLines: string[] = [];
  if (opening.leadingCode) {
    bodyLines.push(opening.leadingCode);
  }
  let lineIndex = startLineIndex + 1;
  while (lineIndex < lines.length && !isCodeFenceClosing(lines[lineIndex], opening.marker)) {
    bodyLines.push(lines[lineIndex]);
    lineIndex += 1;
  }
  if (lineIndex < lines.length) {
    lineIndex += 1;
  }

  const code = bodyLines.join("\n");
  const children: InlineNode[] = code ? [{ type: "text", text: code }] : [];
  return {
    block: {
      type: "codeBlock",
      id: createId("code"),
      children,
      ...(opening.language ? { language: opening.language } : {}),
    },
    nextLineIndex: lineIndex,
  };
}

function matchCodeFenceOpening(
  line: string,
): { marker: string; language?: string; leadingCode?: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const suffix = match[2].trim();
  const language = normalizeCodeLanguage(suffix);
  return {
    marker: match[1],
    ...(language ? { language } : {}),
    ...(!language && suffix ? { leadingCode: suffix } : {}),
  };
}

function isCodeFenceClosing(line: string, openingMarker: string): boolean {
  const markerCharacter = openingMarker[0];
  const markerRun = line.trim();
  return markerRun.length >= openingMarker.length
    && Array.from(markerRun).every((character) => character === markerCharacter);
}

function matchHeading(line: string): { level: 1 | 2 | 3; text: string } | null {
  const match = line.match(ATX_HEADING_PATTERN);
  if (!match || !match[2].trim()) {
    return null;
  }

  const rawLevel = match[1].length;
  const text = match[2].replace(/[\t ]+#+[\t ]*$/, "").trim();
  if (!text) {
    return null;
  }

  return {
    level: Math.min(rawLevel, 3) as 1 | 2 | 3,
    text,
  };
}

function matchListItem(line: string): MarkdownListItemLine | null {
  const match = line.replace(/\t/g, "    ").match(LIST_ITEM_PATTERN);
  if (!match || !match[5].trim()) {
    return null;
  }

  const parenStart = match[3] ? Number(match[3]) : undefined;
  const decimalStart = match[4] ? Number(match[4]) : undefined;
  const orderedStart = parenStart ?? decimalStart;
  return {
    indent: match[1].length,
    listType: orderedStart === undefined ? "bullet" : "ordered",
    ...(parenStart !== undefined ? { markerStyle: "paren" as const } : {}),
    ...(orderedStart !== undefined ? { start: orderedStart } : {}),
    text: match[5].trim(),
  };
}

/**
 * `(1)` と `1.` は同じ番号付きリストでもマーカーが違うので、混在したら別のリストに割る。
 */
function isSameListRun(itemLine: MarkdownListItemLine, run: MarkdownListRun): boolean {
  return itemLine.listType === run.listType && itemLine.markerStyle === run.markerStyle;
}

interface MarkdownListRun {
  listType: ListNode["listType"];
  markerStyle?: ListNode["markerStyle"];
}

function parseMarkdownList(
  lines: readonly string[],
  startLineIndex: number,
  indent: number,
  run: MarkdownListRun,
): MarkdownListParseResult {
  const items: ListNode["items"] = [];
  let lineIndex = startLineIndex;
  let orderedStart: number | undefined;

  while (lineIndex < lines.length) {
    const itemLine = matchListItem(lines[lineIndex]);
    if (!itemLine || itemLine.indent !== indent || !isSameListRun(itemLine, run)) {
      break;
    }
    if (orderedStart === undefined) {
      orderedStart = itemLine.start;
    }

    const itemTextLines = [itemLine.text];
    const nested: ListNode[] = [];
    lineIndex += 1;

    while (lineIndex < lines.length) {
      const line = lines[lineIndex];
      if (!line.trim()) {
        break;
      }

      const nextItem = matchListItem(line);
      if (nextItem) {
        if (nextItem.indent <= indent) {
          break;
        }
        const parsedNested = parseMarkdownList(
          lines,
          lineIndex,
          nextItem.indent,
          { listType: nextItem.listType, markerStyle: nextItem.markerStyle },
        );
        nested.push(parsedNested.list);
        lineIndex = parsedNested.nextLineIndex;
        continue;
      }

      const continuationIndent = leadingSpaceCount(line);
      if (continuationIndent <= indent || matchHeading(line)) {
        break;
      }
      itemTextLines.push(line.trim());
      lineIndex += 1;
    }

    items.push({
      type: "listItem",
      id: createId("li"),
      children: parseInlineMarkdown(joinParagraphLines(itemTextLines)),
      ...(nested.length > 0 ? { nested } : {}),
    });

    if (!lines[lineIndex]?.trim()) {
      const nextContentIndex = findNextContentLine(lines, lineIndex);
      const nextItem = nextContentIndex < lines.length ? matchListItem(lines[nextContentIndex]) : null;
      if (nextItem?.indent === indent && isSameListRun(nextItem, run)) {
        lineIndex = nextContentIndex;
      } else {
        break;
      }
    }
  }

  return {
    list: {
      type: "list",
      id: createId("list"),
      listType: run.listType,
      ...(run.listType === "ordered" && orderedStart !== undefined && orderedStart !== 1
        ? { start: orderedStart }
        : {}),
      ...(run.listType === "ordered" && run.markerStyle ? { markerStyle: run.markerStyle } : {}),
      items,
    },
    nextLineIndex: lineIndex,
  };
}

function findNextContentLine(lines: readonly string[], startLineIndex: number): number {
  let lineIndex = startLineIndex;
  while (lineIndex < lines.length && !lines[lineIndex].trim()) {
    lineIndex += 1;
  }
  return lineIndex;
}

function leadingSpaceCount(line: string): number {
  return line.replace(/\t/g, "    ").match(/^ */)?.[0].length ?? 0;
}

function joinParagraphLines(lines: readonly string[]): string {
  return lines.join(" ");
}

/**
 * 1 行ぶんのインライン Markdown (太字・斜体・`$...$` の数式・エスケープ) を
 * SigmaDoc のインラインノード列へ変換する。ブロック構造は解釈しない。
 */
export function parseInlineMarkdown(text: string, marks: readonly TextMark[] = []): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plainText = "";
  let index = 0;

  const flushPlainText = () => {
    if (!plainText) {
      return;
    }
    pushTextNode(nodes, plainText, marks);
    plainText = "";
  };

  while (index < text.length) {
    if (text[index] === "\\" && isEscapableMarkdownCharacter(text[index + 1])) {
      plainText += text[index + 1];
      index += 2;
      continue;
    }

    const mathDelimiter = inlineMathDelimiterAt(text, index);
    if (mathDelimiter) {
      const closeIndex = findClosingMathDelimiter(
        text,
        index + mathDelimiter.length,
        mathDelimiter,
      );
      if (closeIndex >= 0) {
        const tex = text.slice(index + mathDelimiter.length, closeIndex).trim();
        if (tex) {
          flushPlainText();
          nodes.push({
            type: "mathInline",
            id: createId("m_inline"),
            tex,
            display: "inline",
          });
          index = closeIndex + mathDelimiter.length;
          continue;
        }
      }
    }

    const delimiter = inlineDelimiterAt(text, index);
    if (!delimiter) {
      plainText += text[index];
      index += 1;
      continue;
    }

    const closeIndex = findClosingDelimiter(text, index + delimiter.token.length, delimiter.token);
    if (closeIndex < 0) {
      plainText += delimiter.token;
      index += delimiter.token.length;
      continue;
    }

    const innerText = text.slice(index + delimiter.token.length, closeIndex);
    if (!innerText.trim()) {
      plainText += delimiter.token;
      index += delimiter.token.length;
      continue;
    }

    flushPlainText();
    const nextMarks = marks.includes(delimiter.mark) ? marks : [...marks, delimiter.mark];
    for (const node of parseInlineMarkdown(innerText, nextMarks)) {
      if (node.type === "text") {
        pushTextNode(nodes, node.text, node.marks ?? []);
      } else {
        nodes.push(node);
      }
    }
    index = closeIndex + delimiter.token.length;
  }

  flushPlainText();
  return nodes;
}

function inlineDelimiterAt(text: string, index: number): { token: string; mark: TextMark } | null {
  const twoCharacters = text.slice(index, index + 2);
  if ((twoCharacters === "**" || twoCharacters === "__") && !isWhitespace(text[index + 2])) {
    return { token: twoCharacters, mark: "bold" };
  }

  const token = text[index];
  if ((token !== "*" && token !== "_") || isWhitespace(text[index + 1])) {
    return null;
  }
  if (token === "_" && isWordCharacter(text[index - 1])) {
    return null;
  }
  return { token, mark: "italic" };
}

function findClosingDelimiter(text: string, startIndex: number, delimiter: string): number {
  let closeIndex = text.indexOf(delimiter, startIndex);
  while (closeIndex >= 0) {
    const escaped = closeIndex > 0 && text[closeIndex - 1] === "\\";
    const hasContentBefore = closeIndex > startIndex && !isWhitespace(text[closeIndex - 1]);
    const closesWordUnderscore = delimiter === "_" && isWordCharacter(text[closeIndex + 1]);
    if (!escaped && hasContentBefore && !closesWordUnderscore) {
      return closeIndex;
    }
    closeIndex = text.indexOf(delimiter, closeIndex + delimiter.length);
  }
  return -1;
}

function hasDelimitedInlineMath(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const delimiter = inlineMathDelimiterAt(text, index);
    if (!delimiter) {
      continue;
    }
    const closeIndex = findClosingMathDelimiter(text, index + delimiter.length, delimiter);
    if (closeIndex >= 0 && text.slice(index + delimiter.length, closeIndex).trim()) {
      return true;
    }
  }
  return false;
}

function inlineMathDelimiterAt(text: string, index: number): "$" | "$$" | null {
  if (text[index] !== "$" || text[index - 1] === "\\") {
    return null;
  }
  if (text.startsWith("$$", index)) {
    return "$$";
  }
  if (text[index - 1] === "$" || text[index + 1] === "$") {
    return null;
  }
  return "$";
}

function findClosingMathDelimiter(text: string, startIndex: number, delimiter: "$" | "$$"): number {
  let closeIndex = text.indexOf(delimiter, startIndex);
  while (closeIndex >= 0) {
    const escaped = closeIndex > 0 && text[closeIndex - 1] === "\\";
    const touchesDoubleDollar = delimiter === "$" && (
      text[closeIndex - 1] === "$" || text[closeIndex + 1] === "$"
    );
    if (!escaped && !touchesDoubleDollar) {
      return closeIndex;
    }
    closeIndex = text.indexOf(delimiter, closeIndex + delimiter.length);
  }
  return -1;
}

function isEscapableMarkdownCharacter(character: string | undefined): boolean {
  return character === "\\" || character === "*" || character === "_" || character === "#" || character === "$";
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

function pushTextNode(nodes: InlineNode[], text: string, marks: readonly TextMark[]): void {
  if (!text) {
    return;
  }

  const normalizedMarks = marks.length > 0 ? [...marks] : undefined;
  const previous = nodes[nodes.length - 1];
  if (
    previous?.type === "text" &&
    (previous.marks ?? []).join("|") === (normalizedMarks ?? []).join("|")
  ) {
    previous.text += text;
    return;
  }

  nodes.push({
    type: "text",
    text,
    ...(normalizedMarks ? { marks: normalizedMarks } : {}),
  });
}
