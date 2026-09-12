import { describe, expect, it } from "vitest";

import type { LayoutSectionNode, ParagraphNode, QuoteBlockNode } from "../model";
import { estimateBlockHeightPx } from "./page-layout";
import {
  blockSpaceAfterPx,
  blockSpaceAfterStyleVars,
  MAX_BLOCK_SPACE_AFTER_PX,
  normalizeBlockSpaceAfterPx,
  rendersBlockSpaceAfter,
} from "./block-space-after";

describe("normalizeBlockSpaceAfterPx", () => {
  it("drops 0 so a reset produces the same JSON as an untouched block", () => {
    expect(normalizeBlockSpaceAfterPx(0)).toBeUndefined();
  });

  it("rounds to whole CSS px", () => {
    expect(normalizeBlockSpaceAfterPx(12.4)).toBe(12);
  });

  it("rounds a half pixel up", () => {
    expect(normalizeBlockSpaceAfterPx(12.5)).toBe(13);
  });

  it("drops a negative value", () => {
    expect(normalizeBlockSpaceAfterPx(-3)).toBeUndefined();
  });

  it("drops a value that rounds down to 0", () => {
    expect(normalizeBlockSpaceAfterPx(0.4)).toBeUndefined();
  });

  it("clamps to the maximum instead of rejecting the document", () => {
    expect(normalizeBlockSpaceAfterPx(999)).toBe(MAX_BLOCK_SPACE_AFTER_PX);
  });

  it("keeps the maximum itself", () => {
    expect(normalizeBlockSpaceAfterPx(MAX_BLOCK_SPACE_AFTER_PX)).toBe(MAX_BLOCK_SPACE_AFTER_PX);
  });

  it("rejects a numeric string", () => {
    expect(normalizeBlockSpaceAfterPx("12")).toBeUndefined();
  });

  it("rejects NaN", () => {
    expect(normalizeBlockSpaceAfterPx(Number.NaN)).toBeUndefined();
  });

  it("rejects Infinity", () => {
    expect(normalizeBlockSpaceAfterPx(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("rejects undefined", () => {
    expect(normalizeBlockSpaceAfterPx(undefined)).toBeUndefined();
  });

  it("rejects null", () => {
    expect(normalizeBlockSpaceAfterPx(null)).toBeUndefined();
  });
});

describe("rendersBlockSpaceAfter", () => {
  it.each(["paragraph", "heading", "section", "list", "listItem", "divider"])("draws the space below %s", (type) => {
    expect(rendersBlockSpaceAfter(type)).toBe(true);
  });

  it.each(["quote", "codeBlock", "boxBlock", "layoutSection", "problem"])(
    "does not draw the space below %s (framed or non-flow)",
    (type) => {
      expect(rendersBlockSpaceAfter(type)).toBe(false);
    },
  );

  it("treats a missing type as not rendered", () => {
    expect(rendersBlockSpaceAfter(undefined)).toBe(false);
  });
});

describe("blockSpaceAfterStyleVars", () => {
  it("emits the shared custom property", () => {
    expect(blockSpaceAfterStyleVars({ type: "paragraph", spaceAfterPx: 24 }))
      .toEqual({ "--sigma-doc-space-after": "24px" });
  });

  it("emits nothing for an untouched block so the DOM is unchanged", () => {
    expect(blockSpaceAfterStyleVars({ type: "paragraph" })).toBeUndefined();
  });

  it("emits nothing for a value that normalizes away", () => {
    expect(blockSpaceAfterStyleVars({ type: "paragraph", spaceAfterPx: -5 })).toBeUndefined();
  });

  it("emits nothing for a framed block type", () => {
    expect(blockSpaceAfterStyleVars({ type: "quote", spaceAfterPx: 24 })).toBeUndefined();
  });
});

describe("blockSpaceAfterPx", () => {
  it("reports the drawn space so pagination and rendering cannot disagree", () => {
    expect(blockSpaceAfterPx({ type: "paragraph", spaceAfterPx: 24 })).toBe(24);
  });

  it("reports 0 for a type that never draws it", () => {
    expect(blockSpaceAfterPx({ type: "boxBlock", spaceAfterPx: 24 })).toBe(0);
  });

  it("reports 0 when unset", () => {
    expect(blockSpaceAfterPx({ type: "paragraph" })).toBe(0);
  });
});

describe("estimateBlockHeightPx counts the space below the block", () => {
  /**
   * 実測 (`getBoundingClientRect`) は padding を含む。DOM を持たない推定側で足さないと、
   * 余白付きの段落が並ぶほど推定が実測より短くなり、AI 挿入位置や印刷の推定フォールバックがずれる。
   */
  const paragraph: ParagraphNode = { type: "paragraph", id: "p", children: [{ type: "text", text: "本文" }] };

  it("adds the space to a paragraph", () => {
    expect(estimateBlockHeightPx({ ...paragraph, spaceAfterPx: 24 }))
      .toBe(estimateBlockHeightPx(paragraph) + 24);
  });

  it("adds nothing for a block type that never draws it", () => {
    const quote: QuoteBlockNode = {
      type: "quote",
      id: "q",
      blocks: [{ type: "paragraph", id: "qp", children: [] }],
    };

    expect(estimateBlockHeightPx({ ...quote, spaceAfterPx: 24 })).toBe(estimateBlockHeightPx(quote));
  });

  it("adds a nested block's space through the container", () => {
    const section = (child: ParagraphNode): LayoutSectionNode => ({
      type: "layoutSection",
      id: "ls",
      layout: { columnCount: 1 },
      children: [child],
    });
    const child: ParagraphNode = { type: "paragraph", id: "lp", children: [] };

    expect(estimateBlockHeightPx(section({ ...child, spaceAfterPx: 40 })))
      .toBeGreaterThan(estimateBlockHeightPx(section(child)));
  });

  it("leaves an untouched block's estimate unchanged", () => {
    expect(estimateBlockHeightPx(paragraph)).toBe(estimateBlockHeightPx({ ...paragraph }));
  });
});
