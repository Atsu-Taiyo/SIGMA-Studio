import { describe, expect, it } from "vitest";

import type { InlineNode, OverlayTextBlock } from "@/features/document";
import { getOverlayTextBlocksLineCount as documentLineCount } from "@/features/document";

import { getOverlayTextBlocksLineCount } from "./overlay-text-line-count";

const text = (value: string): InlineNode => ({ type: "text", text: value });
const math = (tex: string): InlineNode => ({ type: "mathInline", id: "m", tex, display: "inline" });
let blockId = 0;
const doc = (...blocks: Array<{ children: InlineNode[] }>): OverlayTextBlock[] => (
  blocks.map((block) => ({ type: "paragraph", id: `p_${blockId += 1}`, ...block }))
);
const list = (...items: Array<{ children: InlineNode[] }>): OverlayTextBlock[] => ([{
  type: "list",
  id: `list_${blockId += 1}`,
  listType: "bullet",
  items: items.map((item) => ({ type: "listItem", id: `li_${blockId += 1}`, ...item })),
}]);

/** `[name, document, expectedLineCount]` — the counts are literals, not derived from the code. */
const CORPUS: Array<[string, OverlayTextBlock[], number]> = [
  ["no blocks", doc(), 1],
  ["one empty block", doc({ children: [] }), 1],
  ["one line", doc({ children: [text("ab")] }), 1],
  ["two blocks", doc({ children: [text("a")] }, { children: [text("b")] }), 2],
  ["blank block between", doc({ children: [text("a")] }, { children: [] }, { children: [text("b")] }), 3],
  ["hard break", doc({ children: [text("a\nb")] }), 2],
  ["two hard breaks", doc({ children: [text("a\nb\nc")] }), 3],
  ["leading break", doc({ children: [text("\na")] }), 2],
  ["trailing break", doc({ children: [text("a\n")] }), 2],
  ["CRLF", doc({ children: [text("a\r\nb")] }), 2],
  ["lone CR", doc({ children: [text("a\rb")] }), 1],
  ["math only", doc({ children: [math("x^2")] }), 1],
  ["math plus break", doc({ children: [math("x"), text("\nb")] }), 2],
  ["two runs on one line", doc({ children: [text("a"), text("b")] }), 1],
  ["one list item", list({ children: [text("a")] }), 1],
  ["three list items", list({ children: [text("a")] }, { children: [text("b")] }, { children: [text("c")] }), 3],
  ["list item with a hard break", list({ children: [text("a\nb")] }), 2],
  // The three branches the count has that a paragraph does not: an item's continuations and its
  // nested lists are lines under it, and a divider between them is a line of its own.
  ["a list item with a continuation", withContinuation({ children: [text("a")] }, "b"), 2],
  ["a list item continued by a divider", withDividerContinuation({ children: [text("a")] }), 2],
  ["a list item with a nested list", withNested({ children: [text("a")] }, "b"), 2],
  ["a nested item with its own break", withNested({ children: [text("a")] }, "b\nc"), 3],
  // The blocks a shape gained: a quote counts the lines of what it holds, a code block counts its
  // own breaks, and a rule is one line.
  ["a quote", quote(doc({ children: [text("a")] })), 1],
  ["a quote of several blocks", quote(doc({ children: [text("a")] }, { children: [text("b")] })), 2],
  ["a quote holding a list", quote(list({ children: [text("a")] }, { children: [text("b")] })), 2],
  ["a code block", [{ type: "codeBlock", id: `code_${blockId += 1}`, children: [text("a")] }] as OverlayTextBlock[], 1],
  ["a code block with breaks", [{
    type: "codeBlock",
    id: `code_${blockId += 1}`,
    children: [text("a\nb\nc")],
  }] as OverlayTextBlock[], 3],
  ["a rule", [{ type: "divider", id: `divider_${blockId += 1}` }] as OverlayTextBlock[], 1],
];

/** A quote wrapping the given blocks. */
function quote(blocks: OverlayTextBlock[]): OverlayTextBlock[] {
  return [{ type: "quote", id: `quote_${blockId += 1}`, blocks: blocks as never }];
}

/** A one-item list whose item carries a continuation paragraph. */
function withContinuation(item: { children: InlineNode[] }, continuation: string): OverlayTextBlock[] {
  const [block] = list(item) as [Extract<OverlayTextBlock, { type: "list" }>];
  block.items[0].continuations = [{
    type: "paragraph",
    id: `p_cont_${blockId += 1}`,
    children: [text(continuation)],
  }];
  return [block];
}

/** A one-item list whose item is continued by a divider rather than by prose. */
function withDividerContinuation(item: { children: InlineNode[] }): OverlayTextBlock[] {
  const [block] = list(item) as [Extract<OverlayTextBlock, { type: "list" }>];
  block.items[0].continuations = [{ type: "divider", id: `divider_${blockId += 1}` }];
  return [block];
}

/** A one-item list whose item carries a sub-list. */
function withNested(item: { children: InlineNode[] }, nested: string): OverlayTextBlock[] {
  const [block] = list(item) as [Extract<OverlayTextBlock, { type: "list" }>];
  block.items[0].nested = list({ children: [text(nested)] }) as Extract<OverlayTextBlock, { type: "list" }>[];
  return [block];
}

describe("getOverlayTextBlocksLineCount", () => {
  it.each(CORPUS)("counts the lines of %s", (_name, document, expected) => {
    expect(getOverlayTextBlocksLineCount(document)).toBe(expected);
  });

  /**
   * `features/document` normalizes shape geometry and needs the same count, but it is the layer
   * below this one and cannot import it — so it keeps a private copy. This pins the two together;
   * without it, the copy could drift and change the *stored* size of saved text shapes.
   */
  it.each(CORPUS)("agrees with the document feature's copy for %s", (_name, document) => {
    expect(getOverlayTextBlocksLineCount(document)).toBe(documentLineCount(document));
  });

  /**
   * A lone `\r` is one line, not two. The DOM-free estimator that used to sit beside this counter
   * split on it as well, and that disagreement was pinned rather than fixed because aligning them
   * would have changed the stored height of every shape containing one. The estimator is gone now,
   * so the renderer's rule (`\n` only) is the only rule left — recorded here so it stays that way.
   */
  it("does not break a line on a lone CR", () => {
    expect(getOverlayTextBlocksLineCount(doc({ children: [text("a\rb")] }))).toBe(1);
  });

  it("never throws on a document that is not in canonical form", () => {
    for (const broken of [{}, null, "doc", [{ type: "paragraph" }]]) {
      expect(() => getOverlayTextBlocksLineCount(broken as unknown as OverlayTextBlock[])).not.toThrow();
    }
  });
});
