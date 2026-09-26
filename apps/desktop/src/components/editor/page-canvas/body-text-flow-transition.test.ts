import { describe, expect, it } from "vitest";

import type {
  LayoutSectionNode,
  ProblemNode,
  SigmaBlock,
} from "@/types/sigma-doc";

import type { TextFlowBlock } from "../text-flow/types";
import { findFragmentTextFlowOwner, resolveBodyTextFlowTransition } from "./body-text-flow-transition";

describe("body TextFlow transition", () => {
  it("keeps an edit in its independent layout column", () => {
    const left = paragraph("left", "left");
    const right = paragraph("right", "right");
    const section: LayoutSectionNode = {
      id: "columns",
      type: "layoutSection",
      layout: { columnCount: 2, columnStartIds: ["left", "right"], columnWidths: [6000, 4000] },
      children: [left, right],
    };
    const transition = resolveBodyTextFlowTransition([section], {
      scope: "layoutSection",
      targetId: section.id,
      previousIds: [left.id],
      nextBlocks: [paragraph("left", "changed"), paragraph("left-new", "new line")],
    });

    const result = transition.reduce(section);
    expect(result.type).toBe("layoutSection");
    if (result.type !== "layoutSection") return;
    expect(result.layout.columnStartIds).toEqual(["left", "right"]);
    expect(result.layout.columnWidths).toEqual([6000, 4000]);
    expect(result.children.map((block) => block.id)).toEqual(["left", "left-new", "right"]);
  });

  it("replaces only the edited span and preserves every other block in the column", () => {
    const leftHead = paragraph("left-head", "head");
    const edited = paragraph("edited", "old");
    const leftTail = paragraph("left-tail", "tail");
    const rightHead = paragraph("right-head", "right");
    const section: LayoutSectionNode = {
      id: "columns",
      type: "layoutSection",
      layout: { columnCount: 2, columnStartIds: ["left-head", "right-head"], columnWidths: [6000, 4000] },
      children: [leftHead, edited, leftTail, rightHead],
    };
    const transition = resolveBodyTextFlowTransition([section], {
      scope: "layoutSection",
      targetId: section.id,
      previousIds: [edited.id],
      nextBlocks: [paragraph("edited", "changed"), paragraph("inserted", "new")],
    });

    const result = transition.reduce(section);
    expect(result.type).toBe("layoutSection");
    if (result.type !== "layoutSection") return;
    expect(result.layout.columnCount).toBe(2);
    expect(result.layout.columnStartIds).toEqual(["left-head", "right-head"]);
    expect(result.children.map((block) => block.id)).toEqual([
      "left-head",
      "edited",
      "inserted",
      "left-tail",
      "right-head",
    ]);
  });

  it("keeps one non-empty child in every column when its last edited block is removed", () => {
    const left = paragraph("left", "left");
    const right = paragraph("right", "right");
    const section: LayoutSectionNode = {
      id: "columns",
      type: "layoutSection",
      layout: { columnCount: 2, columnStartIds: ["left", "right"], columnWidths: [5000, 5000] },
      children: [left, right],
    };
    const transition = resolveBodyTextFlowTransition([section], {
      scope: "layoutSection",
      targetId: section.id,
      previousIds: [left.id],
      nextBlocks: [],
    });

    const result = transition.reduce(section);
    expect(result.type).toBe("layoutSection");
    if (result.type !== "layoutSection") return;
    expect(result.layout.columnCount).toBe(2);
    expect(result.layout.columnStartIds).toHaveLength(2);
    expect(result.children.at(-1)).toBe(right);
  });

  it("does not move a surviving left-column tail when the right-column start is deleted", () => {
    const leftHead = paragraph("left-head", "head");
    const leftTail = paragraph("left-tail", "tail");
    const rightHead = paragraph("right-head", "right head");
    const rightTail = paragraph("right-tail", "right tail");
    const section: LayoutSectionNode = {
      id: "columns",
      type: "layoutSection",
      layout: { columnCount: 2, columnStartIds: ["left-head", "right-head"], columnWidths: [6000, 4000] },
      children: [leftHead, leftTail, rightHead, rightTail],
    };
    const transition = resolveBodyTextFlowTransition([section], {
      scope: "layoutSection",
      targetId: section.id,
      previousIds: [rightHead.id, rightTail.id],
      nextBlocks: [rightTail],
    });

    const result = transition.reduce(section);
    expect(result.type).toBe("layoutSection");
    if (result.type !== "layoutSection") return;
    expect(result.layout.columnStartIds).toEqual(["left-head", "right-tail"]);
    expect(result.children.map((block) => block.id)).toEqual([
      "left-head",
      "left-tail",
      "right-tail",
    ]);
  });

  it("keeps document reconciliation pure and reuses unchanged problem-area children", () => {
    const target = paragraph("target", "same");
    const problem = problemNode("problem", {
      prompt: [target],
    });
    const content: SigmaBlock[] = [
      paragraph("outside", "outside"),
      problem,
    ];
    const transition = resolveBodyTextFlowTransition(content, {
      scope: "problemArea",
      targetId: problem.id,
      area: "prompt",
      previousIds: [target.id],
      nextBlocks: [structuredClone(target)],
    });

    expect(transition.targetId).toBe(problem.id);
    expect(transition.reduce(content[0])).toBe(content[0]);

    const result = transition.reduce(problem);
    expect(result).not.toBe(problem);
    expect(result.type).toBe("problem");
    if (result.type !== "problem") {
      return;
    }
    expect(result.prompt).toBe(problem.prompt);
    expect(result.prompt[0]).toBe(target);
    expect(result.lead).toBe(problem.lead);
    expect(content[1]).toBe(problem);
  });

  it("keeps a problem-area box block with its rich title, body, frame, and ids", () => {
    const target = paragraph("target", "置換前");
    const problem = problemNode("problem", {
      prompt: [target],
    });
    const box: TextFlowBlock = {
      id: "box",
      type: "boxBlock",
      styleId: "itembox",
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
          id: "box_title_math",
          tex: "x^2",
          display: "inline",
        },
      ],
      blocks: [paragraph("box_body", "箱の本文")],
      frame: {
        borderColor: "#2563eb",
        titlePosition: "c",
      },
      pagination: { break: true },
    };
    const transition = resolveBodyTextFlowTransition([problem], {
      scope: "problemArea",
      targetId: problem.id,
      area: "prompt",
      previousIds: [target.id],
      nextBlocks: [box],
    });

    const result = transition.reduce(problem);
    expect(result.type).toBe("problem");
    if (result.type !== "problem") {
      return;
    }
    expect(result.prompt).toEqual([box]);
    expect(result.prompt[0]?.id).toBe("box");
    expect(result.prompt[0]?.type === "boxBlock" ? result.prompt[0].blocks[0]?.id : null)
      .toBe("box_body");
  });

  it("reserves ids outside the edited problem range and preserves problem-area conversion", () => {
    const reservedLayout: LayoutSectionNode = {
      id: "outside_layout",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [paragraph("reserved_nested", "outside")],
    };
    const target = paragraph("target", "old");
    const problem = problemNode("problem", {
      prompt: [target],
    });
    const section: TextFlowBlock = {
      id: "reserved_nested",
      type: "section",
      title: "見出し",
      align: "center",
      lineHeight: "1.6",
    };
    const transition = resolveBodyTextFlowTransition(
      [reservedLayout, problem],
      {
        scope: "problemArea",
        targetId: problem.id,
        area: "prompt",
        previousIds: [target.id],
        nextBlocks: [section],
      },
    );

    const result = transition.reduce(problem);
    expect(result.type).toBe("problem");
    if (result.type !== "problem") {
      return;
    }
    expect(result.prompt).toHaveLength(1);
    expect(result.prompt[0]).toMatchObject({
      type: "heading",
      level: 1,
      children: [{ type: "text", text: "見出し" }],
      align: "center",
      lineHeight: "1.6",
    });
    expect(result.prompt[0]?.id).not.toBe("reserved_nested");
    expect(result.prompt[0]?.id).toMatch(/^heading_/);
    expect(reservedLayout.children[0]?.id).toBe("reserved_nested");
  });

  it("reserves deeply nested ids while allowing edited layout child ids to remain", () => {
    const external: SigmaBlock = {
      id: "outside_box",
      type: "boxBlock",
      styleId: "frame",
      blocks: [{
        id: "outside_nested_layout",
        type: "layoutSection",
        layout: { columnCount: 2 },
        children: [{
          id: "outside_list",
          type: "list",
          listType: "bullet",
          items: [{
            id: "reserved_deep",
            type: "listItem",
            children: [{ type: "text", text: "outside" }],
          }],
        }],
      }],
    };
    const edited = paragraph("edited", "old");
    const untouched = paragraph("untouched", "same");
    const section: LayoutSectionNode = {
      id: "target_layout",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [edited, untouched],
    };
    const transition = resolveBodyTextFlowTransition([external, section], {
      scope: "layoutSection",
      targetId: section.id,
      previousIds: [edited.id],
      nextBlocks: [
        paragraph("edited", "new"),
        paragraph("reserved_deep", "collision"),
      ],
    });

    const result = transition.reduce(section);
    expect(result.type).toBe("layoutSection");
    if (result.type !== "layoutSection") {
      return;
    }
    expect(result.children).toHaveLength(3);
    expect(result.children[0]).toMatchObject({
      id: "edited",
      type: "paragraph",
      children: [{ type: "text", text: "new" }],
    });
    expect(result.children[1]?.id).not.toBe("reserved_deep");
    expect(result.children[1]?.id).toMatch(/^p_/);
    expect(result.children[2]).toBe(untouched);

    const nestedLayout = external.type === "boxBlock"
      ? external.blocks[0]
      : null;
    expect(
      nestedLayout?.type === "layoutSection"
        ? nestedLayout.children[0]?.type === "list"
          ? nestedLayout.children[0].items[0]?.id
          : null
        : null,
    ).toBe("reserved_deep");
  });

  it("keeps a layout section non-empty after its last child is removed", () => {
    const target = paragraph("target", "remove");
    const section: LayoutSectionNode = {
      id: "target_layout",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [target],
    };
    const transition = resolveBodyTextFlowTransition([section], {
      scope: "layoutSection",
      targetId: section.id,
      previousIds: [target.id],
      nextBlocks: [],
    });

    const result = transition.reduce(section);
    expect(result).not.toBe(section);
    expect(result.type).toBe("layoutSection");
    if (result.type !== "layoutSection") {
      return;
    }
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      type: "paragraph",
      children: [],
    });
    expect(result.children[0]?.id).toMatch(/^p_/);
  });
});

