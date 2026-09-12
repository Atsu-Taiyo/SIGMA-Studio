// @vitest-environment happy-dom

import { Editor, Extension } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { DocumentHistoryController, type OverlayShape, type ParagraphNode } from "@/features/document";
import type { TextFlowBlock } from "@/features/text-editing";
import {
  createTextAndShapesClipboardPayload,
  createTextFlowClipboardPayload,
  EDITOR_CLIPBOARD_MIME,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";

import { markBodyCutHistoryGroup, MIXED_CLIPBOARD_HISTORY_GROUP_META, peekBodyCutHistoryGroup } from "./clipboard-history-group";
import { pasteAcrossTextFlowSelection, pasteTextFlowBlocksFromClipboard, TextFlowClipboardSession, writeTextFlowSelectionClipboard } from "./clipboard-transactions";
import { OVERLAY_SHAPES_PASTE_REQUEST_EVENT, type OverlayShapesPasteRequestDetail } from "./text-and-shapes-clipboard";
import { textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";

const cleanups: Array<() => void> = [];

function paragraph(id: string, text: string, breakBefore = false): ParagraphNode {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
    ...(breakBefore ? { pagination: { break: true } } : {}),
  };
}

function createEditor(rejectChanges = false): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
      ...(rejectChanges ? [Extension.create({
        name: "rejectDocumentChanges",
        addProseMirrorPlugins: () => [new Plugin({ filterTransaction: (transaction) => !transaction.docChanged })],
      })] : []),
    ],
    content: textFlowToTiptap([paragraph("before", "AB"), paragraph("after", "YZ", true)]),
  });
  cleanups.push(() => editor.destroy());
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 6)));
  return editor;
}

function clipboardEvent(dataTransfer = new DataTransfer()): ClipboardEvent {
  return new ClipboardEvent("paste", { clipboardData: dataTransfer, cancelable: true });
}

function mixedPaste(editor: Editor): { event: ClipboardEvent; slice: Slice } {
  const sourceDoc = editor.state.schema.nodeFromJSON(textFlowToTiptap([paragraph("source", "X")]));
  const slice = sourceDoc.slice(0, sourceDoc.content.size);
  const shape: OverlayShape = {
    id: "shape_source", type: "text", x: 10, y: 20, rotation: 0,
    props: { w: 200, h: 48, color: "#111827", size: "m", blocks: [paragraph("shape_p", "label")] },
  };
  const clipboardData = new DataTransfer();
  writeEditorClipboardData(clipboardData, createTextAndShapesClipboardPayload(
    { slice: slice.toJSON(), text: "X" }, [shape], {}, "source-doc",
  ));
  return { event: clipboardEvent(clipboardData), slice };
}

