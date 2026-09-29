import { describe, expect, it } from "vitest";

import type { BoxBlockNode, LayoutSectionNode, ParagraphNode, ProblemNode, QuoteBlockNode, SigmaBlock } from "@/features/document";

import {
  canInsertManualPageBreakAt,
  collectManualBreakHostIds,
  findManualBreakOwnerAfterBlock,
  findManualBreakOwnerAtBlockStart,
  findManualBreakOwnerForBlock,
  isManualBreakAllowedAtBlock,
  resolveManualBreakHoistTarget,
} from "./manual-break-rules";

const BREAK = { pagination: { break: true as const } };

function paragraph(id: string, text = id, extra: Partial<ParagraphNode> = {}): ParagraphNode {
  return { type: "paragraph", id, children: text ? [{ type: "text", text }] : [], ...extra };
}

function quote(id: string, blocks: ParagraphNode[], extra: Partial<QuoteBlockNode> = {}): QuoteBlockNode {
  return { type: "quote", id, blocks, ...extra };
}

function box(id: string, blocks: SigmaBlock[], extra: Partial<BoxBlockNode> = {}): BoxBlockNode {
  return { type: "boxBlock", id, styleId: "fancybox", blocks, ...extra };
}

function columns(id: string, children: ParagraphNode[], columnCount: number): LayoutSectionNode {
  return { type: "layoutSection", id, layout: { columnCount }, children };
}

function problem(id: string, prompt: ParagraphNode[], extra: Partial<ProblemNode> = {}): ProblemNode {
  return { type: "problem", id, tags: [], lead: [], prompt, hints: [], solution: [], ...extra };
}

describe("where a manual break may live", () => {
  it("accepts every block of the body flow, including quotes, boxes, problems and one-column sections", () => {
    const blocks: SigmaBlock[] = [
      paragraph("top"),
      quote("quote", [paragraph("quoted")]),
      box("box", [paragraph("boxed"), box("inner", [paragraph("deep")])]),
      problem("problem", [paragraph("prompt")]),
      columns("single", [paragraph("single-child")], 1),
    ];
    for (const id of ["top", "quote", "quoted", "box", "boxed", "inner", "deep", "problem", "prompt", "single", "single-child"]) {
      expect(isManualBreakAllowedAtBlock(blocks, id), id).toBe(true);
    }
  });

  it("rejects independent multi-column sections, at any depth, and unknown ids", () => {
    const blocks: SigmaBlock[] = [
      columns("cols", [paragraph("left"), paragraph("right")], 2),
      box("box", [columns("box-cols", [paragraph("box-left")], 2)]),
    ];
    expect(isManualBreakAllowedAtBlock(blocks, "cols")).toBe(true);
    expect(isManualBreakAllowedAtBlock(blocks, "left")).toBe(false);
    expect(isManualBreakAllowedAtBlock(blocks, "box-left")).toBe(false);
    expect(isManualBreakAllowedAtBlock(blocks, "missing")).toBe(false);
  });
});

describe("which break sits next to a block", () => {
  const blocks: SigmaBlock[] = [
    paragraph("a"),
    paragraph("b"),
    quote("quote", [paragraph("q1"), paragraph("q2"), paragraph("q3", "q3", BREAK), paragraph("q4")], BREAK),
    paragraph("c"),
    box("titled", [paragraph("t1")], { title: [{ type: "text", text: "Title" }], ...BREAK }),
    paragraph("d", "d", BREAK),
    problem("problem", [paragraph("p1"), paragraph("p2")], BREAK),
  ];

  it("finds the break at a block start through the containers that start with it", () => {
    expect(findManualBreakOwnerAtBlockStart(blocks, "q1")).toBe("quote");
    expect(findManualBreakOwnerAtBlockStart(blocks, "q3")).toBe("q3");
    expect(findManualBreakOwnerAtBlockStart(blocks, "q2")).toBeNull();
    // A titled box starts with its title, not with its first body block.
    expect(findManualBreakOwnerAtBlockStart(blocks, "t1")).toBeNull();
    // The prompt is the first shown area only after an empty lead area.
    expect(findManualBreakOwnerAtBlockStart(blocks, "p1")).toBeNull();
  });

  it("finds the break right after a block and its contents", () => {
    expect(findManualBreakOwnerAfterBlock(blocks, "b")).toBe("quote");
    expect(findManualBreakOwnerAfterBlock(blocks, "q2")).toBe("q3");
    expect(findManualBreakOwnerAfterBlock(blocks, "quote")).toBeNull();
    expect(findManualBreakOwnerAfterBlock(blocks, "q4")).toBeNull();
    expect(findManualBreakOwnerAfterBlock(blocks, "t1")).toBe("d");
    expect(findManualBreakOwnerAfterBlock(blocks, "d")).toBe("problem");
  });

  it("offers only the own, enclosing or following break for removal", () => {
    expect(findManualBreakOwnerForBlock(blocks, "a")).toBeNull();
    expect(findManualBreakOwnerForBlock(blocks, "b")).toBe("quote");
    expect(findManualBreakOwnerForBlock(blocks, "q2")).toBe("quote");
    expect(findManualBreakOwnerForBlock(blocks, "q3")).toBe("q3");
    expect(findManualBreakOwnerForBlock(blocks, "t1")).toBe("titled");
    expect(findManualBreakOwnerForBlock(blocks, "p2")).toBe("problem");
  });
});