function paragraph(
  id: string,
  text: string,
): Extract<SigmaBlock, { type: "paragraph" }> {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

function problemNode(
  id: string,
  areas: Partial<Pick<ProblemNode, "lead" | "prompt" | "hints" | "solution">>,
): ProblemNode {
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

describe("fragment structural edits", () => {
  it("keeps new siblings when Enter exits a continued box", () => {
    const inner = { type: "boxBlock" as const, styleId: "fancybox", id: "inner", title: [], blocks: [paragraph("body", "before")] };
    const outer = { type: "boxBlock" as const, styleId: "fancybox", id: "outer", title: [], blocks: [inner, paragraph("after", "after")] };
    const owner = findFragmentTextFlowOwner([outer], inner.id);
    expect(owner).toEqual({ scope: "boxBlock", targetId: "outer" });
    if (!owner || owner.scope === "document") throw new Error("expected a container");
    const transition = resolveBodyTextFlowTransition([outer], {
      ...owner, previousIds: [inner.id], nextBlocks: [inner, paragraph("new", "new paragraph")],
    });
    const result = transition.reduce(outer);
    expect(result.type).toBe("boxBlock");
    if (result.type !== "boxBlock") return;
    expect(result.blocks.map((block) => block.id)).toEqual(["inner", "new", "after"]);
    expect(result.blocks[0]).toBe(inner);
  });

  it("resolves the nearest problem area through nested boxes", () => {
    const problem: ProblemNode = problemNode("problem", { prompt: [paragraph("body", "before")] });
    const outer = { type: "boxBlock" as const, styleId: "fancybox", id: "outer", title: [], blocks: [problem] };
    expect(findFragmentTextFlowOwner([outer], "body")).toEqual({ scope: "problemArea", targetId: "problem", area: "prompt" });
    expect(findFragmentTextFlowOwner([outer], "outer")).toEqual({ scope: "document" });
    expect(findFragmentTextFlowOwner([outer], "missing")).toBeNull();
  });

  it("replaces a continued column paragraph with all of its split paragraphs in that column", () => {
    const section: LayoutSectionNode = {
      type: "layoutSection", id: "columns", layout: { columnCount: 2, columnStartIds: ["left", "right"], columnWidths: [6000, 4000] },
      children: [paragraph("left", "left"), paragraph("right", "right")],
    };
    const owner = findFragmentTextFlowOwner([section], "left");
    expect(owner).toEqual({ scope: "layoutSection", targetId: "columns" });
    if (!owner || owner.scope === "document") throw new Error("expected a container");
    const transition = resolveBodyTextFlowTransition([section], {
      ...owner, previousIds: ["left"], nextBlocks: [paragraph("left", "left"), paragraph("new", "new")],
    });
    const result = transition.reduce(section);
    if (result.type !== "layoutSection") throw new Error("expected columns");
    expect(result.children.map((block) => block.id)).toEqual(["left", "new", "right"]);
    expect(result.layout).toEqual(section.layout);
  });
});
