// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverlayShape } from "@/features/document";

vi.mock("mathlive", () => ({}));

let OverlayTextShapeEditor: typeof import("./text-shape-editor").OverlayTextShapeEditor;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  document.open();
  document.write("<!doctype html><html><head></head><body></body></html>");
  document.close();
  OverlayTextShapeEditor = (await import("./text-shape-editor")).OverlayTextShapeEditor;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/**
 * Typing `- ` in a shape has always produced a list — the editing schema never disabled them —
 * but the converter threw on the way back, from inside `onUpdate`, where nothing catches it. The
 * shape now saves and draws lists, so the editing surface has to be able to hold one.
 */
describe("OverlayTextShapeEditor list editing", () => {
  it("opens a shape whose content is a list, as a real list", async () => {
    const shape: Extract<OverlayShape, { type: "text" }> = {
      id: "text_list",
      type: "text",
      x: 0,
      y: 0,
      props: {
        w: 200,
        h: 32,
        color: "#111827",
        size: "m",
        blocks: [{
          type: "list",
          id: "list_1",
          listType: "bullet",
          items: [
            { type: "listItem", id: "li_1", children: [{ type: "text", text: "ひとつ" }] },
            { type: "listItem", id: "li_2", children: [{ type: "text", text: "ふたつ" }] },
          ],
        }],
      },
    };
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <OverlayTextShapeEditor
          shape={shape}
          externalRevision={0}
          editing={false}
          onFocus={vi.fn()}
          onCancel={vi.fn()}
          onMeasuredHeight={vi.fn()}
          onChange={onChange}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const items = container.querySelectorAll("ul li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("ひとつ");
    // Opening a document must not rewrite it: a spurious `onChange` here would commit a
    // converted-and-back version of the author's content on mount.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the ordered-list marker style the shape saved", async () => {
    const shape: Extract<OverlayShape, { type: "text" }> = {
      id: "text_ordered",
      type: "text",
      x: 0,
      y: 0,
      props: {
        w: 200,
        h: 32,
        color: "#111827",
        size: "m",
        blocks: [{
          type: "list",
          id: "list_1",
          listType: "ordered",
          markerStyle: "paren",
          items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "いち" }] }],
        }],
      },
    };

    await act(async () => {
      root.render(
        <OverlayTextShapeEditor
          shape={shape}
          externalRevision={0}
          editing={false}
          onFocus={vi.fn()}
          onCancel={vi.fn()}
          onMeasuredHeight={vi.fn()}
          onChange={vi.fn()}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    // The attribute the stylesheet swaps the counter style on — the same one the static renderer
    // writes, so the marker does not change shape when the shape is focused.
    expect(container.querySelector("ol")?.getAttribute("data-list-marker")).toBe("paren");
  });
});

describe("OverlayTextShapeEditor body blocks", () => {
  /**
   * The three blocks a shape gained are typed with the body's input rules: `> ` for a quote, a
   * fence for code, `---` for a rule. (The `/` menu is the body editor's own component, not one of
   * these extensions, so it does not follow them into a shape.) What the editor has to prove here
   * is that it *mounts* them — the extensions owning those rules sit behind the same option that
   * decides whether the converter can save the result, so a shape that draws a block it cannot
   * save, or refuses to draw one it can, is the failure this pins against.
   */
  it("opens a shape whose content is a quote, a code block and a rule", async () => {
    const shape: Extract<OverlayShape, { type: "text" }> = {
      id: "text_body_blocks",
      type: "text",
      x: 0,
      y: 0,
      props: {
        w: 240,
        h: 96,
        color: "#111827",
        size: "m",
        blocks: [
          {
            type: "quote",
            id: "quote_1",
            blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
          },
          {
            type: "codeBlock",
            id: "code_1",
            language: "typescript",
            children: [{ type: "text", text: "const a = 1;" }],
          },
          { type: "divider", id: "divider_1" },
        ],
      },
    };
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <OverlayTextShapeEditor
          shape={shape}
          externalRevision={0}
          editing={false}
          onFocus={vi.fn()}
          onCancel={vi.fn()}
          onMeasuredHeight={vi.fn()}
          onChange={onChange}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector("blockquote")?.textContent).toContain("引用");
    expect(container.querySelector("pre")?.textContent).toContain("const a = 1;");
    expect(container.querySelectorAll("hr")).toHaveLength(1);
    // Opening a document must not rewrite it: a spurious `onChange` here would commit a
    // converted-and-back version of the author's content on mount.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("OverlayTextShapeEditor height measurement", () => {
  it("ignores rotated descendant AABBs and saves the local layout height", async () => {
    const localWidth = 200;
    const localHeight = 24;
    const rotatedAabbSize = (localWidth + localHeight) / Math.sqrt(2);
    const rect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: rotatedAabbSize,
      bottom: rotatedAabbSize,
      width: rotatedAabbSize,
      height: rotatedAabbSize,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.closest(".ProseMirror") ? rect : DOMRect.fromRect();
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ProseMirror") ? localWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ProseMirror") ? localHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ProseMirror") ? localWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ProseMirror") ? localHeight : 0;
    });

    const shape: Extract<OverlayShape, { type: "text" }> = {
      id: "text_rotated",
      type: "text",
      x: 10,
      y: 20,
      rotation: Math.PI / 4,
      props: {
        w: localWidth,
        h: localHeight,
        color: "#111827",
        size: "m",
        fontSize: 18,
        blocks: [{ type: "paragraph", id: "text_shape_editor_test_23", children: [{ type: "text", text: "single line" }] }],
      },
    };
    const onMeasuredHeight = vi.fn();

    await act(async () => {
      root.render(
        <OverlayTextShapeEditor
          shape={shape}
          externalRevision={0}
          editing={false}
          onFocus={vi.fn()}
          onCancel={vi.fn()}
          onMeasuredHeight={onMeasuredHeight}
          onChange={vi.fn()}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector(".ProseMirror")).not.toBeNull();
    expect(onMeasuredHeight).toHaveBeenCalled();
    expect(onMeasuredHeight.mock.calls.at(-1)).toEqual([shape.id, localHeight]);
    expect(onMeasuredHeight.mock.calls.at(-1)?.[1]).not.toBe(Math.ceil(rotatedAabbSize));
  });
});
