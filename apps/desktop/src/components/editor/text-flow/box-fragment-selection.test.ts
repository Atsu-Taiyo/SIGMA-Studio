// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { applyTextFormatCommand } from "@/components/tiptap/text-format-controller";
import { applyEditorDocumentProjection } from "@/components/tiptap/document-projection";
import { textCaretAddress } from "@/features/text-editing";
import { hasHeldCanvasTextSelection } from "../page-canvas/held-text-selection";
import { registerCaretSurface, updateCaretSurfaceFacets } from "./caret-router";
import {
  clearBoxFragmentSelection, getBoxFragmentSelectionRanges,
  validateBoxFragmentSelectionTransaction, refreshBoxFragmentSelectionSurfaces,
  startBoxFragmentPointerSelection,
} from "./box-fragment-selection";

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearBoxFragmentSelection();
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  vi.restoreAllMocks();
});

function surface(replica = false, canvas: HTMLElement = document.body, text = "abcdefgh") {
  const root = document.createElement("div");
  canvas.append(root);
  root.className = "editor-box-fragment-viewport";
  root.dataset.boxSourceId = "p";
  root.getBoundingClientRect = () => new DOMRect(0, replica ? 100 : 0, 100, 40);
  const editor = new Editor({
    element: root,
    extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
    content: { type: "doc", content: [{ type: "paragraph", attrs: { sigmaDocId: "p", sigmaDocType: "paragraph" }, content: [{ type: "text", text }] }] },
  });
  editor.view.dom.querySelector("p")!.dataset.boxFragmentSourceId = "p";
  vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({ pos: left, inside: 0 }));
  const unregister = registerCaretSurface({
    editor, surface: replica ? { kind: "fragmentReplica", blockId: "p", fragmentIndex: 1 } : { kind: "unit", unitId: "body" },
    order: [0, replica ? 1 : 0], boxIds: ["p"], ownsBlock: id => id === "p",
    addressAt: position => textCaretAddress("p", Math.max(0, Math.min(position - 1, editor.state.doc.firstChild!.content.size))),
    posFor: address => address.blockId === "p" ? 1 + Math.min(address.offset, editor.state.doc.firstChild!.content.size) : null,
    fragmentBlockIdFor: () => "p", localYFor: () => 0, caretLineAdvance: () => 20,
    focusCaretAtLocalY: () => false, focusCaretAtEdge: () => false, focusCaretAfterBlock: () => false,
    adjacentTextblockAddress: () => null, docEdgeAddress: () => null, ensureCaretVisible: () => {}, applyCaret: () => false, textRun: null,
  });
  editor.on("transaction", ({ transaction }) => validateBoxFragmentSelectionTransaction(editor, transaction));
  refreshBoxFragmentSelectionSurfaces();
  cleanups.push(() => { unregister(); editor.destroy(); root.remove(); });
  return { editor, root, unregister };
}

function drag(source: ReturnType<typeof surface>, backwards = false) {
  expect(startBoxFragmentPointerSelection({
    button: 0, defaultPrevented: false, target: source.editor.view.dom.querySelector("p")!,
    clientX: backwards ? 5 : 2, clientY: backwards ? 105 : 5, preventDefault: () => {},
  } as unknown as ReactMouseEvent<HTMLElement>, source.editor)).toBe(true);
  const end = { clientX: backwards ? 2 : 5, clientY: backwards ? 5 : 105 };
  window.dispatchEvent(new MouseEvent("mousemove", end));
  window.dispatchEvent(new MouseEvent("mouseup", end));
}

