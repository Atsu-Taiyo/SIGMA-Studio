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

  it("reads selected shape headings and mixed runs while ignoring KaTeX glyph scaling", () => {
    const root = document.createElement("div");
    root.style.fontSize = "16px";
    root.innerHTML = '<h2 style="font-size:24px">見出し</h2><p>本文</p>';
    document.body.append(root);
    expect(readRenderedTextFontSize(root)).toEqual({ fontSize: 18, fontSizeMixed: true });
    root.innerHTML = '<p>本文<span><span class="katex" style="font-size:19px"><span style="font-size:8px">x</span></span></span></p>';
    expect(readRenderedTextFontSize(root)).toEqual({ fontSize: 12, fontSizeMixed: false });
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
