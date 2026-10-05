import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { selectionOutsideCollapsedBlocks } from "./collapsed-selection";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", attrs: { sigmaDocId: { default: null } } },
    text: { inline: true },
  },
});

/** 段落 a・b・c (各 3 文字)。位置: a は 1..4、b は 6..9、c は 11..14。 */
function stateAt(anchor: number, head = anchor): EditorState {
  const doc = schema.node("doc", null, ["a", "b", "c"].map((id) => (
    schema.node("paragraph", { sigmaDocId: id }, [schema.text(`${id}${id}${id}`)])
  )));
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, anchor, head) });
}

describe("selectionOutsideCollapsedBlocks", () => {
  it("moves a caret in a folded block to the end of the visible block before it", () => {
    const next = selectionOutsideCollapsedBlocks(stateAt(7), ["b"]);
    expect(next?.from).toBe(4);
    expect(next?.empty).toBe(true);
  });

  it("moves to the start of the visible block after it when nothing visible comes before", () => {
    const next = selectionOutsideCollapsedBlocks(stateAt(2), ["a", "b"]);
    expect(next?.from).toBe(11);
  });

  it("moves a range only when both of its ends are inside the same folded block", () => {
    expect(selectionOutsideCollapsedBlocks(stateAt(6, 8), ["b"])?.from).toBe(4);
  });

  it("leaves a range across a folded block alone (deleting it is refused by the guard)", () => {
    expect(selectionOutsideCollapsedBlocks(stateAt(2, 8), ["b"])).toBeNull();
    expect(selectionOutsideCollapsedBlocks(stateAt(7, 12), ["b"])).toBeNull();
  });

  it("does not move a selection that only ends where the next (folded) block begins", () => {
    // 段落 a の中から a と b の境目 (位置 5) まで: 終わりの位置の index(0) は次の b を指すが、選択は b に入っていない。
    expect(selectionOutsideCollapsedBlocks(stateAt(2, 5), ["b"])).toBeNull();
  });

  it("leaves a node selection and a select-all alone", () => {
    const base = stateAt(7);
    const nodeSelected = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, 5)));
    const allSelected = base.apply(base.tr.setSelection(new AllSelection(base.doc)));
    expect(selectionOutsideCollapsedBlocks(nodeSelected, ["b"])).toBeNull();
    expect(selectionOutsideCollapsedBlocks(allSelected, ["b"])).toBeNull();
  });

  it("leaves a selection outside the folded blocks, and one with nowhere visible to go, alone", () => {
    expect(selectionOutsideCollapsedBlocks(stateAt(12), ["b"])).toBeNull();
    expect(selectionOutsideCollapsedBlocks(stateAt(7), [])).toBeNull();
    expect(selectionOutsideCollapsedBlocks(stateAt(7), undefined)).toBeNull();
    expect(selectionOutsideCollapsedBlocks(stateAt(7), ["a", "b", "c"])).toBeNull();
  });
});
