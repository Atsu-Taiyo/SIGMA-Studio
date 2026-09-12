import { Extension, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { InlineMathExtension } from "@/components/tiptap/inline-math-extension";
import { findTouchedLockedBlockIds, shouldAllowTextFlowTransaction } from "./edit-lock-adapter";

const SigmaDocIdAttrs = Extension.create({
  name: "testSigmaDocIdAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          sigmaDocId: {
            default: null,
          },
        },
      },
    ];
  },
});

const schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, undoRedo: false }),
  InlineMathExtension,
  SigmaDocIdAttrs,
]);

function createDoc(blocks: Array<{ id: string; text: string }>): ProseMirrorNode {
  return schema.nodes.doc.create(
    null,
    blocks.map((block) =>
      schema.nodes.paragraph.create({ sigmaDocId: block.id }, block.text ? schema.text(block.text) : undefined),
    ),
  );
}

describe("findTouchedLockedBlockIds", () => {
  it("reports no touched blocks when the two docs are the same object (selection-only transaction)", () => {
    const doc = createDoc([{ id: "p1", text: "hello" }]);
    expect(findTouchedLockedBlockIds(doc, doc, new Set(["p1"]))).toEqual([]);
  });

  it("reports the locked block whose text content changed", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }, { id: "p2", text: "world" }]);
    const newDoc = createDoc([{ id: "p1", text: "hello!" }, { id: "p2", text: "world" }]);

    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["p1"]))).toEqual(["p1"]);
  });

  it("does not report a locked block that is untouched while an unrelated block changes", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }, { id: "p2", text: "world" }]);
    const newDoc = createDoc([{ id: "p1", text: "hello" }, { id: "p2", text: "world!" }]);

    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["p1"]))).toEqual([]);
  });

  it("reports a locked block that was deleted", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }, { id: "p2", text: "world" }]);
    const newDoc = createDoc([{ id: "p2", text: "world" }]);

    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["p1"]))).toEqual(["p1"]);
  });

  it("reports a locked block that was reordered relative to other still-present blocks even though its own content is unchanged", () => {
    const oldDoc = createDoc([{ id: "p1", text: "a" }, { id: "p2", text: "b" }, { id: "p3", text: "c" }]);
    // p2 (locked) moved from the middle to the end.
    const newDoc = createDoc([{ id: "p1", text: "a" }, { id: "p3", text: "c" }, { id: "p2", text: "b" }]);

    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["p2"]))).toEqual(["p2"]);
  });

  it("does not treat an insertion of a brand-new unrelated block as moving the locked block", () => {
    const oldDoc = createDoc([{ id: "p1", text: "a" }, { id: "p2", text: "b" }]);
    // A new paragraph "p0" is inserted before the locked block "p2" -- p2's
    // content and its relative order versus the other pre-existing block (p1)
    // are unaffected.
    const newDoc = createDoc([{ id: "p1", text: "a" }, { id: "p0", text: "new" }, { id: "p2", text: "b" }]);

    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["p2"]))).toEqual([]);
  });

  it("treats a structurally-identical doc rebuilt from scratch (e.g. a setContent resync) as untouched", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }, { id: "p2", text: "world" }]);
    // Same content, but a freshly constructed (not object-identical) doc --
    // this is what TextFlowEditor's setContent-driven resyncs look like when
    // an unrelated block elsewhere caused the whole document to be rebuilt.
    const newDoc = createDoc([{ id: "p1", text: "hello" }, { id: "p2", text: "world" }]);

    expect(oldDoc).not.toBe(newDoc);
    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["p1", "p2"]))).toEqual([]);
  });

  it("ignores a locked block id that doesn't exist in this editor's document at all", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }]);
    const newDoc = createDoc([{ id: "p1", text: "hello changed" }]);

    // "other-block" belongs to a different TextFlowEditor instance (e.g. a
    // different problem area) -- nothing in *this* doc should be reported.
    expect(findTouchedLockedBlockIds(oldDoc, newDoc, new Set(["other-block"]))).toEqual([]);
  });
});

describe("shouldAllowTextFlowTransaction", () => {
  it("allows transactions when there are no locked blocks", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }]);
    const newDoc = createDoc([{ id: "p1", text: "hello!" }]);
    expect(shouldAllowTextFlowTransaction(oldDoc, newDoc, new Set(), { isComposing: false })).toBe(true);
  });

  it("blocks an edit to a locked block's text", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }]);
    const newDoc = createDoc([{ id: "p1", text: "hello!" }]);
    expect(shouldAllowTextFlowTransaction(oldDoc, newDoc, new Set(["p1"]), { isComposing: false })).toBe(false);
  });

  it("blocks an edit to a locked block while the view is mid-IME-composition", () => {
    const oldDoc = createDoc([{ id: "p1", text: "hello" }]);
    const newDoc = createDoc([{ id: "p1", text: "hello!" }]);
    expect(shouldAllowTextFlowTransaction(oldDoc, newDoc, new Set(["p1"]), { isComposing: true })).toBe(false);
  });

  it("blocks changing a locked inline-math atom inside the guarded block", () => {
    const oldDoc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(
        { sigmaDocId: "p1" },
        schema.nodes.mathInline.create({ id: "m1", tex: "x" }),
      ),
    );
    const newDoc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(
        { sigmaDocId: "p1" },
        schema.nodes.mathInline.create({ id: "m1", tex: "x+1" }),
      ),
    );

    expect(shouldAllowTextFlowTransaction(
      oldDoc,
      newDoc,
      new Set(["p1"]),
      { isComposing: false },
    )).toBe(false);
  });
});
