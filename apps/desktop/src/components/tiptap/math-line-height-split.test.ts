// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { textFlowToTiptap, tiptapToTextFlow } from "@/components/editor/text-flow/tiptap-document-adapter";
import type { TextFlowBlock } from "@/features/text-editing";
import type { TiptapDoc } from "@/lib/tiptap-adapter";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { SigmaDocTextAttrs } from "./sigma-doc-text-attributes";
import { SigmaDocTextIdentity } from "./sigma-doc-text-identity";

// 外部教材の取り込みの解答: 背の高い数式に合わせて段落の行間が 3 になっている。
const mathParagraph: TextFlowBlock = {
  type: "paragraph",
  id: "math_line",
  lineHeight: "3",
  children: [
    { type: "text", text: "式" },
    { type: "mathInline", id: "m1", tex: "\\frac{1}{6}\\left\\lbrace a\\right\\rbrace^{\\frac{3}{2}}", display: "inline" },
  ],
} as TextFlowBlock;

const plainParagraph: TextFlowBlock = {
  type: "paragraph",
  id: "plain_line",
  lineHeight: "3",
  children: [{ type: "text", text: "広い行" }],
} as TextFlowBlock;

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(blocks: TextFlowBlock[]) {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createRichTextEngineExtensions({
      blockExtensions: [SigmaDocTextAttrs, SigmaDocTextIdentity],
    }),
    content: textFlowToTiptap(blocks),
  });
  return editor;
}

function pressEnter(target: Editor) {
  target.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function lineHeights(target: Editor, previous: TextFlowBlock[]) {
  return tiptapToTextFlow(target.getJSON() as TiptapDoc, previous)
    .map((block) => (block as { lineHeight?: string }).lineHeight ?? null);
}

describe("Enter after a paragraph widened for math", () => {
  it("does not carry the math line height to the new plain line", () => {
    const target = mount([mathParagraph]);
    target.commands.setTextSelection(target.state.doc.firstChild!.nodeSize - 1);
    pressEnter(target);
    target.commands.insertContent("次の行");
    expect(lineHeights(target, [mathParagraph])).toEqual(["3", null]);
  });

  it("keeps the line height on the half that still holds the math when Enter is pressed before it", () => {
    const target = mount([mathParagraph]);
    target.commands.setTextSelection(2); // 「式」の直後 = 数式の直前
    pressEnter(target);
    expect(lineHeights(target, [mathParagraph])).toEqual([null, "3"]);
  });

  it("still carries the line height of a paragraph without math", () => {
    const target = mount([plainParagraph]);
    target.commands.setTextSelection(target.state.doc.firstChild!.nodeSize - 1);
    pressEnter(target);
    expect(lineHeights(target, [plainParagraph])).toEqual(["3", "3"]);
  });

  it("does not touch splits that are not a user Enter", () => {
    const target = mount([mathParagraph]);
    target.commands.setTextSelection(target.state.doc.firstChild!.nodeSize - 1);
    target.commands.splitBlock();
    expect(lineHeights(target, [mathParagraph])).toEqual(["3", "3"]);
  });
});
