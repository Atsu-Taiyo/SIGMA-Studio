import { describe, expect, it } from "vitest";

import type { SigmaTextRangeCommentAnchor } from "@/features/document";

import {
  EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT,
  getTextRangeForBlock,
} from ".";

function anchor(
  startBlockId: string,
  startOffset: number,
  endBlockId: string,
  endOffset: number,
): SigmaTextRangeCommentAnchor {
  return {
    type: "textRange",
    start: { blockId: startBlockId, offset: startOffset },
    end: { blockId: endBlockId, offset: endOffset },
    quote: "selection",
  };
}

describe("text-editing external range projection", () => {
  const order = new Map([["a", 0], ["b", 1], ["c", 2]]);

  it("preserves the public host event name", () => {
    expect(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT).toBe("sigma-studio:ai-reference-text-range");
  });

  it("clamps a same-block range to the block length", () => {
    expect(getTextRangeForBlock(anchor("a", 2, "a", 20), "a", order, 8)).toEqual({ from: 2, to: 8 });
  });

  it("covers the middle and boundary portions of a multi-block range", () => {
    const value = anchor("a", 3, "c", 4);
    expect(getTextRangeForBlock(value, "a", order, 10)).toEqual({ from: 3, to: 10 });
    expect(getTextRangeForBlock(value, "b", order, 7)).toEqual({ from: 0, to: 7 });
    expect(getTextRangeForBlock(value, "c", order, 9)).toEqual({ from: 0, to: 4 });
  });

  it("normalizes reversed selections and rejects missing or empty ranges", () => {
    expect(getTextRangeForBlock(anchor("c", 4, "a", 3), "b", order, 7)).toEqual({ from: 0, to: 7 });
    expect(getTextRangeForBlock(anchor("missing", 0, "a", 1), "a", order, 7)).toBeNull();
    expect(getTextRangeForBlock(anchor("a", 2, "a", 2), "a", order, 7)).toBeNull();
  });
});
