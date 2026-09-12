import { describe, expect, it } from "vitest";

import type { BoxBlockNode, ParagraphNode } from "@/features/document";

import {
  canInsertManualPageBreakAfterBlock,
  resolveManualTextPageBreakBlocks,
  shouldUseDocumentNextBlockForPageBreak,
} from "./manual-page-break";

function paragraph(id: string, text: string): ParagraphNode {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

function deterministicIdFactory() {
  let sequence = 0;
  return (prefix: string) => `${prefix}_generated_${++sequence}`;
}

describe("manual page-break application model", () => {
  it("rejects manual breaks in independent nested columns without moving ownership", () => {
    const box: BoxBlockNode = { type: "boxBlock", id: "box", styleId: "fancybox", blocks: [{
      type: "layoutSection", id: "columns", layout: { columnCount: 2, columnStartIds: ["a", "c"], columnWidths: [6500, 3500] },
      children: [paragraph("a", "first"), paragraph("b", "next"), paragraph("c", "right")],
    }] };
    const result = resolveManualTextPageBreakBlocks([box], "a", true);
    expect(result).toBeNull();
    expect(resolveManualTextPageBreakBlocks([box.blocks[0]], "a", true)).toBeNull();
  });
  it("splits text in a nested problem inside a box and removes the same boundary without changing its containers", () => {
    const box: BoxBlockNode = { type: "boxBlock", id: "box", styleId: "itembox", blocks: [
      { type: "problem", id: "problem", tags: [], lead: [], prompt: [paragraph("text", "abcdef")], hints: [], solution: [] },
    ] };
    const result = resolveManualTextPageBreakBlocks([box], "text", true, { blockId: "text", offset: 3 }, { createId: deterministicIdFactory() });
    expect(result).toMatchObject({ blocks: [{ ...box, blocks: [expect.objectContaining({ prompt: [
      paragraph("text", "abc"), { ...paragraph("p_generated_1", "def"), pagination: { break: true } },
    ] })] }], focusBlockId: "p_generated_1" });
    const removed = resolveManualTextPageBreakBlocks(result!.blocks, result!.focusBlockId, false);
    expect(removed?.blocks).toMatchObject([{ type: "boxBlock", blocks: [{ type: "problem", prompt: [
      paragraph("text", "abc"), { ...paragraph("p_generated_1", "def"), pagination: undefined },
    ] }] }]);
  });

  it("rejects an empty beginning without using later body content", () => {
    const blocks = [paragraph("blank", ""), paragraph("later", "body")];
    expect(canInsertManualPageBreakAfterBlock(blocks, "blank")).toBe(false);
    expect(canInsertManualPageBreakAfterBlock(blocks, "later")).toBe(true);
  });

  it("allows a break after body text followed by an empty line", () => {
    expect(canInsertManualPageBreakAfterBlock([
      paragraph("body", "body"), paragraph("blank", ""),
    ], "blank")).toBe(true);
  });

  it("does not create another blank page immediately after an existing boundary", () => {
    const blocks = [
      paragraph("body", "body"),
      { ...paragraph("page-start", ""), pagination: { break: true as const } },
      paragraph("blank", ""),
    ];
    expect(canInsertManualPageBreakAfterBlock(blocks, "page-start")).toBe(false);
    expect(canInsertManualPageBreakAfterBlock(blocks, "blank")).toBe(false);
    blocks.push(paragraph("next-body", "text"));
    expect(canInsertManualPageBreakAfterBlock(blocks, "next-body")).toBe(true);
  });

  it("treats a visible object as body content", () => {
    expect(canInsertManualPageBreakAfterBlock([
      { type: "divider", id: "divider" }, paragraph("blank", ""),
    ], "blank")).toBe(true);
  });

  it("splits inline content at the editor offset and requests ids through the port", () => {
    const result = resolveManualTextPageBreakBlocks(
      [paragraph("first", "abcdef")],
      "first",
      true,
      { blockId: "first", offset: 3 },
      { createId: deterministicIdFactory() },
    );

    expect(result).toEqual({
      blocks: [
        paragraph("first", "abc"),
        {
          ...paragraph("p_generated_1", "def"),
          pagination: { break: true },
        },
      ],
      focusBlockId: "p_generated_1",
      focusPosition: "start",
    });
  });

  it("uses the adjacent block at a boundary without allocating an id", () => {
    const createId = () => {
      throw new Error("id allocation is not expected");
    };
    const result = resolveManualTextPageBreakBlocks(
      [paragraph("first", "first"), paragraph("second", "second")],
      "first",
      true,
      { blockId: "first", offset: 5 },
      { createId },
    );

    expect(result?.blocks[1].pagination?.break).toBe(true);
    expect(result?.focusBlockId).toBe("second");
  });

  it("removes only break-before and preserves unrelated pagination hints", () => {
    const block = {
      ...paragraph("first", "first"),
      pagination: {
        break: true as const,
        keepWithNext: true,
      },
    };

    expect(resolveManualTextPageBreakBlocks(
      [block],
      "first",
      false,
    )?.blocks[0].pagination).toEqual({ keepWithNext: true });
    expect(resolveManualTextPageBreakBlocks(
      [paragraph("first", "first")],
      "first",
      false,
    )).toBeNull();
  });

  it("removes a manual break owned by a nested layout child", () => {
    const blocks = [{
      type: "boxBlock" as const,
      id: "box",
      styleId: "fancybox",
      blocks: [{
        type: "layoutSection" as const,
        id: "layout",
        layout: { columnCount: 2 as const },
        children: [
          paragraph("first-column", "first"),
          { ...paragraph("second-column", "second"), pagination: { break: true as const } },
        ],
      }],
    }];

    const result = resolveManualTextPageBreakBlocks(blocks, "second-column", false);

    expect(result?.blocks[0]).toMatchObject({
      type: "boxBlock",
      blocks: [{
        type: "layoutSection",
        children: [{ id: "first-column" }, { id: "second-column", pagination: undefined }],
      }],
    });
  });

  it("defers only edge selections at the final chunk block", () => {
    const blocks = [paragraph("first", "abc")];
    const detail = {
      blockId: "first",
      enabled: true,
      documentNextBlockId: "next-chunk",
    };

    expect(shouldUseDocumentNextBlockForPageBreak(
      blocks,
      detail,
      { blockId: "first", offset: 0 },
    )).toBe(true);
    expect(shouldUseDocumentNextBlockForPageBreak(
      blocks,
      detail,
      { blockId: "first", offset: 2 },
    )).toBe(false);
  });
});