function onOverlayPaste(callback: (detail: OverlayShapesPasteRequestDetail) => void): void {
  const listener = (event: Event) => callback((event as CustomEvent<OverlayShapesPasteRequestDetail>).detail);
  window.addEventListener(OVERLAY_SHAPES_PASTE_REQUEST_EVENT, listener);
  cleanups.push(() => window.removeEventListener(OVERLAY_SHAPES_PASTE_REQUEST_EVENT, listener));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  peekBodyCutHistoryGroup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("clipboard transaction acceptance", () => {
  it("commits body replacement before requesting shapes and keeps their delayed save in one undo entry", () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const { event, slice } = mixedPaste(editor);
    const before = tiptapToTextFlow(editor.getJSON());
    type Document = { blocks: TextFlowBlock[]; shapes: OverlayShape[] };
    let document: Document = { blocks: before, shapes: [] };
    const original = document;
    const history = new DocumentHistoryController<Document, null>(10);
    const session = new TextFlowClipboardSession();
    const order: string[] = [];
    let bodyHistoryGroup: string | null = null;
    editor.on("update", ({ transaction }) => {
      order.push("body");
      expect(event.defaultPrevented).toBe(true);
      bodyHistoryGroup = session.historyGroupFor(transaction, 1, null);
      expect(bodyHistoryGroup).toBeTruthy();
      history.record({ document, selection: null }, { coalescingKey: bodyHistoryGroup ?? undefined });
      document = { ...document, blocks: tiptapToTextFlow(editor.getJSON()) };
    });
    onOverlayPaste((detail) => {
      order.push("shapes requested");
      expect(document.blocks).toEqual([paragraph("before", "AX"), paragraph("after", "Z", true)]);
      expect(detail.anchorBlockIdMap).toEqual({ source: "before" });
      expect(detail.historyGroup).toBe(bodyHistoryGroup);
      expect(detail.source).toBe(editor.view.dom);
      window.setTimeout(() => {
        order.push("shapes saved");
        history.record({ document, selection: null }, { coalescingKey: detail.historyGroup });
        document = { ...document, shapes: detail.payload.shapes };
      }, 250);
    });

    expect(pasteAcrossTextFlowSelection(editor.view, event, slice, false)).toBe(true);
    expect(order).toEqual(["body", "shapes requested"]);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$head.parent.attrs.sigmaDocId).toBe("before");
    expect(editor.state.selection.$head.parentOffset).toBe(2);
    vi.advanceTimersByTime(249);
    expect(document.shapes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(order).toEqual(["body", "shapes requested", "shapes saved"]);
    expect(document.shapes).toHaveLength(1);
    expect(history.undoDepth).toBe(1);
    expect(history.undo({ document, selection: null })?.document).toBe(original);
    expect(history.undoDepth).toBe(0);
  });

  it("consumes an edit-guard rejection without changing selection or requesting any shapes", () => {
    const editor = createEditor(true);
    const { event, slice } = mixedPaste(editor);
    const original = editor.state;
    const requested = vi.fn();
    onOverlayPaste(requested);
    const dispatch = vi.spyOn(editor.view, "dispatch");

    expect(pasteAcrossTextFlowSelection(editor.view, event, slice, false)).toBe(true);

    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(editor.state.doc).toBe(original.doc);
    expect(editor.state.selection.eq(original.selection)).toBe(true);
    expect(requested).not.toHaveBeenCalled();
  });

  it.each(["malformed custom payload", "file only"])("rejects %s before dispatch instead of deleting the selected break", (kind) => {
    const editor = createEditor();
    const dataTransfer = new DataTransfer();
    if (kind === "malformed custom payload") {
      dataTransfer.setData(EDITOR_CLIPBOARD_MIME, "{invalid");
      dataTransfer.setData("text/plain", "must not fall through");
    } else {
      dataTransfer.items.add(new File(["image"], "image.png", { type: "image/png" }));
    }
    const event = clipboardEvent(dataTransfer);
    const original = editor.state;
    const requested = vi.fn();
    onOverlayPaste(requested);
    const dispatch = vi.spyOn(editor.view, "dispatch");

    expect(pasteAcrossTextFlowSelection(editor.view, event, Slice.empty, false)).toBe(true);

    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.state).toBe(original);
    expect(requested).not.toHaveBeenCalled();
  });

  it("consumes a regular block-paste dispatch failure without refreshing the controller selection", () => {
    const editor = createEditor();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
    const dataTransfer = new DataTransfer();
    writeEditorClipboardData(dataTransfer, createTextFlowClipboardPayload([paragraph("source", "X")]));
    const event = clipboardEvent(dataTransfer);
    const original = editor.state;
    vi.spyOn(editor.view, "dispatch").mockImplementation(() => { throw new Error("dispatch rejected"); });
    const onSelect = vi.fn();
    const refreshSelection = vi.fn();

    expect(pasteTextFlowBlocksFromClipboard(editor.view, event, Slice.empty, onSelect, refreshSelection)).toBe(true);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state).toBe(original);
    expect(onSelect).not.toHaveBeenCalled();
    expect(refreshSelection).not.toHaveBeenCalled();
  });

  it("keeps selection unchanged when a regular paste is rejected by an edit guard", () => {
    const editor = createEditor(true);
    editor.commands.setTextSelection(2);
    const dataTransfer = new DataTransfer();
    writeEditorClipboardData(dataTransfer, createTextFlowClipboardPayload([paragraph("source", "X")]));
    const original = editor.state;
    const onSelect = vi.fn();
    const refreshSelection = vi.fn();
    expect(pasteTextFlowBlocksFromClipboard(editor.view, clipboardEvent(dataTransfer), Slice.empty, onSelect, refreshSelection)).toBe(true);
    expect(editor.state).toBe(original);
    expect(onSelect).not.toHaveBeenCalled();
    expect(refreshSelection).not.toHaveBeenCalled();
  });
});

