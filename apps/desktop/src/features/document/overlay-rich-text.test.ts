import { describe, expect, it } from "vitest";

import type { OverlayTextBlock } from "./overlay-model";
import { appendOverlayTextInline } from "./overlay-rich-text";

let blockId = 0;
const createId = () => `p_${blockId += 1}`;

describe("appendOverlayTextInline", () => {
  it("appends inline math inside the final semantic heading", () => {
    const blocks: OverlayTextBlock[] = [
      { type: "paragraph", id: "p_a", children: [{ type: "text", text: "前" }] },
      { type: "heading", id: "h_a", level: 2, children: [{ type: "text", text: "末尾" }] },
    ];
    const inline = {
      type: "mathInline" as const,
      id: "math_1",
      tex: "x^2",
      display: "inline" as const,
    };

    const next = appendOverlayTextInline(blocks, inline, createId);

    expect(next).toEqual([
      blocks[0],
      { ...blocks[1], children: [...(blocks[1] as { children: unknown[] }).children, inline] },
    ]);
    expect(next).toHaveLength(2);
    expect((blocks[1] as { children: unknown[] }).children).toHaveLength(1);
  });

  it("appends inside the last item of a trailing list", () => {
    const blocks: OverlayTextBlock[] = [{
      type: "list",
      id: "list_a",
      listType: "bullet",
      items: [
        { type: "listItem", id: "li_a", children: [{ type: "text", text: "一" }] },
        { type: "listItem", id: "li_b", children: [{ type: "text", text: "二" }] },
      ],
    }];
    const inline = { type: "text" as const, text: "!" };

    const next = appendOverlayTextInline(blocks, inline, createId);

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: "list",
      items: [
        { id: "li_a", children: [{ type: "text", text: "一" }] },
        { id: "li_b", children: [{ type: "text", text: "二" }, inline] },
      ],
    });
  });

  it("creates a paragraph when the shape has no block", () => {
    const inline = { type: "text" as const, text: "\n" };
    const next = appendOverlayTextInline([], inline, () => "p_new");

    expect(next).toEqual([{ type: "paragraph", id: "p_new", children: [inline] }]);
  });
});
