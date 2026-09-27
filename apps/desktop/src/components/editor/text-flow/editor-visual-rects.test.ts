import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import { getEditorSideAtClientPoint } from "../expanded-text-selection";
import { getEditorVisualRectAtPoint } from "./editor-visual-rects";

const rect = (left: number, top = 100) => ({
  left, right: left + 100, top, bottom: top + 40, width: 100, height: 40,
}) as DOMRect;
const columns = [rect(0), rect(120), rect(240)];
const view = {
  dom: { children: columns.map((bounds) => ({ getBoundingClientRect: () => bounds })) },
} as unknown as EditorView;

describe("visual selection in page columns", () => {
  it.each([0, 1, 2])("recognizes text in column %i rather than a preceding column's gutter", (index) => {
    const x = columns[index].left + 30;
    expect(getEditorVisualRectAtPoint(view, x, 120)).toBe(columns[index]);
    expect(getEditorSideAtClientPoint({ view } as Editor, { x, y: 120 })).toBeNull();
  });

  it("uses the nearest column for left and right gutter drags", () => {
    expect(getEditorVisualRectAtPoint(view, 115, 120)).toBe(columns[1]);
    expect(getEditorSideAtClientPoint({ view } as Editor, { x: 115, y: 120 })).toBe("left");
    expect(getEditorVisualRectAtPoint(view, 345, 120)).toBe(columns[2]);
    expect(getEditorSideAtClientPoint({ view } as Editor, { x: 345, y: 120 })).toBe("right");
  });

  it("does not treat vertical whitespace as a text gutter", () => {
    expect(getEditorVisualRectAtPoint(view, 150, 160)).toBeNull();
  });
});
