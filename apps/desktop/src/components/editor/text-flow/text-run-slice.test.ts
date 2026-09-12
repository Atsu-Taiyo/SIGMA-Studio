// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import type { TextFlowBlock } from "@/features/text-editing";

import { plainTextToTextFlowParagraphs, sliceToTextFlowBlocks } from "./text-run-slice";

function createEditor() {
  return new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
      ],
    }),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { sigmaDocId: "p1", sigmaDocType: "paragraph" },
          content: [{ type: "text", text: "前半" }],
        },
        {
          type: "paragraph",
          attrs: { sigmaDocId: "p2", sigmaDocType: "paragraph" },
          content: [{ type: "text", text: "後半" }],
        },
      ],
    },
  });
}

describe("sliceToTextFlowBlocks", () => {
  it("converts a full document slice into SigmaDoc paragraphs", () => {
    const editor = createEditor();
    const blocks = sliceToTextFlowBlocks(editor.state.doc.slice(0, editor.state.doc.content.size));
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.map((block) => block.id)).toEqual(["p1", "p2"]);
    editor.destroy();
  });

  it("keeps a partial first paragraph as its own block", () => {
    const editor = createEditor();
    const firstEnd = 1 + "前半".length;
    const blocks = sliceToTextFlowBlocks(editor.state.doc.slice(firstEnd, editor.state.doc.content.size));
    expect(blocks.some((block) => block.id === "p2")).toBe(true);
    editor.destroy();
  });

  it("carries pagination hints over from the previous blocks by id", () => {
    // PM スキーマは pagination を持たないため、slice 由来のブロックへは現在のブロック
    // から id で引き継ぐ (跨ぎ置換で選択の外に残るブロックの改ページを守る)。
    const editor = createEditor();
    const previousBlocks: TextFlowBlock[] = [
      { type: "paragraph", id: "p1", children: [{ type: "text", text: "前半" }] },
      {
        type: "paragraph",
        id: "p2",
        children: [{ type: "text", text: "後半" }],
        pagination: { break: true },
      },
    ];
    const blocks = sliceToTextFlowBlocks(
      editor.state.doc.slice(0, editor.state.doc.content.size),
      previousBlocks,
    );
    expect(blocks.find((block) => block.id === "p2")?.pagination).toEqual({ break: true });
    editor.destroy();
  });

  it("keeps the original id and break on a trailing partial owner slice", () => {
    const editor = createEditor();
    const previousBlocks: TextFlowBlock[] = [
      { type: "paragraph", id: "p1", children: [{ type: "text", text: "前半" }] },
      {
        type: "paragraph",
        id: "p2",
        children: [{ type: "text", text: "後半" }],
        pagination: { break: true },
      },
    ];
    const secondStart = editor.state.doc.resolve(1).end() + 2;
    const blocks = sliceToTextFlowBlocks(
      editor.state.doc.slice(secondStart + 1, editor.state.doc.content.size),
      previousBlocks,
    );

    expect(blocks).toEqual([{
      type: "paragraph",
      id: "p2",
      children: [{ type: "text", text: "半" }],
      pagination: { break: true },
    }]);
    editor.destroy();
  });
});

describe("plainTextToTextFlowParagraphs", () => {
  it("行ごとに段落へ分割し、連続改行は 1 つの段落境界に畳む (PM の parseText と同じ規則)", () => {
    const blocks = plainTextToTextFlowParagraphs("一行目\n二行目\r\n\n三行目");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(blocks.map((block) => (
      block.type === "paragraph" ? block.children.map((child) => "text" in child ? child.text : "").join("") : ""
    ))).toEqual(["一行目", "二行目", "三行目"]);
  });

  it("空テキストは空段落 1 つになる", () => {
    const blocks = plainTextToTextFlowParagraphs("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type === "paragraph" && blocks[0].children).toEqual([]);
  });
});
