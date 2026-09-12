import { describe, expect, it } from "vitest";

import {
  createTextCommentAnchor,
  getCommentAnchorLabel,
  getCommentAnchorQuote,
  getCommentThreadsForBlock,
  getCommentThreadsForOverlayShape,
  isCommentAnchorOrphan,
} from "@/lib/comments";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaCommentThread, SigmaDocument } from "@/types/sigma-doc";

describe("comments", () => {
  it("creates normalized text range anchors with unique math references", () => {
    const anchor = createTextCommentAnchor({
      startBlockId: "p_start",
      startOffset: 4.8,
      endBlockId: "p_end",
      endOffset: -2,
      quote: "x",
      mathInlineIds: ["m_1", "m_1", ""],
      mathTex: ["x^2", "x^2", " "],
    });

    expect(anchor).toMatchObject({
      type: "textRange",
      start: { blockId: "p_start", offset: 4 },
      end: { blockId: "p_end", offset: 0 },
      mathInlineIds: ["m_1"],
      mathTex: ["x^2"],
    });
  });

  it("keeps comments as orphans when their targets disappear", () => {
    const document: SigmaDocument = {
      ...sampleDocument,
      content: [
        {
          type: "paragraph",
          id: "p_alive",
          children: [{ type: "text", text: "本文" }],
        },
      ],
    };

    expect(isCommentAnchorOrphan(document, { type: "block", blockId: "missing" })).toBe(true);
    expect(getCommentAnchorLabel({ type: "block", blockId: "missing" }, document)).toBe("対象なし");
    expect(isCommentAnchorOrphan(document, { type: "overlayMath", tex: "x" })).toBe(false);
    expect(getCommentAnchorLabel({ type: "overlayMath", tex: "x" }, document)).toBe("図中数式");
    expect(getCommentAnchorQuote({ type: "overlayMath", tex: "x" })).toBe("x");
  });

  it("returns block comment threads including inline math and text range endpoints", () => {
    const threads: SigmaCommentThread[] = [
      {
        id: "thread_block",
        anchor: { type: "block", blockId: "p_1" },
        messages: [{ id: "message_block", body: [{ type: "text", text: "a" }], createdAt: "2026-06-16T00:00:00.000Z" }],
        createdAt: "2026-06-16T00:00:00.000Z",
      },
      {
        id: "thread_math",
        anchor: { type: "inlineMath", blockId: "p_1", mathInlineId: "m_1" },
        messages: [{ id: "message_math", body: [{ type: "text", text: "b" }], createdAt: "2026-06-16T00:00:00.000Z" }],
        createdAt: "2026-06-16T00:00:00.000Z",
      },
      {
        id: "thread_range",
        anchor: {
          type: "textRange",
          start: { blockId: "p_1", offset: 0 },
          end: { blockId: "p_2", offset: 3 },
          quote: "abc",
        },
        messages: [{ id: "message_range", body: [{ type: "text", text: "c" }], createdAt: "2026-06-16T00:00:00.000Z" }],
        createdAt: "2026-06-16T00:00:00.000Z",
      },
    ];

    expect(getCommentThreadsForBlock(threads, "p_1").map((thread) => thread.id)).toEqual([
      "thread_block",
      "thread_math",
      "thread_range",
    ]);
  });

  it("returns overlay shape threads including overlay math anchored to the same shape", () => {
    const threads: SigmaCommentThread[] = [
      {
        id: "thread_shape",
        anchor: { type: "overlayShape", shapeIds: ["shape_1"] },
        messages: [{ id: "message_shape", body: [{ type: "text", text: "a" }], createdAt: "2026-06-16T00:00:00.000Z" }],
        createdAt: "2026-06-16T00:00:00.000Z",
      },
      {
        id: "thread_overlay_math",
        anchor: { type: "overlayMath", shapeId: "shape_1", mathInlineId: "m_overlay", tex: "x^2" },
        messages: [{ id: "message_overlay_math", body: [{ type: "text", text: "b" }], createdAt: "2026-06-16T00:00:00.000Z" }],
        createdAt: "2026-06-16T00:00:00.000Z",
      },
    ];

    expect(getCommentThreadsForOverlayShape(threads, "shape_1").map((thread) => thread.id)).toEqual([
      "thread_shape",
      "thread_overlay_math",
    ]);
  });
});
