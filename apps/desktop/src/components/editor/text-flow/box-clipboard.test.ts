// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { BoxBlockBodyExtension, BoxBlockExtension, BoxBlockTitleExtension } from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import type { TextFlowBlock } from "@/features/text-editing";
import { readEditorClipboardPayload, readTextSliceClipboardData } from "@/lib/editor-clipboard";

import { pasteTextFlowBlocksFromClipboard, writeTextFlowSelectionClipboard } from "./clipboard-transactions";
import { textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

function editorFor(blocks: TextFlowBlock[]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [SigmaDocTextAttrs, BoxBlockExtension, BoxBlockTitleExtension, BoxBlockBodyExtension],
    }),
    content: textFlowToTiptap(blocks),
  });
  editors.push(editor);
  return editor;
}

const paragraph = (id: string, text: string): TextFlowBlock => ({ type: "paragraph", id, children: [{ type: "text", text }] });
const box = (id: string, blocks: TextFlowBlock[]): TextFlowBlock => ({ type: "boxBlock", id, styleId: "itembox", title: [{ type: "text", text: "題名" }], blocks });

function position(editor: Editor, id: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => { if (node.attrs.sigmaDocId === id) found = pos; });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

function copy(editor: Editor, blocks: TextFlowBlock[]) {
  const data = new DataTransfer();
  expect(writeTextFlowSelectionClipboard(editor.view, data, blocks)).toBe(true);
  const payload = readEditorClipboardPayload(data);
  expect(payload?.kind).toBe("textFlowBlocks");
  if (payload?.kind !== "textFlowBlocks") throw new Error("Expected text payload");
  return { data, blocks: payload.blocks };
}

describe("copying contents inside a box", () => {
  it("copies a partial paragraph without its enclosing box in every clipboard format", () => {
    const source = [box("outer", [paragraph("inside", "ABCD")])];
    const editor = editorFor(source);
    const pos = position(editor, "inside");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 2, pos + 4)));
    const copied = copy(editor, source);
    expect(copied.blocks).toEqual([paragraph("inside", "BC")]);
    expect(copied.data.getData("text/plain")).toBe("BC");
    expect(copied.data.getData("text/html")).not.toContain("sigma-doc-box-block");
    expect(readTextSliceClipboardData(copied.data)?.slice).toMatchObject({ openStart: 1, openEnd: 1, content: [{ type: "paragraph" }] });

    editor.commands.setContent(textFlowToTiptap([paragraph("target", "XY")]));
    editor.commands.setTextSelection(2);
    editor.setOptions({ editorProps: { handlePaste: (view, event, slice) => pasteTextFlowBlocksFromClipboard(view, event, slice) } });
    editor.view.pasteHTML(copied.data.getData("text/html"), new ClipboardEvent("paste", { clipboardData: copied.data, cancelable: true }));
    expect(tiptapToTextFlow(editor.getJSON())).toEqual([paragraph("target", "XBCY")]);
  });

  it("copies multiple body paragraphs without manufacturing a box or including its title", () => {
    const source = [box("outer", [paragraph("one", "first"), paragraph("two", "second")])];
    const editor = editorFor(source);
    const from = position(editor, "one") + 1;
    const to = position(editor, "two") + 1 + "second".length;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
    const copied = copy(editor, source);
    expect(copied.blocks).toEqual([paragraph("one", "first"), paragraph("two", "second")]);
    expect(copied.data.getData("text/plain")).not.toContain("題名");
  });

  it("preserves an explicitly selected whole box including a nested box", () => {
    const source = [box("outer", [paragraph("one", "first"), box("inner", [paragraph("two", "second")])])];
    const editor = editorFor(source);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position(editor, "outer"))));
    expect(copy(editor, source).blocks).toEqual(source);
  });

  it("preserves a whole nested box selected as a node inside its enclosing body", () => {
    const inner = box("inner", [paragraph("two", "second")]);
    const source = [box("outer", [paragraph("one", "first"), inner])];
    const editor = editorFor(source);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position(editor, "inner"))));
    expect(copy(editor, source).blocks).toEqual([inner]);
  });

  it("retains rich text, a boxed formula and an explicitly nested box in selected body contents", () => {
    const rich: TextFlowBlock = { type: "paragraph", id: "rich", children: [
      { type: "text", text: "AB", marks: ["bold"], fontSize: 18 },
      { type: "mathInline", id: "math", tex: String.raw`\frac{x}{y}`, display: "inline", semanticRole: "expression", marks: ["boxed"] },
    ] };
    const inner = box("inner", [paragraph("nested", "nested")]);
    const tail = paragraph("tail", "last");
    const source = [box("outer", [rich, inner, tail])];
    const editor = editorFor(source);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,
      position(editor, "rich") + 1, position(editor, "tail") + 1 + 4)));
    expect(copy(editor, source).blocks).toEqual([rich, inner, tail]);
  });

  it("leaves a selection spanning the box title and body structural", () => {
    const source = [box("outer", [paragraph("inside", "ABCD")])];
    const editor = editorFor(source);
    let titlePos = -1;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "boxBlockTitle") titlePos = pos + 1; });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,
      titlePos, position(editor, "inside") + 5)));
    expect(copy(editor, source).blocks).toEqual(source);
  });
});
