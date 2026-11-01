// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { closeHistory } from "@tiptap/pm/history";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { SigmaDocTextAttrs } from "./sigma-doc-text-attributes";
import { textFlowToTiptap, tiptapToTextFlow } from "@/components/editor/text-flow/tiptap-document-adapter";
import { fromTiptap, toTiptap } from "@/lib/tiptap-adapter";
import { inlineNodesTextBlockTypographyVars } from "@/features/rendering/adapters";
import type { ParagraphNode } from "@/features/document";
const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); });
const source: ParagraphNode = { type: "paragraph", id: "blank", children: [{ type: "text", text: "", fontSize: 18, fontFamily: "monospace" }] };
function create() {
 const editor = new Editor({ extensions: createRichTextEngineExtensions({ localHistory: true, blockExtensions: [SigmaDocTextAttrs] }), content: textFlowToTiptap([source, { type: "paragraph", id: "next", children: [{ type: "text", text: "後続" }] }]) });
 editors.push(editor); return editor;
}
it("preserves blank run typography in both adapters and the shared static typography projection", () => {
 expect(fromTiptap(toTiptap(source), source)).toEqual(source);
 const editor = create();
 expect(tiptapToTextFlow(editor.getJSON())[0]).toEqual(source);
 expect(inlineNodesTextBlockTypographyVars(source.children)).toEqual({ "--sigma-doc-text-line-font-size": "18pt" });
 const before = editor.getJSON();
 editor.commands.setTextSelection(4);
 expect(editor.getJSON()).toEqual(before);
 expect(editor.view.dom.querySelector("p")?.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("18pt");
 editor.commands.setTextSelection(1);
 expect(editor.getAttributes("styledText").fontSize).toBe(18);
 editor.commands.insertContent("入力");
 expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({ children: [{ type: "text", text: "入力", fontSize: 18, fontFamily: "monospace" }] });
});
it("keeps explicit blank formatting across selection, undo/redo and reload", () => {
 const editor = create();
 editor.commands.setTextSelection(1);
 editor.view.dispatch(closeHistory(editor.state.tr));
 editor.commands.setFontSize(10);
 expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({ children: [{ type: "text", text: "", fontSize: 10 }] });
 editor.commands.setTextSelection(4);
 expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({ children: [{ fontSize: 10 }] });
 editor.commands.undo();
 expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({ children: [{ fontSize: 18 }] });
 editor.commands.redo();
 expect(tiptapToTextFlow(editor.getJSON())[0]).toMatchObject({ children: [{ fontSize: 10 }] });
 const saved = tiptapToTextFlow(editor.getJSON());
 editor.commands.setContent(textFlowToTiptap(saved));
 expect(tiptapToTextFlow(editor.getJSON())).toEqual(saved);
});
