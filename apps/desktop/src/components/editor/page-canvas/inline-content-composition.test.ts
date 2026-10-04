import { describe, expect, it } from "vitest";

import type { ProblemNode } from "@/features/document";

import type { TextFlowBlock } from "../text-flow/types";
import {
  getFlowExtensionNodeId,
  getProblemAfterContentUnitIds,
  getProblemAfterInlineContent,
  splitTextFlowBlocksByInlineContent,
} from "./inline-content-composition";
import { problemToAreaUnits } from "./render-units";

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
        key: "blocks-start",
        blocks: [first],
      },
      {
        type: "content",
        key: "extension-content-first",
        items: firstItems,
      },
      {
        type: "blocks",
        key: "blocks-after-first",
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

  it("keeps the editing range before new content under the same key, so its editor survives", () => {
    const blocks = [paragraph("a"), paragraph("b"), paragraph("c")];
    const without = splitTextFlowBlocksByInlineContent(blocks, new Map<string, readonly string[]>());
    const withContent = splitTextFlowBlocksByInlineContent(blocks, new Map([["b", ["card"]]]));
    expect(without.map((part) => part.key)).toEqual(["blocks-start"]);
    expect(withContent.map((part) => part.key)).toEqual(["blocks-start", "extension-content-b", "blocks-after-b"]);
    // 先頭の範囲の key はその中のブロックの id に依らない (打鍵で先頭ブロックが変わっても作り直さない)。
    const renamed = splitTextFlowBlocksByInlineContent([paragraph("z"), ...blocks], new Map([["b", ["card"]]]));
    expect(renamed.map((part) => part.key)).toEqual(["blocks-start", "extension-content-b", "blocks-after-b"]);
  });

  it("places content anchored to a nested block after the top-level block that contains it", () => {
    const box: TextFlowBlock = {
      type: "boxBlock",
      id: "box",
      boxStyle: "fancybox",
      blocks: [paragraph("inside-box")],
    } as unknown as TextFlowBlock;
    const after = paragraph("after");
    const result = splitTextFlowBlocksByInlineContent(
      [box, after],
      new Map<string, readonly string[]>([["inside-box", ["nested-card"]], ["box", ["box-card"]]]),
    );
    expect(result.map((part) => part.key)).toEqual(["blocks-start", "extension-content-box", "blocks-after-box"]);
    expect(result[1]?.type === "content" ? result[1].items : null).toEqual(["box-card", "nested-card"]);
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
        key: "blocks-start",
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
        key: "blocks-start",
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
      key: "blocks-start",
      blocks: [],
    }]);
    expect(
      emptyResult[0]?.type === "blocks" ? emptyResult[0].blocks : null,
    ).toBe(emptyBlocks);

    const block = paragraph("only");
    const blocks = [block];
    const result = splitTextFlowBlocksByInlineContent(
      blocks,
      new Map([[block.id, []]]),
    );
    expect(result).toEqual([{
      type: "blocks",
      key: "blocks-start",
      blocks: [block],
    }]);
    // 差し込みが無ければ渡された配列のまま (編集面へ新しい配列を配らない)。
    expect(result[0]?.type === "blocks" ? result[0].blocks : null).toBe(blocks);
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

  it("draws problem-level content in exactly one unit when the last area is split around a column section", () => {
    const problem = {
      type: "problem",
      id: "problem",
      tags: [],
      lead: [],
      prompt: [paragraph("prompt")],
      solution: [
        paragraph("solution-before"),
        { type: "layoutSection", id: "columns", layout: { columnCount: 2 }, children: [paragraph("left"), paragraph("right")] },
        paragraph("solution-after"),
      ],
      hints: [],
    } as unknown as ProblemNode;
    const units = problemToAreaUnits(problem);
    const solutionUnits = units.filter((unit) => "area" in unit && unit.area === "solution");
    // 最後のエリアが「本文 → 部分段組み → 本文」の 3 ユニットに分かれている。
    expect(solutionUnits.map((unit) => unit.type)).toEqual(["problemArea", "problemLayoutSection", "problemArea"]);
    const hosts = getProblemAfterContentUnitIds(units);
    expect([...hosts]).toEqual([solutionUnits[2].id]);
  });

  it("falls back to the last body unit of the problem when its last area has no body unit", () => {
    const problem = {
      type: "problem",
      id: "problem",
      tags: [],
      lead: [],
      prompt: [paragraph("prompt")],
      solution: [{ type: "layoutSection", id: "columns", layout: { columnCount: 2 }, children: [paragraph("left"), paragraph("right")] }],
      hints: [],
    } as unknown as ProblemNode;
    const units = problemToAreaUnits(problem);
    const promptUnit = units.find((unit) => "area" in unit && unit.area === "prompt");
    expect([...getProblemAfterContentUnitIds(units)]).toEqual([promptUnit?.id]);
  });

  it("derives a flow extension node id that cannot collide with a block id", () => {
    expect(getFlowExtensionNodeId("card")).toBe("extension:card");
  });
});

function paragraph(id: string): TextFlowBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text: id }],
  };
}
