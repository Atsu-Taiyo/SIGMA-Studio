import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import {
  commitListIndent,
  findListIndentTarget,
  ListIndentExtension,
  listIndentEmForNode,
  setListIndentPreview,
} from "@/components/tiptap/list-indent-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { snapListIndentEm } from "@/components/editor/text-flow/ListIndentSlider";

const schema = getSchema(createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs, ListIndentExtension] }));

function listState(markerStyle: string | null, indentEm: number | null = null): EditorState {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [{
      type: "orderedList",
      attrs: { start: 1, markerStyle, indentEm },
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }] }],
    }],
  });
  const state = EditorState.create({ schema, doc, plugins: [] });
  return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
}

describe("list indent", () => {
  it("finds the innermost list around the caret and reads its drawn indent", () => {
    const state = listState("paren");
    const target = findListIndentTarget(state.selection.$from)!;
    expect(target.pos).toBe(0);
    expect(listIndentEmForNode(target.node)).toBe(1.75);
    expect(listIndentEmForNode(listState("parenLowerRoman").doc.child(0))).toBe(2);
    expect(listIndentEmForNode(listState(null, 3.5).doc.child(0))).toBe(3.5);
  });

  it("writes the dragged value once, and writes nothing for the default", () => {
    const state = listState("paren");
    const target = findListIndentTarget(state.selection.$from)!;
    expect(state.apply(commitListIndent(state, target, 3)).doc.child(0).attrs.indentEm).toBe(3);
    expect(state.apply(commitListIndent(state, target, 1.75)).doc.child(0).attrs.indentEm).toBeNull();
    expect(state.apply(commitListIndent(state, target, null)).doc.child(0).attrs.indentEm).toBeNull();
  });

  it("keeps the preview out of the document and the history", () => {
    const state = listState("paren");
    const transaction = setListIndentPreview(state.tr, { pos: 0, indentEm: 4 });
    expect(transaction.docChanged).toBe(false);
    expect(transaction.getMeta("addToHistory")).toBe(false);
  });

  it("snaps to quarter steps and pulls toward the default", () => {
    expect(snapListIndentEm(2.6, 1.75)).toBe(2.5);
    expect(snapListIndentEm(1.9, 1.75)).toBe(1.75);
    expect(snapListIndentEm(-3, 1.75)).toBe(0);
    expect(snapListIndentEm(30, 1.75)).toBe(8);
  });
});
