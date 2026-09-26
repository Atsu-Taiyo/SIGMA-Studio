import { describe, expect, it } from "vitest";

import type {
  LayoutSectionChildBlock,
  ProblemAreaBlock,
} from "@/types/sigma-doc";

import type { TextFlowBlock } from "../text-flow/types";
import {
  replaceLayoutSectionChildren,
  replaceProblemAreaRichBlocks,
  textFlowBlockToProblemAreaBlock,
} from "./reconciliation";

describe("page-canvas TextFlow reconciliation", () => {
  it("persists code settings changed inside a problem area", () => {
    const original: TextFlowBlock = {
      type: "codeBlock", id: "code", children: [{ type: "text", text: "const x = 1;" }],
    };
    const edited: TextFlowBlock = { ...original, language: "typescript", theme: "dark" };
    const result = replaceProblemAreaRichBlocks([original], [original.id], [edited], new Set());
    expect(result).toEqual([edited]);
    const saved = JSON.parse(JSON.stringify(result));
    expect(replaceProblemAreaRichBlocks(saved, [edited.id], [edited], new Set())).toBe(saved);
  });

  it("reuses the original array and block reference when replacement data is equal", () => {
    const before = paragraph("before", "before");
    const target = paragraph("target", "same");
    const after = paragraph("after", "after");
    const blocks = [before, target, after];
    const replacement = structuredClone(target);

    const result = replaceProblemAreaRichBlocks(
      blocks,
      ["target"],
      [replacement],
      new Set(["before", "after"]),
    );

    expect(result).toBe(blocks);
    expect(result[1]).toBe(target);
  });

  it("preserves unrelated references and converts section TextFlow blocks to problem headings", () => {
    const before = paragraph("before", "before");
    const target = paragraph("target", "old");
    const after = paragraph("after", "after");
    const section: TextFlowBlock = {
      id: "target",
      type: "section",
      title: "見出し",
      align: "center",
      lineHeight: "1.6",
      pagination: { break: true },
    };

    const result = replaceProblemAreaRichBlocks(
      [before, target, after],
      ["target"],
      [section],
      new Set(["before", "after"]),
    );

    expect(result[0]).toBe(before);
    expect(result[2]).toBe(after);
    expect(result[1]).toEqual({
      id: "target",
      type: "heading",
      level: 1,
      children: [{ type: "text", text: "見出し" }],
      align: "center",
      lineHeight: "1.6",
      pagination: { break: true },
    });
  });

  it("preserves a box block with its rich title, body, frame, and ids", () => {
    const box: TextFlowBlock = {
      id: "box",
      type: "boxBlock",
      styleId: "frame",
      title: [
        {
          type: "text",
          text: "重要",
          marks: ["bold"],
          color: "#dc2626",
          fontFamily: "serif",
          fontSize: 14,
        },
        {
          type: "mathInline",
          id: "title_math",
          tex: "x^2",
          display: "inline",
        },
      ],
      blocks: [paragraph("inside", "content")],
      frame: {
        borderColor: "#2563eb",
        titlePosition: "c",
      },
      pagination: { break: true },
    };

    const result = replaceProblemAreaRichBlocks(
      [],
      [],
      [box],
      new Set(),
    );

    expect(result).toEqual([box]);
    expect(result[0]).not.toBe(box);
    expect(result[0]?.id).toBe("box");
    expect(result[0]?.type === "boxBlock" ? result[0].blocks[0]?.id : null)
      .toBe("inside");
  });

  it("keeps layout sections non-empty after deleting their last edited child", () => {
    const target = paragraph("target", "remove");

    const result = replaceLayoutSectionChildren(
      [target],
      ["target"],
      [],
      new Set(),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "paragraph",
      children: [],
    });
    expect(result[0]?.id).toMatch(/^p_/);
  });
});

function paragraph(
  id: string,
  text: string,
): Extract<ProblemAreaBlock & LayoutSectionChildBlock, { type: "paragraph" }> {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

describe("textFlowBlockToProblemAreaBlock keeps the space below every block", () => {
  /**
   * 問題エリアの編集結果を SigmaDoc へ書き戻す唯一の経路。ここでフィールドを落とすと
   * 「問題エリア内で余白を付けても次の打鍵で消える」形で表に出る。
   */
  const CASES: Array<[string, TextFlowBlock]> = [
    ["section", { type: "section", id: "s", title: "節", spaceAfterPx: 24 }],
    ["heading", { type: "heading", id: "h", level: 2, children: [], spaceAfterPx: 24 }],
    ["paragraph", { type: "paragraph", id: "p", children: [], spaceAfterPx: 24 }],
    [
      "list",
      {
        type: "list",
        id: "l",
        listType: "bullet",
        items: [{ type: "listItem", id: "li", children: [] }],
        spaceAfterPx: 24,
      },
    ],
    ["divider", { type: "divider", id: "d", spaceAfterPx: 24 }],
    ["quote", { type: "quote", id: "q", blocks: [{ type: "paragraph", id: "qp", children: [] }], spaceAfterPx: 24 }],
    ["codeBlock", { type: "codeBlock", id: "c", children: [], spaceAfterPx: 24 }],
    [
      "boxBlock",
      {
        type: "boxBlock",
        id: "b",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", id: "bp", children: [] }],
        spaceAfterPx: 24,
      },
    ],
    [
      "layoutSection",
      {
        type: "layoutSection",
        id: "ls",
        layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "lp", children: [] }],
        spaceAfterPx: 24,
      },
    ],
  ];

  it.each(CASES)("keeps it for %s", (_name, block) => {
    expect(textFlowBlockToProblemAreaBlock(block).spaceAfterPx).toBe(24);
  });

  it("leaves an untouched block without a space", () => {
    expect(textFlowBlockToProblemAreaBlock({ type: "paragraph", id: "p", children: [] }).spaceAfterPx)
      .toBeUndefined();
  });
});