describe("pasting a copied text range", () => {
  it("replaces an empty destination with pasted blocks and preserves the following empty paragraph", () => {
    const editor = createEditor();
    const following = [{ ...paragraph("blank", ""), children: [] }, paragraph("following", "続き")];
    editor.commands.setContent(textFlowToTiptap([{ ...paragraph("target", ""), children: [] }, ...following]));
    editor.commands.setTextSelection(1);
    editor.setOptions({ editorProps: {
      handlePaste: (view, event, slice) => pasteTextFlowBlocksFromClipboard(view, event, slice, () => {}, () => {}),
    } });
    const clipboardData = new DataTransfer();
    const text = "# 見出し\n\n本文";
    clipboardData.setData("text/plain", text);
    editor.view.pasteText(text, clipboardEvent(clipboardData));

    const blocks = tiptapToTextFlow(editor.getJSON());
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "paragraph", "paragraph"]);
    expect(blocks[1]).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "本文" }] });
    expect(blocks.slice(2)).toEqual(following);
  });

  it.each([
    { text: "# 見出し", type: "heading" },
    { text: "- 箇条書き", type: "list" },
  ])("keeps explicit Markdown $type structure when replacing selected text", ({ text, type }) => {
    const editor = createEditor();
    editor.commands.setContent(textFlowToTiptap([paragraph("target", "ABCD")]));
    editor.commands.setTextSelection({ from: 2, to: 3 });
    editor.setOptions({ editorProps: {
      handlePaste: (view, event, slice) => pasteTextFlowBlocksFromClipboard(view, event, slice, () => {}, () => {}),
    } });
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    editor.view.pasteText(text, clipboardEvent(clipboardData));

    const blocks = tiptapToTextFlow(editor.getJSON());
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", type, "paragraph"]);
    expect(blocks[0]).toEqual(paragraph("target", "A"));
    expect(blocks[2]).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "CD" }] });
  });

  it.each([
    { from: 2, to: 3, expected: "AXCD", offset: 2 },
    { from: 1, to: 3, expected: "XCD", offset: 1 },
    { from: 3, to: 5, expected: "ABX", offset: 3 },
    { from: 1, to: 5, expected: "X", offset: 1 },
    { from: 3, to: 3, expected: "ABXCD", offset: 3 },
  ])("replaces from $from to $to within the paragraph without adding breaks", ({ from, to, expected, offset }) => {
    const editor = createEditor();
    const source = [paragraph("source", "XYZ")];
    editor.commands.setContent(textFlowToTiptap(source));
    editor.commands.setTextSelection({ from: 1, to: 2 });
    const clipboardData = new DataTransfer();
    expect(writeTextFlowSelectionClipboard(editor.view, clipboardData, source)).toBe(true);

    const before = [paragraph("target", "ABCD"), { ...paragraph("blank", ""), children: [] }, paragraph("following", "続き", true)];
    editor.commands.setContent(textFlowToTiptap(before));
    editor.commands.setTextSelection({ from, to });
    editor.setOptions({ editorProps: {
      handlePaste: (view, event, slice) => pasteTextFlowBlocksFromClipboard(view, event, slice, () => {}, () => {}),
    } });
    editor.view.pasteHTML(clipboardData.getData("text/html"), clipboardEvent(clipboardData));

    const saved = tiptapToTextFlow(editor.getJSON());
    expect(saved).toEqual([paragraph("target", expected), before[1], before[2]]);
    expect(editor.state.selection.$head.parentOffset).toBe(offset);
    editor.commands.insertContent("!");
    expect(tiptapToTextFlow(editor.getJSON())[0]).toEqual(paragraph("target", `${expected.slice(0, offset)}!${expected.slice(offset)}`));
    editor.commands.setContent(textFlowToTiptap(saved));
    expect(tiptapToTextFlow(editor.getJSON())).toEqual(saved);
  });
});

describe("TextFlowClipboardSession", () => {
  it.each([{ elapsed: 1500, requested: true }, { elapsed: 1501, requested: false }])("expires the literal shortcut after $elapsed ms", ({ elapsed, requested }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const session = new TextFlowClipboardSession();
    session.requestLiteralPaste();
    now.mockReturnValue(10_000 + elapsed);
    expect(session.beginPaste()).toEqual({ literalPasteRequested: requested });
    expect(session.beginPaste()).toEqual({ literalPasteRequested: false });
  });

  it("allows native literal-paste parsing on reentry and releases the guard after a thrown paste", () => {
    const editor = createEditor();
    const session = new TextFlowClipboardSession();
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "# literal");
    const event = clipboardEvent(dataTransfer);
    vi.spyOn(editor.view, "pasteText").mockImplementation((text) => {
      expect(text).toBe("# literal");
      expect(session.beginPaste()).toBeNull();
      throw new Error("native paste failed");
    });

    expect(() => session.pasteLiteral(editor.view, event)).toThrow("native paste failed");
    expect(event.defaultPrevented).toBe(true);
    expect(session.beginPaste()).toEqual({ literalPasteRequested: false });
  });

  it("shares minted history only through its transaction sequence and clears it on document reset", () => {
    const editor = createEditor();
    const session = new TextFlowClipboardSession();
    const paste = editor.state.tr.setMeta(MIXED_CLIPBOARD_HISTORY_GROUP_META, "paste-group");
    expect(session.historyGroupFor(paste, 5, null)).toBe("paste-group");
    expect(session.historyGroupFor(editor.state.tr, 5, null)).toBe("paste-group");
    expect(session.historyGroupFor(editor.state.tr, 6, null)).toBeNull();
    expect(session.historyGroupFor(paste, 5, null)).toBe("paste-group");
    session.resetHistory();
    expect(session.historyGroupFor(editor.state.tr, 5, null)).toBeNull();
  });

  it("gives cross-editor history precedence without consuming a pending native cut key", () => {
    const editor = createEditor();
    const session = new TextFlowClipboardSession();
    markBodyCutHistoryGroup("cut-group");
    const cut = editor.state.tr
      .setMeta("uiEvent", "cut")
      .setMeta(MIXED_CLIPBOARD_HISTORY_GROUP_META, "ignored-paste-group");
    expect(session.historyGroupFor(cut, 1, "span-group")).toBe("span-group");
    expect(session.historyGroupFor(cut, 2, null)).toBe("cut-group");
    expect(peekBodyCutHistoryGroup()).toBeNull();
  });
});