describe("inserting at the caret", () => {
  it("hoists a break at the start of a container's first child to the container", () => {
    const blocks: SigmaBlock[] = [
      paragraph("before"),
      quote("quote", [paragraph("q1"), paragraph("q2")]),
      box("box", [columns("single", [paragraph("deep")], 1)]),
      problem("problem", [paragraph("prompt")]),
    ];
    expect(resolveManualBreakHoistTarget(blocks, "q1")).toBe("quote");
    expect(resolveManualBreakHoistTarget(blocks, "q2")).toBe("q2");
    expect(resolveManualBreakHoistTarget(blocks, "deep")).toBe("box");
    // A problem area's first block is "before that area", not before the whole problem.
    expect(resolveManualBreakHoistTarget(blocks, "prompt")).toBe("prompt");
  });

  it("refuses a break that would leave an empty page or column before it", () => {
    const blocks: SigmaBlock[] = [
      paragraph("blank", ""),
      paragraph("first"),
      paragraph("after-break", "", BREAK),
      quote("quote", [paragraph("q1"), paragraph("q2")]),
    ];
    expect(canInsertManualPageBreakAt(blocks, { blockId: "blank", offset: 0 })).toBe(false);
    expect(canInsertManualPageBreakAt(blocks, { blockId: "first", offset: 0 })).toBe(false);
    expect(canInsertManualPageBreakAt(blocks, { blockId: "first", offset: 2 })).toBe(true);
    expect(canInsertManualPageBreakAt(blocks, { blockId: "first" })).toBe(true);
    // Already at the head of a page.
    expect(canInsertManualPageBreakAt(blocks, { blockId: "after-break", offset: 0 })).toBe(false);
    // Only an empty line since the last break: the quote's first line is still the head of the page.
    expect(canInsertManualPageBreakAt(blocks, { blockId: "q1", offset: 0 })).toBe(false);
    expect(canInsertManualPageBreakAt(blocks, { blockId: "q2", offset: 0 })).toBe(true);
  });

  it("counts a visible box frame as body but not an empty quote or problem shell", () => {
    expect(canInsertManualPageBreakAt([box("box", [paragraph("inner", "")]), paragraph("next", "")], { blockId: "next", offset: 0 })).toBe(true);
    expect(canInsertManualPageBreakAt([quote("quote", [paragraph("inner", "")]), paragraph("next", "")], { blockId: "next", offset: 0 })).toBe(false);
  });
});

describe("collectManualBreakHostIds", () => {
  it("lists only the containers that hold a nested break", () => {
    const blocks: SigmaBlock[] = [
      quote("plain_quote", [paragraph("p1")]),
      quote("broken_quote", [paragraph("p2"), paragraph("p3", "p3", BREAK)]),
      box("outer", [box("inner", [paragraph("p4"), paragraph("p5", "p5", BREAK)])]),
      paragraph("top", "top", BREAK),
    ];
    expect([...collectManualBreakHostIds(blocks)].sort()).toEqual(["broken_quote", "inner", "outer"]);
  });
});
