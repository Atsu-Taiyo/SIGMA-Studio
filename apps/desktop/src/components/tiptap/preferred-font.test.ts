// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BODY_FONT_FAMILY, DEFAULT_SERIF_BODY_FONT_FAMILY } from "@/features/document";
import { tiptapDocToOverlayTextBlocks } from "@/components/editor/text-flow/overlay-tiptap-adapter";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { applyPreferredFontToEmptyParagraph } from "./preferred-font";
import { BoxBlockExtension, BoxBlockBodyExtension, BoxBlockTitleExtension } from "./sigma-doc-container-extensions";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));
function createEditor(content = [{ type: "paragraph" }] as object[]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({ blockExtensions: [BoxBlockExtension, BoxBlockBodyExtension, BoxBlockTitleExtension] }),
    content: { type: "doc", content },
  });
  editors.push(editor);
  return editor;
}

describe("last chosen font for empty input", () => {
  it("arms the caret without editing the document, preserves other marks, and saves the font on typed text", () => {
    const editor = createEditor();
    editor.commands.toggleBold();
    const before = editor.getJSON();
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.isActive("bold")).toBe(true);
    editor.commands.insertContent("本文");
    const blocks = tiptapDocToOverlayTextBlocks(editor.getJSON(), []);
    expect(blocks[0]).toMatchObject({ children: [{ text: "本文", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY, marks: ["bold"] }] });
    const restored = createEditor(editor.getJSON().content);
    expect(restored.getAttributes("styledText").fontFamily).toBe(DEFAULT_SERIF_BODY_FONT_FAMILY);
  });

  it("leaves populated paragraphs and selections unchanged", () => {
    const editor = createEditor([{ type: "paragraph", content: [{ type: "text", text: "以前の本文" }] }]);
    editor.commands.setTextSelection({ from: 1, to: 3 });
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(editor.getAttributes("styledText").fontFamily).toBeUndefined();
    editor.commands.setTextSelection(3);
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(editor.getAttributes("styledText").fontFamily).toBeUndefined();
  });

  it("keeps an explicitly inherited font on an empty paragraph", () => {
    const editor = createEditor();
    editor.commands.setFontFamily("monospace");
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(editor.getAttributes("styledText").fontFamily).toBe("monospace");
  });

  it("respects a box's body font", () => {
    const editor = createEditor([{ type: "boxBlock", attrs: { styleId: "plain", frame: { bodyFontFamily: "monospace" } }, content: [
      { type: "boxBlockTitle" }, { type: "boxBlockBody", content: [{ type: "paragraph" }] },
    ] }]);
    let paragraphPosition = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph") paragraphPosition = pos + 1; });
    editor.commands.setTextSelection(paragraphPosition);
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(editor.getAttributes("styledText").fontFamily).toBeUndefined();
  });

  it("allows returning to the standard font and ignores read-only editors", () => {
    const editor = createEditor();
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_BODY_FONT_FAMILY);
    expect(editor.state.storedMarks).toBeNull();
    editor.setEditable(false);
    applyPreferredFontToEmptyParagraph(editor, DEFAULT_SERIF_BODY_FONT_FAMILY);
    expect(editor.state.storedMarks).toBeNull();
  });
});
