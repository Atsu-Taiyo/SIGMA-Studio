// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { BoxBlockExtension, BoxBlockBodyExtension, BoxBlockTitleExtension } from "./sigma-doc-container-extensions";
const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); });
function create(content: string) {
  const element = document.createElement("div"); document.body.append(element);
  const editor = new Editor({ element, extensions: createRichTextEngineExtensions(), content });
  editors.push(editor); return editor;
}
it("carries the typed size from a list to an empty body paragraph and through a list exit", () => {
  const editor = create("<ul><li><p>箇条書き</p></li></ul><p></p>");
  editor.commands.setTextSelection(3);
  editor.commands.setFontSize(24);
  editor.commands.insertContent("追記");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent("本文");
  expect(editor.getJSON().content?.at(-1)?.content?.[0]).toMatchObject({ text: "本文", marks: [{ type: "styledText", attrs: { fontSize: 24 } }] });
});
it("does not change existing text when moving the caret to a differently formatted paragraph", () => {
  const editor = create('<p><span style="font-size:24pt">大きい</span></p><p><span style="font-size:10pt">小さい</span></p>');
  editor.commands.setTextSelection(2); editor.commands.insertContent("A");
  const saved = editor.getJSON();
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  expect(editor.getJSON()).toEqual(saved);
  editor.commands.insertContent("B");
  expect(editor.getAttributes("styledText").fontSize).toBe(10);
});

it.each(["boxBlockTitle", "paragraph"])("keeps the frame font in an empty %s after typing elsewhere", nodeName => {
  const source = create("<p>先に選んだ書体</p>");
  source.commands.setFontFamily("serif");
  source.commands.insertContent("A");
  const editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: createRichTextEngineExtensions({ blockExtensions: [BoxBlockExtension, BoxBlockBodyExtension, BoxBlockTitleExtension] }),
    content: { type: "doc", content: [{ type: "boxBlock", attrs: { styleId: "plain", frame: { titleFontFamily: "monospace", bodyFontFamily: "monospace" } }, content: [
      { type: "boxBlockTitle" }, { type: "boxBlockBody", content: [{ type: "paragraph" }] },
    ] }] },
  });
  editors.push(editor);
  let position = 0;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === nodeName) position = pos + 1; });
  editor.commands.setTextSelection(position);
  const before = editor.getJSON();
  editor.view.dom.dispatchEvent(new FocusEvent("focus"));
  editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "本文" }));
  expect(editor.getJSON()).toEqual(before);
  expect(editor.getAttributes("styledText").fontFamily).toBeFalsy();
  editor.commands.insertContent("本文");
  expect(editor.getAttributes("styledText").fontFamily).toBeFalsy();
  editor.commands.setFontFamily("sans-serif");
  editor.commands.insertContent("明示指定");
  expect(editor.getAttributes("styledText").fontFamily).toBe("sans-serif");
});
