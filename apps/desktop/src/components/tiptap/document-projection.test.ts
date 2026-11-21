// @vitest-environment happy-dom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { SigmaDocTextAttrs } from "./sigma-doc-text-attributes";
import { applyEditorDocumentProjection } from "./document-projection";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(editor => { editor.view.dom.remove(); editor.destroy(); }));
const paragraph = (id: string, text: string): JSONContent => ({
  type: "paragraph", attrs: { sigmaDocId: id }, content: text ? [{ type: "text", text }] : [],
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
function editor(content: JSONContent) {
  const result = new Editor({ extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }), content });
  document.body.append(result.view.dom);
  editors.push(result);
  return result;
}

it("patches editors with unkeyed paragraphs without inserting nested paragraph wrappers", () => {
  const input = editor(doc({ type: "paragraph", content: [{ type: "text", text: "abcd" }] }));
  input.commands.setTextSelection(4);
  const next = doc({ type: "paragraph", content: [{ type: "text", text: "aXXbcd" }] });
  applyEditorDocumentProjection(input, next);
  expect(input.state.doc.eq(input.schema.nodeFromJSON(next))).toBe(true);
  expect(input.state.selection.head).toBe(6);
});

it("preserves the caret and math DOM between disjoint changes without emitting a local edit", () => {
  const math: JSONContent = { type: "mathInline", attrs: { id: "m1", tex: "x" } };
  const middle: JSONContent = { ...paragraph("p2", "ab"), content: [{ type: "text", text: "ab" }, math, { type: "text", text: "cd" }] };
  const input = editor(doc(paragraph("p1", "before"), middle, paragraph("p3", "after")));
  input.commands.setTextSelection(10);
  const mathDom = input.view.dom.querySelector('[data-id="m1"]');
  const update = vi.fn();
  input.on("update", update);
  const next = doc(paragraph("p0", "new"), paragraph("p1", "BEFORE"), middle, paragraph("p3", "AFTER"));
  applyEditorDocumentProjection(input, next);
  expect(input.state.doc.eq(input.schema.nodeFromJSON(next))).toBe(true);
  expect(input.state.selection.head).toBe(15);
  expect(input.view.dom.querySelector('[data-id="m1"]')).toBe(mathDom);
  expect(update).not.toHaveBeenCalled();
});

it("uses the authority's mapped selection inside text changed on both sides of the caret", () => {
  const input = editor(doc(paragraph("p1", "abcDEFghi")));
  input.commands.setTextSelection({ from: 7, to: 4 });
  const next = doc(paragraph("p1", "XXabcDEFghiYY"));
  applyEditorDocumentProjection(input, next, { anchor: { blockId: "p1", offset: 8 }, head: { blockId: "p1", offset: 5 } });
  expect(input.state.selection.anchor).toBe(9);
  expect(input.state.selection.head).toBe(6);
  expect(input.state.doc.textBetween(input.state.selection.from, input.state.selection.to)).toBe("DEF");
});

it("keeps the formula mounted when text and formatting around it change", () => {
  const math: JSONContent = { type: "mathInline", attrs: { id: "m1", tex: "x" } };
  const input = editor(doc({ ...paragraph("p1", ""), content: [{ type: "text", text: "a" }, math, { type: "text", text: "b" }] }));
  const mathDom = input.view.dom.querySelector('[data-id="m1"]');
  const next = doc({ ...paragraph("p1", ""), content: [{ type: "text", text: "XXa", marks: [{ type: "bold" }] }, math, { type: "text", text: "bYY" }] });
  applyEditorDocumentProjection(input, next);
  expect(input.state.doc.eq(input.schema.nodeFromJSON(next))).toBe(true);
  expect(input.view.dom.querySelector('[data-id="m1"]')).toBe(mathDom);
});

it("follows a moved block by ID and uses a nearby valid caret when its block is deleted", () => {
  const input = editor(doc(paragraph("p1", "one"), paragraph("p2", "two"), paragraph("p3", "three")));
  input.commands.setTextSelection(8);
  const selection = { anchor: { blockId: "p2", offset: 2 }, head: { blockId: "p2", offset: 2 } };
  applyEditorDocumentProjection(input, doc(paragraph("p2", "two"), paragraph("p3", "three"), paragraph("p1", "one")), selection);
  expect(input.state.selection.head).toBe(3);
  const next = doc(paragraph("p3", "three"), paragraph("p1", "one"));
  applyEditorDocumentProjection(input, next, selection);
  expect(input.state.doc.eq(input.schema.nodeFromJSON(next))).toBe(true);
  expect(input.state.selection.$head.parent.isTextblock).toBe(true);
  expect(input.state.selection.$head.parent.attrs.sigmaDocId).toBe("p3");
});
