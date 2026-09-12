import { describe, expect, it } from "vitest";

import type { InlineNode } from "./model";
import {
  overlayTextBlocksToInlineNodes,
  overlayRichTextInlinesToInlineNodes,
} from "./overlay-inline-projection";

describe("overlay rich-text inline projection", () => {
  it("returns semantic inline nodes without a Tiptap-shaped conversion", () => {
    const inlines: InlineNode[] = [
      {
        type: "text",
        text: "前\n",
        marks: ["bold", "boxed"],
        color: "#123456",
        boxedVariant: "double",
      },
      {
        type: "mathInline",
        id: "math_1",
        tex: "x^2",
        display: "inline",
        marks: ["underline"],
      },
    ];

    expect(overlayRichTextInlinesToInlineNodes(inlines)).toEqual(inlines);
    expect(overlayRichTextInlinesToInlineNodes(inlines)).not.toBe(inlines);
  });

  it("projects only the first semantic block for the compatibility helper", () => {
    expect(overlayTextBlocksToInlineNodes([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "first" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "second" }] },
    ])).toEqual([{ type: "text", text: "first" }]);
  });

  it("projects the first item when the shape starts with a list", () => {
    expect(overlayTextBlocksToInlineNodes([{
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "first" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "second" }] },
      ],
    }])).toEqual([{ type: "text", text: "first" }]);
  });
});
