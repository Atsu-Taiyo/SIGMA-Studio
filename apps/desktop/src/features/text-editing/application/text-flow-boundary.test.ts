import { describe, expect, it } from "vitest";

import type { RichBlock, SigmaBlock } from "@/features/document";

import { resolveTextFlowBoundaryDelete } from "./text-flow-boundary";

describe("resolveTextFlowBoundaryDelete", () => {
  it("removes an empty block and focuses the neighbor in the requested direction", () => {
    const content: SigmaBlock[] = [
      paragraph("before", "前"),
      paragraph("empty", ""),
      paragraph("after", "後"),
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty",
      direction: "backward",
      emptyBlock: false,
    })).toEqual({
      previousIds: ["empty"],
      nextBlocks: [],
      focusBlockId: "before",
      focusPosition: "end",
      activeIds: ["before"],
    });
    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty",
      direction: "forward",
      emptyBlock: false,
    })).toEqual({
      previousIds: ["empty"],
      nextBlocks: [],
      focusBlockId: "after",
      focusPosition: "start",
      activeIds: ["after"],
    });
  });

  it("merges adjacent rich blocks while preserving the target block identity and attributes", () => {
    const content: SigmaBlock[] = [
      {
        ...paragraph("first", "A"),
        align: "center",
      },
      paragraph("second", "B"),
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "second",
      direction: "backward",
      emptyBlock: false,
    })).toEqual({
      previousIds: ["first", "second"],
      nextBlocks: [{
        ...paragraph("first", ""),
        align: "center",
        children: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      }],
      focusBlockId: "first",
      focusPosition: "end",
      activeIds: ["first"],
    });
  });

  it("keeps a manual break on Backspace and only moves to the previous block", () => {
    const content: SigmaBlock[] = [
      paragraph("before", "前"),
      {
        ...paragraph("after_break", "後"),
        pagination: { break: true },
      },
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "after_break",
      direction: "backward",
      emptyBlock: false,
    })).toEqual({
      previousIds: [],
      nextBlocks: [],
      focusBlockId: "before",
      focusPosition: "end",
      activeIds: ["before"],
    });
  });

  it("keeps a manual break on Delete and only moves to the following block", () => {
    const content: SigmaBlock[] = [
      paragraph("before", "前"),
      {
        ...paragraph("after_break", "後"),
        pagination: { break: true },
      },
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "before",
      direction: "forward",
      emptyBlock: false,
    })).toEqual({
      previousIds: [],
      nextBlocks: [],
      focusBlockId: "after_break",
      focusPosition: "start",
      activeIds: ["after_break"],
    });
  });

  it("does not delete an empty block that carries a manual break on Backspace", () => {
    const content: SigmaBlock[] = [
      paragraph("before", "前"),
      {
        ...paragraph("empty_after_break", ""),
        pagination: { break: true },
      },
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty_after_break",
      direction: "backward",
      emptyBlock: true,
    })?.previousIds).toEqual([]);
  });

  it("does not delete an empty block with a manual break at the start of a flow", () => {
    const current = {
      ...paragraph("empty_break_at_start", ""),
      pagination: { break: true as const },
    };

    expect(resolveTextFlowBoundaryDelete([current], {
      blockId: current.id,
      direction: "backward",
      emptyBlock: true,
    })).toEqual({
      previousIds: [],
      nextBlocks: [],
      focusBlockId: current.id,
      focusPosition: "start",
      activeIds: [current.id],
    });
  });

  it("treats nested empty box content as empty but refuses to merge structural blocks", () => {
    const emptyBox: SigmaBlock = {
      id: "box",
      type: "boxBlock",
      styleId: "frame",
      title: [],
      blocks: [{
        id: "nested_layout",
        type: "layoutSection",
        layout: { columnCount: 2 },
        children: [paragraph("nested_empty", "")],
      }],
    };
    const content = [paragraph("before", "前"), emptyBox, paragraph("after", "後")];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "box",
      direction: "backward",
      emptyBlock: false,
    })?.previousIds).toEqual(["box"]);
    expect(resolveTextFlowBoundaryDelete([
      paragraph("before", "前"),
      { ...emptyBox, title: [{ type: "text", text: "箱" }] },
    ], {
      blockId: "box",
      direction: "backward",
      emptyBlock: false,
    })).toBeNull();
  });

  it("moves the caret into an adjacent problem instead of merging body text into it", () => {
    const content: SigmaBlock[] = [
      paragraph("before", "前"),
      problem("problem", {
        lead: [paragraph("lead_body", "導")],
        prompt: [paragraph("prompt_body", "問")],
      }),
      paragraph("after", "後"),
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "after",
      direction: "backward",
      emptyBlock: false,
    })).toEqual({
      previousIds: [],
      nextBlocks: [],
      focusBlockId: "prompt_body",
      focusPosition: "end",
      activeIds: ["prompt_body"],
    });
    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "before",
      direction: "forward",
      emptyBlock: false,
    })).toEqual({
      previousIds: [],
      nextBlocks: [],
      focusBlockId: "lead_body",
      focusPosition: "start",
      activeIds: ["lead_body"],
    });
  });

  it("removes an empty block whose only neighbor is a problem", () => {
    const content: SigmaBlock[] = [
      problem("first", { prompt: [paragraph("first_prompt", "問1")] }),
      paragraph("empty", ""),
      problem("second", {
        lead: [paragraph("second_lead", "導2")],
        prompt: [paragraph("second_prompt", "問2")],
      }),
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty",
      direction: "backward",
      emptyBlock: true,
    })).toEqual({
      previousIds: ["empty"],
      nextBlocks: [],
      focusBlockId: "first_prompt",
      focusPosition: "end",
      activeIds: ["first_prompt"],
    });
    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty",
      direction: "forward",
      emptyBlock: true,
    })).toEqual({
      previousIds: ["empty"],
      nextBlocks: [],
      focusBlockId: "second_lead",
      focusPosition: "start",
      activeIds: ["second_lead"],
    });
  });

  it("removes an empty block sitting above the first problem", () => {
    const content: SigmaBlock[] = [
      paragraph("empty", ""),
      problem("problem", { prompt: [paragraph("prompt_body", "問")] }),
    ];

    // Backspace has no previous block at all, so it falls forward onto the problem —
    // and lands on the always-rendered lead area, which here is the derived placeholder.
    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty",
      direction: "backward",
      emptyBlock: true,
    })).toEqual({
      previousIds: ["empty"],
      nextBlocks: [],
      focusBlockId: "problem_lead_empty",
      focusPosition: "start",
      activeIds: ["problem_lead_empty"],
    });
  });

  it("targets the derived placeholder block when the neighboring area is empty", () => {
    const content: SigmaBlock[] = [
      problem("problem", {}),
      paragraph("empty", ""),
    ];

    expect(resolveTextFlowBoundaryDelete(content, {
      blockId: "empty",
      direction: "backward",
      emptyBlock: true,
    })).toEqual({
      previousIds: ["empty"],
      nextBlocks: [],
      focusBlockId: "problem_prompt_empty",
      focusPosition: "end",
      activeIds: ["problem_prompt_empty"],
    });
  });

  it("keeps the last block of a document that has nothing to fall back to", () => {
    expect(resolveTextFlowBoundaryDelete([paragraph("only", "")], {
      blockId: "only",
      direction: "backward",
      emptyBlock: true,
    })).toBeNull();
  });
});

function problem(
  id: string,
  areas: Partial<Record<"lead" | "prompt" | "hints" | "solution", RichBlock[]>>,
): Extract<SigmaBlock, { type: "problem" }> {
  return {
    id,
    type: "problem",
    tags: [],
    lead: areas.lead ?? [],
    prompt: areas.prompt ?? [],
    hints: areas.hints ?? [],
    solution: areas.solution ?? [],
  };
}

function paragraph(id: string, text: string): Extract<SigmaBlock, { type: "paragraph" }> {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}
