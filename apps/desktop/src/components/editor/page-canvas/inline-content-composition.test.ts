import { describe, expect, it } from "vitest";

import type { TextFlowBlock } from "../text-flow/types";
import {
  getProblemAfterInlineContent,
  splitTextFlowBlocksByInlineContent,
} from "./inline-content-composition";

describe("inline content composition", () => {
  it("preserves block and anchor order without creating empty TextFlow ranges", () => {
    const first = paragraph("first");
    const second = paragraph("second");
    const third = paragraph("third");
    const firstItems = ["first-anchor"] as const;
    const thirdItems = ["third-anchor-a", "third-anchor-b"] as const;
    const content = new Map<string, readonly string[]>([
      [first.id, firstItems],
      [second.id, []],
      [third.id, thirdItems],
    ]);

    const result = splitTextFlowBlocksByInlineContent(
      [first, second, third],
      content,
    );

    expect(result).toEqual([
      {
        type: "blocks",
        key: "blocks-first-first",
        blocks: [first],
      },
      {
        type: "content",
        key: "extension-content-first",
        items: firstItems,
      },
      {
        type: "blocks",
        key: "blocks-second-third",
        blocks: [second, third],
      },
      {
        type: "content",
        key: "extension-content-third",
        items: thirdItems,
      },
    ]);
    expect(result[1]?.type === "content" ? result[1].items : null).toBe(
      firstItems,
    );
    expect(result[3]?.type === "content" ? result[3].items : null).toBe(
      thirdItems,
    );
  });

  it("does not cross problem or layout-section TextFlow boundaries", () => {
    const promptBlock = paragraph("prompt-block");
    const layoutBlock = paragraph("layout-block");
    const content = new Map<string, readonly string[]>([
      ["problem", ["after-problem"]],
      [promptBlock.id, ["after-prompt-block"]],
      ["layout-section", ["after-layout-section"]],
      [layoutBlock.id, ["after-layout-block"]],
      ["outside-block", ["outside"]],
    ]);

    expect(
      splitTextFlowBlocksByInlineContent([promptBlock], content),
    ).toEqual([
      {
        type: "blocks",
        key: "blocks-prompt-block-prompt-block",
        blocks: [promptBlock],
      },
      {
        type: "content",
        key: "extension-content-prompt-block",
        items: ["after-prompt-block"],
      },
    ]);
    expect(
      splitTextFlowBlocksByInlineContent([layoutBlock], content),
    ).toEqual([
      {
        type: "blocks",
        key: "blocks-layout-block-layout-block",
        blocks: [layoutBlock],
      },
      {
        type: "content",
        key: "extension-content-layout-block",
        items: ["after-layout-block"],
      },
    ]);
  });

  it("keeps an empty editor range and ignores empty anchored content", () => {
    const emptyBlocks: TextFlowBlock[] = [];
    const emptyResult = splitTextFlowBlocksByInlineContent(
      emptyBlocks,
      new Map([["outside", ["content"]]]),
    );

    expect(emptyResult).toEqual([{
      type: "blocks",
      key: "blocks-empty",
      blocks: [],
    }]);
    expect(
      emptyResult[0]?.type === "blocks" ? emptyResult[0].blocks : null,
    ).toBe(emptyBlocks);

    const block = paragraph("only");
    expect(splitTextFlowBlocksByInlineContent(
      [block],
      new Map([[block.id, []]]),
    )).toEqual([{
      type: "blocks",
      key: "blocks-only-only",
      blocks: [block],
    }]);
  });

  it("places problem-level content only after the final problem area", () => {
    const afterProblem = ["after-problem"] as const;
    const content = new Map<string, readonly string[]>([
      ["problem", afterProblem],
    ]);

    expect(
      getProblemAfterInlineContent("problem", false, content),
    ).toEqual([]);
    expect(
      getProblemAfterInlineContent("problem", true, content),
    ).toBe(afterProblem);
    expect(
      getProblemAfterInlineContent("missing", true, content),
    ).toEqual([]);
  });
});

function paragraph(id: string): TextFlowBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text: id }],
  };
}
