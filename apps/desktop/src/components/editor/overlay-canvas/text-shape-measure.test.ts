import { describe, expect, it } from "vitest";

import { CALLOUT_TEXT_PADDING } from "@/features/drawing";

import { overlayTextBoxHeightForContent } from "./text-shape-measure";
import type { OverlayShape } from "./types";

function textShape(fontSize?: number): Extract<OverlayShape, { type: "text" }> {
  return {
    id: "shape_text",
    type: "text",
    x: 0,
    y: 0,
    props: {
      w: 200,
      h: 16,
      color: "#111827",
      size: "m",
      ...(fontSize === undefined ? {} : { fontSize }),
      blocks: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] }],
    },
  };
}

function calloutShape(): Extract<OverlayShape, { type: "callout" }> {
  return {
    id: "shape_callout",
    type: "callout",
    x: 0,
    y: 0,
    props: {
      w: 160,
      h: 40,
      radius: 8,
      tail: { baseStart: { x: 0, y: 40 }, baseEnd: { x: 20, y: 40 }, tip: { x: 10, y: 60 } },
      color: "#111827",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
      blocks: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "説明" }] }],
    },
  };
}

/**
 * Both surfaces that draw a shape's text — the Tiptap editor while it is focused, and the static
 * view the rest of the time — turn a measured content height into a box height here. One function
 * is the point: if the two disagreed, the box would jump at the moment focus moved.
 */
describe("the box height a measured content height means", () => {
  it("is the content height for a text shape", () => {
    expect(overlayTextBoxHeightForContent(textShape(), 64)).toBe(64);
  });

  /**
   * A callout's text is drawn inside the rect its geometry already inset by the padding, so the
   * padding has to go back on before the number can be compared with the stored box height.
   */
  it("adds the padding back for a callout", () => {
    expect(overlayTextBoxHeightForContent(calloutShape(), 64)).toBe(64 + CALLOUT_TEXT_PADDING * 2);
  });

  it("never goes below one line box", () => {
    // A 24pt font renders a 32px line, so a content height of 0 still reserves one line.
    expect(overlayTextBoxHeightForContent(textShape(24), 0)).toBe(32);
    expect(overlayTextBoxHeightForContent(textShape(24), 100)).toBe(100);
  });
});