describe("fragment selection retention", () => {
  it("keeps a backward selection through a repeated no-op size command and another size", async () => {
    const source = surface();
    const replica = surface(true);
    drag(replica, true);
    expect(source.editor.state.selection.anchor).toBe(5);
    expect(source.editor.state.selection.head).toBe(2);
    source.editor.view.focus();
    for (const size of [18, 18, 20]) {
      applyTextFormatCommand(source.editor, { command: "fontSize", value: String(size) }, {
        selection: { from: 2, to: 5 }, blockNodeType: "paragraph", focusEditor: false,
      });
      await Promise.resolve();
      expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd", "bcd"]);
      expect(source.editor.state.doc.textBetween(2, 5)).toBe("bcd");
      expect(source.editor.getJSON().content![0].content).toMatchObject([
        { text: "a" }, { text: "bcd", marks: [{ type: "styledText", attrs: { fontSize: size } }] }, { text: "efgh" },
      ]);
    }
  });

  it.each([false, true])("clears a backward selection after a keyboard collapse (replica=%s)", async replicaFocused => {
    const source = surface();
    const replica = surface(true);
    drag(replica, true);
    const focused = replicaFocused ? replica : source;
    focused.editor.view.focus();
    focused.editor.commands.setTextSelection(2); // ArrowLeft collapses a backward range.
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
    refreshBoxFragmentSelectionSurfaces();
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
    expect(source.editor.state.selection.empty).toBe(true);
    expect(replica.editor.state.selection.empty).toBe(true);
  });

  it("keeps the logical range through repeated formatting, projection and replica replacement", async () => {
    const source = surface();
    const replica = surface(true);
    drag(source);
    expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd", "bcd"]);
    const focus = vi.spyOn(source.editor.view, "focus");
    for (const size of [13, 14, 15]) {
      applyTextFormatCommand(source.editor, { command: "fontSize", value: String(size) }, {
        selection: { from: source.editor.state.selection.from, to: source.editor.state.selection.to }, blockNodeType: "paragraph", focusEditor: false,
      });
      replica.editor.commands.setContent(source.editor.getJSON(), { emitUpdate: false });
      await Promise.resolve();
      expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd", "bcd"]);
      expect(source.editor.getJSON().content![0].content).toMatchObject([
        { text: "a" }, { text: "bcd", marks: [{ type: "styledText", attrs: { fontSize: size } }] }, { text: "efgh" },
      ]);
    }
    replica.unregister();
    surface(true);
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd", "bcd"]);
    expect(focus).not.toHaveBeenCalled();
    clearBoxFragmentSelection(); // History/document boundaries explicitly clear this state.
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
  });

  it("clears unsafe full replacements instead of clamping offsets onto different text", async () => {
    const source = surface();
    surface(true);
    drag(source);
    source.editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", attrs: { sigmaDocId: "p" }, content: [{ type: "text", text: "ab" }] }] }, { emitUpdate: false });
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
  });

  it.each([false, true])("clears insertion projections from source or replica (replica=%s)", async replicaChanged => {
    const source = surface();
    const replica = surface(true);
    drag(source);
    const changed = replicaChanged ? replica : source;
    const content = changed.editor.getJSON();
    content.content![0].content![0] = { type: "text", text: "XXabcdefgh", marks: [] };
    applyEditorDocumentProjection(changed.editor, content);
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
  });

  it.each([false, true])("keeps the original characters after whole/partial mark dispatch and projection (replica=%s)", async replicaChanged => {
    const source = surface();
    const replica = surface(true);
    drag(source);
    const changed = replicaChanged ? replica : source;
    for (const projection of [false, true]) {
      for (const partial of [false, true]) {
        const { editor } = changed;
        const from = partial ? 3 : 1;
        const to = partial ? 4 : 9;
        const mark = partial ? editor.schema.marks.styledText.create({ fontSize: 18 }) : editor.schema.marks.bold.create();
        const transaction = editor.state.tr.addMark(from, to, mark);
        if (projection) {
          editor.view.dispatch(editor.state.tr.removeMark(from, to, mark.type));
          applyEditorDocumentProjection(editor, transaction.doc.toJSON());
        } else editor.view.dispatch(transaction);
        await Promise.resolve();
        expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd", "bcd"]);
        expect(changed.editor.state.selection.from).toBe(2);
        expect(changed.editor.state.selection.to).toBe(5);
      }
    }
  });

  it.each([false, true])("compares content when replacing the only remaining surface (changed=%s)", async changed => {
    const source = surface();
    const replica = surface(true);
    drag(source);
    source.unregister(); replica.unregister();
    surface(false, document.body, changed ? "XXabcdefgh" : "abcdefgh");
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(changed ? [] : ["bcd"]);
  });

  it("rejects a remounted replica with changed content even if the source is unchanged", async () => {
    const source = surface();
    const replica = surface(true);
    drag(source);
    replica.unregister();
    surface(true, document.body, "XXabcdefgh");
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
  });

  it.each([false, true])("clears a focused keyboard collapse and replicas without reviving it (replica=%s)", async replicaFocused => {
    const canvas = document.createElement("div");
    document.body.append(canvas);
    cleanups.push(() => canvas.remove());
    const source = surface(false, canvas);
    const replica = surface(true, canvas);
    drag(source);
    const focused = replicaFocused ? replica : source;
    focused.editor.view.focus();
    focused.editor.commands.setTextSelection(5); // ArrowRight collapses the focused PM range.
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
    expect(source.editor.state.selection.empty).toBe(true);
    expect(replica.editor.state.selection.empty).toBe(true);
    const input = document.createElement("input");
    input.setAttribute("data-toolbar-popover", "");
    canvas.append(input);
    input.focus();
    expect(hasHeldCanvasTextSelection(canvas, input)).toBe(false);
    refreshBoxFragmentSelectionSurfaces();
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
    expect(source.editor.state.selection.empty).toBe(true);
    expect(replica.editor.state.selection.empty).toBe(true);
  });

  it("keeps internal synchronization and no-op formatting while the source is focused", async () => {
    const source = surface();
    surface(true);
    drag(source);
    source.editor.view.focus();
    refreshBoxFragmentSelectionSurfaces();
    await Promise.resolve();
    source.editor.commands.setTextSelection({ from: 2, to: 5 });
    expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd", "bcd"]);
  });

  it("keeps the range on the source after reflow removes the last continuation", async () => {
    const source = surface();
    const replica = surface(true);
    drag(source);
    replica.unregister();
    updateCaretSurfaceFacets(source.editor, { boxIds: [] });
    refreshBoxFragmentSelectionSurfaces();
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges().map(range => range.toString())).toEqual(["bcd"]);
    clearBoxFragmentSelection();
    expect(source.editor.view.dom.hasAttribute("data-box-fragment-span")).toBe(false);
  });

  it("clears on a document switch even when the next document reuses the block id", async () => {
    const previous = document.createElement("div");
    const next = document.createElement("div");
    previous.className = next.className = "page-canvas";
    document.body.append(previous, next);
    cleanups.push(() => { previous.remove(); next.remove(); });
    const source = surface(false, previous);
    const replica = surface(true, previous);
    drag(source);
    source.unregister(); replica.unregister();
    surface(false, next); surface(true, next);
    await Promise.resolve();
    expect(getBoxFragmentSelectionRanges()).toEqual([]);
  });

  it("holds actions for toolbar inputs and color dialogs only while a PM range exists", () => {
    const { editor, root } = surface();
    editor.commands.setTextSelection({ from: 2, to: 5 });
    const dialog = document.createElement("div");
    dialog.className = "color-picker-dialog";
    const input = document.createElement("input");
    dialog.append(input);
    expect(hasHeldCanvasTextSelection(root, input)).toBe(true);
    expect(hasHeldCanvasTextSelection(root, editor.view.dom)).toBe(false);
    expect(hasHeldCanvasTextSelection(document.createElement("div"), input)).toBe(false);
    editor.commands.setTextSelection(2);
    expect(hasHeldCanvasTextSelection(root, input)).toBe(false);
  });
});
