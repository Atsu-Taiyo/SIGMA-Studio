import { getSchema } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

import type { TextFlowBlock } from "@/features/text-editing";

import {
  insertTextSliceWithFreshBlockIds,
  refreshSigmaDocIdsInSlice,
  resolveTextRunSpanAnchorBlockIdMap,
} from "./text-and-shapes-clipboard";

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
  return current.node("paragraph", { sigmaDocId: id, sigmaDocType: "paragraph" }, text ? [current.text(text)] : undefined);
}

function paragraphPosition(doc: ProseMirrorNode, id: string, offset: number): number {
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

describe("text and shapes clipboard text insertion", () => {
  it("maps an open first paragraph to the target and gives the following paragraph a fresh id", () => {
    const current = schema();
    const doc = current.node("doc", null, [paragraph(current, "p_target", "target text")]);
    const cursor = paragraphPosition(doc, "p_target", 6);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
    const slice = new Slice(Fragment.fromArray([
      paragraph(current, "p_old_1", "first"),
      paragraph(current, "p_old_2", "second"),
    ]), 1, 1);

    const { transaction, anchorBlockIdMap } = insertTextSliceWithFreshBlockIds(state, slice);

    expect(anchorBlockIdMap.p_old_1).toBe("p_target");
    expect(anchorBlockIdMap.p_old_2).toMatch(/^p_/);
    expect(anchorBlockIdMap.p_old_2).not.toBe("p_old_2");
    const ids: string[] = [];
    transaction.doc.descendants((node) => {
      if (typeof node.attrs.sigmaDocId === "string") ids.push(node.attrs.sigmaDocId);
      return true;
    });
    expect(ids.filter((id) => id === anchorBlockIdMap.p_old_2)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("inserts a closed paragraph with a fresh mapped id", () => {
    const current = schema();
    const doc = current.node("doc", null, [paragraph(current, "p_target", "target")]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, paragraphPosition(doc, "p_target", 3)),
    });
    const slice = new Slice(Fragment.from(paragraph(current, "p_closed", "closed")), 0, 0);

    const { transaction, anchorBlockIdMap } = insertTextSliceWithFreshBlockIds(state, slice);

    expect(anchorBlockIdMap.p_closed).toMatch(/^p_/);
    expect(anchorBlockIdMap.p_closed).not.toBe("p_closed");
    expect(transaction.doc.textContent).toContain("closed");
  });

  it("handles an open bullet-list slice and maps merged open nodes to document ancestors", () => {
    const current = schema();
    const targetParagraph = paragraph(current, "li_target", "target");
    const targetList = current.node("bulletList", { sigmaDocId: "list_target", sigmaDocType: "list" }, [
      current.node("listItem", null, [targetParagraph]),
    ]);
    const doc = current.node("doc", null, [targetList]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, paragraphPosition(doc, "li_target", 3)),
    });
    const sourceList = current.node("bulletList", { sigmaDocId: "list_old", sigmaDocType: "list" }, [
      current.node("listItem", null, [paragraph(current, "li_old", "item")]),
    ]);
    const slice = new Slice(Fragment.from(sourceList), 3, 3);

    const result = insertTextSliceWithFreshBlockIds(state, slice);

    expect(result.transaction.doc.textContent).toContain("item");
    expect(result.anchorBlockIdMap.li_old).toBeTruthy();
  });

  it("uses SigmaDoc-compatible id prefixes", () => {
    const current = schema();
    const list = current.node("bulletList", { sigmaDocId: "old_list", sigmaDocType: "list" }, [
      current.node("listItem", null, [
        current.node("paragraph", { sigmaDocId: "old_li", sigmaDocType: "listItem" }, [current.text("item")]),
      ]),
    ]);
    const box = current.node("boxBlock", { sigmaDocId: "old_box" }, [
      current.node("boxBlockTitle", null, [current.text("title")]),
      current.node("boxBlockBody", null, [paragraph(current, "old_box_p", "body")]),
    ]);
    const slice = new Slice(Fragment.fromArray([
      paragraph(current, "old_p", "p"),
      current.node("heading", { sigmaDocId: "old_heading", sigmaDocType: "heading", level: 2 }, [current.text("h")]),
      list,
      box,
    ]), 0, 0);

    const { idMap } = refreshSigmaDocIdsInSlice(slice);

    expect(idMap.get("old_p")).toMatch(/^p_/);
    expect(idMap.get("old_heading")).toMatch(/^heading_/);
    expect(idMap.get("old_list")).toMatch(/^list_/);
    expect(idMap.get("old_box")).toMatch(/^box_/);
    expect(idMap.get("old_li")).toMatch(/^li_/);
  });
});

describe("resolveTextRunSpanAnchorBlockIdMap", () => {
  const textParagraph = (id: string, content: string): TextFlowBlock => ({
    type: "paragraph",
    id,
    children: [{ type: "text", text: content }],
  });

  it("pairs source and pasted ids down to nested blocks", () => {
    const source: TextFlowBlock[] = [
      textParagraph("src-p", "本文"),
      {
        type: "boxBlock",
        id: "src-box",
        styleId: "fancybox",
        blocks: [textParagraph("src-box-p", "枠内")],
      },
      {
        type: "list",
        id: "src-list",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "src-li",
          children: [{ type: "text", text: "項目" }],
          nested: [{
            type: "list",
            id: "src-nested",
            listType: "bullet",
            items: [{ type: "listItem", id: "src-nested-li", children: [] }],
          }],
        }],
      },
    ];
    const pasted: TextFlowBlock[] = [
      textParagraph("new-p", "本文"),
      {
        type: "boxBlock",
        id: "new-box",
        styleId: "fancybox",
        blocks: [textParagraph("new-box-p", "枠内")],
      },
      {
        type: "list",
        id: "new-list",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "new-li",
          children: [{ type: "text", text: "項目" }],
          nested: [{
            type: "list",
            id: "new-nested",
            listType: "bullet",
            items: [{ type: "listItem", id: "new-nested-li", children: [] }],
          }],
        }],
      },
    ];

    expect(resolveTextRunSpanAnchorBlockIdMap(source, pasted, [
      { unitId: "chunk-a", previousIds: [], nextBlocks: pasted },
    ])).toEqual({
      "src-p": "new-p",
      "src-box": "new-box",
      "src-box-p": "new-box-p",
      "src-list": "new-list",
      "src-li": "new-li",
      "src-nested": "new-nested",
      "src-nested-li": "new-nested-li",
    });
  });

  it("redirects a boundary-joined first block to its join host", () => {
    const source = [textParagraph("src-p", "X")];
    const pasted = [textParagraph("new-p", "X")];

    expect(resolveTextRunSpanAnchorBlockIdMap(source, pasted, [{
      unitId: "chunk-a",
      previousIds: [],
      nextBlocks: [textParagraph("existing", "ABX")],
      joinedInsertionIds: { "new-p": "existing" },
    }])).toEqual({ "src-p": "existing" });
  });
});
