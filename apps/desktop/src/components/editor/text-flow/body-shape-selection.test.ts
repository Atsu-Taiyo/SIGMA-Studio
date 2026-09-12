import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

import { collectSelectedBlockIds } from "./body-shape-selection";

function schema(): Schema {
  return getSchema(createRichTextEngineExtensions({
    blockExtensions: [
      SigmaDocTextAttrs,
      BoxBlockExtension,
      BoxBlockTitleExtension,
      BoxBlockBodyExtension,
    ],
  }));
}

function paragraph(current: Schema, id: string, text: string): ProseMirrorNode {
  return current.node(
    "paragraph",
    { sigmaDocId: id, sigmaDocType: "paragraph" },
    text ? [current.text(text)] : undefined,
  );
}

function positionInBlock(doc: ProseMirrorNode, id: string, offset: number): number {
  let result = 1;
  doc.descendants((node, pos) => {
    if (node.attrs.sigmaDocId === id) {
      result = pos + 1 + offset;
      return false;
    }
    return true;
  });
  return result;
}

function selectedBlockIds(doc: ProseMirrorNode, from: number, to: number): string[] {
  return collectSelectedBlockIds(EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
  }));
}

describe("collectSelectedBlockIds", () => {
  it("returns every block the range covers, in document order", () => {
    const current = schema();
    const doc = current.node("doc", null, [
      paragraph(current, "p_1", "first"),
      paragraph(current, "p_2", "second"),
      paragraph(current, "p_3", "third"),
    ]);

    expect(selectedBlockIds(doc, positionInBlock(doc, "p_1", 2), positionInBlock(doc, "p_2", 3)))
      .toEqual(["p_1", "p_2"]);
  });

  it("drops a block the range only touches at its edge", () => {
    const current = schema();
    const doc = current.node("doc", null, [
      paragraph(current, "p_1", "first"),
      paragraph(current, "p_2", "second"),
    ]);

    // 「p_1 の末尾から p_2 の先頭まで」— p_2 の文字は 1 つも入っていない。
    expect(selectedBlockIds(doc, positionInBlock(doc, "p_1", 0), positionInBlock(doc, "p_2", 0)))
      .toEqual(["p_1"]);
  });

  it("keeps an empty block the range runs through", () => {
    const current = schema();
    const doc = current.node("doc", null, [
      paragraph(current, "p_1", "first"),
      paragraph(current, "p_empty", ""),
      paragraph(current, "p_3", "third"),
    ]);

    expect(selectedBlockIds(doc, positionInBlock(doc, "p_1", 1), positionInBlock(doc, "p_3", 2)))
      .toEqual(["p_1", "p_empty", "p_3"]);
  });

  it("includes the box a selected paragraph lives in, so shapes hung on the box follow", () => {
    const current = schema();
    const doc = current.node("doc", null, [
      current.node("boxBlock", { sigmaDocId: "box_1", sigmaDocType: "boxBlock" }, [
        current.node("boxBlockTitle", { sigmaDocId: "box_1_title" }, [current.text("title")]),
        current.node("boxBlockBody", { sigmaDocId: "box_1_body" }, [
          paragraph(current, "p_in_box", "inside"),
        ]),
      ]),
    ]);

    const ids = selectedBlockIds(doc, positionInBlock(doc, "p_in_box", 1), positionInBlock(doc, "p_in_box", 4));
    expect(ids).toContain("p_in_box");
    expect(ids).toContain("box_1");
  });

  it("returns nothing for a collapsed caret", () => {
    const current = schema();
    const doc = current.node("doc", null, [paragraph(current, "p_1", "first")]);
    const caret = positionInBlock(doc, "p_1", 2);

    expect(selectedBlockIds(doc, caret, caret)).toEqual([]);
  });
});
