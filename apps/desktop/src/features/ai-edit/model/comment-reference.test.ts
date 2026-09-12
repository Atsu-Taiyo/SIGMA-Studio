import { describe, expect, it } from "vitest";

import type { SigmaCommentAnchor } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { buildCommentAiReference } from "./comment-reference";

const document = {
  version: "2.0",
  docId: "doc-comment-reference",
  metadata: { title: "コメント参照" },
  content: [
    { id: "p_1", type: "paragraph", children: [{ type: "text", text: "一" }] },
    {
      id: "p_2",
      type: "paragraph",
      children: [
        { type: "text", text: "式" },
        { id: "math_1", type: "mathInline", tex: "x+1" },
      ],
    },
    { id: "p_3", type: "paragraph", children: [{ type: "text", text: "三" }] },
  ],
  outputProfiles: {},
} as SigmaDocument;

describe("buildCommentAiReference", () => {
  it("keeps a comment's multi-block text range in the AI reference", () => {
    const anchor = {
      type: "textRange" as const,
      start: { blockId: "p_1", offset: 0 },
      end: { blockId: "p_3", offset: 0 },
      quote: "一\n二",
    };

    const result = buildCommentAiReference(document, anchor);

    expect(result).toMatchObject({
      selectedId: "p_1",
      reference: {
        kind: "textSelection",
        textRange: anchor,
        selectedBlockIds: ["p_1", "p_2"],
      },
    });
  });

  it("keeps inline-math identity and TeX in the AI reference", () => {
    const anchor: SigmaCommentAnchor = {
      type: "inlineMath",
      blockId: "p_2",
      mathInlineId: "math_1",
      tex: "x+1",
    };

    expect(buildCommentAiReference(document, anchor)).toMatchObject({
      selectedId: "p_2",
      reference: {
        kind: "inlineMath",
        targetId: "p_2",
        mathInlineId: "math_1",
        tex: "x+1",
      },
    });
  });

  it("creates a block reference for a block anchor", () => {
    const anchor: SigmaCommentAnchor = {
      type: "block",
      blockId: "p_3",
    };

    expect(buildCommentAiReference(document, anchor)).toMatchObject({
      selectedId: "p_3",
      reference: {
        kind: "block",
        targetId: "p_3",
      },
    });
  });

  it.each<SigmaCommentAnchor>([
    { type: "overlayShape", shapeIds: ["shape_1"] },
    { type: "overlayMath", shapeId: "shape_1", tex: "x+1" },
  ])("does not invent a block reference for a $type anchor", (anchor) => {
    expect(buildCommentAiReference(document, anchor)).toEqual({
      selectedId: null,
      reference: null,
    });
  });
});
