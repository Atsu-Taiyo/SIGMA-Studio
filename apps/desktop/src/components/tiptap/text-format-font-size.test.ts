// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { readRenderedTextFontSize, readSelectionFontSize } from "./text-format-font-size";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
});

function createEditor(content: object[]) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createRichTextEngineExtensions({}),
    content: { type: "doc", content },
  });
  editor.view.dom.style.fontSize = "16px";
  editors.push(editor);
  return editor;
}

describe("effective font size", () => {
  it("reads inherited px in pt without adding marks, including an empty paragraph", () => {
    const editor = createEditor([{ type: "paragraph", content: [{ type: "text", text: "本文" }] }, { type: "paragraph" }]);
    const before = editor.getJSON();
    editor.commands.setTextSelection(2);
    expect(readSelectionFontSize(editor.view)).toEqual({ fontSize: 12, fontSizeMixed: false });
    editor.commands.setTextSelection(5);
    expect(readSelectionFontSize(editor.view)).toEqual({ fontSize: 12, fontSizeMixed: false });
    expect(editor.getJSON()).toEqual(before);
  });

  it("compares effective values and retains the first size when a selection is mixed", () => {
    const editor = createEditor([{ type: "paragraph", content: [
      { type: "text", text: "無指定" },
      { type: "text", text: "同じ", marks: [{ type: "styledText", attrs: { fontSize: 12 } }] },
      { type: "text", text: "注記", marks: [{ type: "styledText", attrs: { fontSize: 7.5 } }] },
    ] }]);
    expect(readSelectionFontSize(editor.view, { from: 1, to: 6 })).toEqual({ fontSize: 12, fontSizeMixed: false });
    expect(readSelectionFontSize(editor.view, { from: 1, to: 8 })).toEqual({ fontSize: 12, fontSizeMixed: true });
  });

  it.each(["text", "mathInline"])("ignores empty paragraphs around selected 13pt %s", (type) => {
    const editor = createEditor([
      { type: "paragraph" },
      { type: "paragraph", content: [{
        type,
        ...(type === "text" ? { text: "本文" } : { attrs: { id: "m1", tex: "x" } }),
        marks: [{ type: "styledText", attrs: { fontSize: 13 } }],
      }] },
      { type: "paragraph" },
    ]);
    const before = editor.getJSON();
    expect(readSelectionFontSize(editor.view, { from: 0, to: editor.state.doc.content.size }))
      .toEqual({ fontSize: 13, fontSizeMixed: false });
    expect(editor.getJSON()).toEqual(before);
  });

  it("reads an empty-paragraph-only range even when unselected text has a different size", () => {
    const editor = createEditor([
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "本文", marks: [{ type: "styledText", attrs: { fontSize: 13 } }] }] },
    ]);
    (editor.view.nodeDOM(0) as HTMLElement).style.fontSize = "20px";
    expect(readSelectionFontSize(editor.view, { from: 0, to: 2 }))
      .toEqual({ fontSize: 15, fontSizeMixed: false });
  });

  it("keeps 13pt and 12pt text mixed while ignoring a preceding empty paragraph", () => {
    const editor = createEditor([
      { type: "paragraph" },
      { type: "paragraph", content: [
        { type: "text", text: "大", marks: [{ type: "styledText", attrs: { fontSize: 13 } }] },
        { type: "text", text: "小", marks: [{ type: "styledText", attrs: { fontSize: 12 } }] },
      ] },
    ]);
    expect(readSelectionFontSize(editor.view, { from: 0, to: editor.state.doc.content.size }))
      .toEqual({ fontSize: 13, fontSizeMixed: true });
  });

  it("reads selected shape headings and mixed runs", () => {
    const root = document.createElement("div");
    root.style.fontSize = "16px";
    root.innerHTML = '<h2 style="font-size:24px">見出し</h2><p>本文</p>';
    document.body.append(root);
    expect(readRenderedTextFontSize(root)).toEqual({ fontSize: 18, fontSizeMixed: true });
  });

  it.each(["ML__latex", "katex"])("reads the semantic math frame regardless of %s glyph scaling", (className) => {
    const root = document.createElement("div");
    root.style.fontSize = "16px";
    root.innerHTML = `<p><span data-sigma-doc-math-inline><span class="${className}" style="font-size:19px"><span style="font-size:8px">x</span><span style="font-size:6px">2</span></span></span>本文</p>`;
    document.body.append(root);
    expect(readRenderedTextFontSize(root)).toEqual({ fontSize: 12, fontSizeMixed: false });
    (root.querySelector("[data-sigma-doc-math-inline]") as HTMLElement).style.fontSize = "20px";
    expect(readRenderedTextFontSize(root)).toEqual({ fontSize: 15, fontSizeMixed: true });
  });

  it("uses stored marks for the next keystroke, without changing existing runs", () => {
    const editor = createEditor([{ type: "paragraph", content: [{ type: "text", text: "本文" }] }]);
    editor.commands.setTextSelection(2);
    const before = editor.getJSON();
    editor.commands.setFontSize(10.5);
    expect(readSelectionFontSize(editor.view)).toEqual({ fontSize: 10.5, fontSizeMixed: false });
    expect(editor.getJSON()).toEqual(before);
  });
});

it("reads a boundary-only range like a caret at its start without writing sizes", () => {
  const editor = createEditor([
    { type: "paragraph", content: [{ type: "text", text: "A", marks: [{ type: "styledText", attrs: { fontSize: 9 } }] }] },
    { type: "paragraph", content: [{ type: "text", text: "B" }] },
  ]);
  const before = editor.getJSON();
  expect(readSelectionFontSize(editor.view, { from: 2, to: 4 })).toEqual({ fontSize: 9, fontSizeMixed: false });
  expect(readSelectionFontSize(editor.view, { from: 3, to: 4 }).fontSize).toBe(12);
  expect(editor.getJSON()).toEqual(before);
});
