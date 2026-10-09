import { describe, expect, it } from "vitest";

import type { OverlayShape, SigmaBlock } from "@/features/document";

import { FULL_PROBLEM_DISPLAY, type ProblemDisplayFilter } from "./problem-display-filter";
import { collectProblemDisplayHiddenBlockIds, collectProblemDisplayHiddenShapeIds } from "./problem-display-targets";

function paragraph(id: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text: id }] };
}

const ONLY_PROBLEM: ProblemDisplayFilter = { problem: true, solution: false, hints: false };
const ONLY_SOLUTION: ProblemDisplayFilter = { problem: false, solution: true, hints: false };

const content = [
  paragraph("body"),
  {
    type: "problem", id: "q1", tags: [],
    lead: [paragraph("q1_lead")],
    prompt: [paragraph("q1_prompt")],
    hints: [paragraph("q1_hint")],
    solution: [{
      type: "list", id: "q1_solution_list", ordered: true,
      items: [{ id: "q1_solution_item", children: [{ type: "text", text: "解" }] }],
    }],
  },
  {
    type: "problem", id: "q2", tags: [],
    lead: [], prompt: [paragraph("q2_prompt")], hints: [], solution: [],
  },
  {
    // 箱の中の問題は箱の編集面が持ち、隠した領域をそこで畳む。
    type: "boxBlock", id: "box", blocks: [{
      type: "problem", id: "boxed", tags: [],
      lead: [], prompt: [paragraph("boxed_prompt")], hints: [], solution: [paragraph("boxed_solution")],
    }],
  },
] as unknown as SigmaBlock[];

function shape(id: string, anchor: OverlayShape["anchor"], extra: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id, type: "geo", x: 0, y: 0, anchor,
    props: { w: 10, h: 10, geo: "rectangle" },
    ...extra,
  } as OverlayShape;
}

describe("collectProblemDisplayHiddenBlockIds", () => {
  it("hides nothing while every part is shown", () => {
    expect(collectProblemDisplayHiddenBlockIds(content, FULL_PROBLEM_DISPLAY).size).toBe(0);
  });

  it("collects every block inside a hidden area, nested ones included", () => {
    const hidden = collectProblemDisplayHiddenBlockIds(content, ONLY_PROBLEM);

    expect([...hidden].sort()).toEqual(["boxed_solution", "q1_hint", "q1_solution_item", "q1_solution_list"]);
  });

  it("collects a problem none of whose areas is drawn, but not one that keeps an area", () => {
    const hidden = collectProblemDisplayHiddenBlockIds(content, ONLY_SOLUTION);

    expect(hidden.has("q1_lead")).toBe(true);
    expect(hidden.has("q1_prompt")).toBe(true);
    expect(hidden.has("q1")).toBe(false);
    // q2 は解答を持たないので、解答だけの表示では何も描かれない。
    expect(hidden.has("q2")).toBe(true);
    expect(hidden.has("q2_prompt")).toBe(true);
  });

  it("narrows problems inside a box by the same rule", () => {
    const onlyProblem = collectProblemDisplayHiddenBlockIds(content, ONLY_PROBLEM);
    const onlySolution = collectProblemDisplayHiddenBlockIds(content, ONLY_SOLUTION);

    expect(onlyProblem.has("boxed_solution")).toBe(true);
    expect(onlyProblem.has("boxed_prompt")).toBe(false);
    expect(onlySolution.has("boxed_prompt")).toBe(true);
    expect(onlySolution.has("boxed")).toBe(false);
  });

  it("finds a problem in a box that sits inside a shown area, and skips one inside a hidden area", () => {
    const outer = [{
      type: "problem", id: "outer", tags: [], lead: [],
      prompt: [{ type: "boxBlock", id: "outer_box", blocks: [{
        type: "problem", id: "inner", tags: [], lead: [],
        prompt: [paragraph("inner_prompt")], hints: [], solution: [paragraph("inner_solution")],
      }] }],
      hints: [],
      solution: [paragraph("outer_solution")],
    }] as unknown as SigmaBlock[];

    expect([...collectProblemDisplayHiddenBlockIds(outer, ONLY_PROBLEM)].sort()).toEqual(["inner_solution", "outer_solution"]);
    // 問題を隠すと、外側の問題文 (中の箱ごと) が隠れる。
    expect(collectProblemDisplayHiddenBlockIds(outer, ONLY_SOLUTION).has("inner_solution")).toBe(true);
  });
});

describe("collectProblemDisplayHiddenShapeIds", () => {
  const shapes = [
    shape("in_prompt", { type: "block", blockId: "q1_prompt", dy: 0 }),
    shape("in_solution", { type: "block", blockId: "q1_solution_list", dy: 0 }),
    shape("in_solution_item", { type: "block", blockId: "q1_solution_item", dy: 0 }),
    shape("on_problem", { type: "block", blockId: "q1", dy: 0 }),
    shape("label_of_solution_figure", { type: "shape", shapeId: "in_solution", dx: 0, dy: 0 }),
    shape("group_on_solution", { type: "block", blockId: "q1_solution_list", dy: 0 }, { type: "group" } as Partial<OverlayShape>),
    shape("member", { type: "block", blockId: "q1_solution_list", dy: 0 }, { parentId: "group_on_solution" }),
    shape("on_page", { type: "page" }),
    shape("unanchored", undefined),
    shape("on_body", { type: "block", blockId: "body", dy: 0 }),
  ];

  it("hides figures anchored to hidden areas and everything that hangs from them", () => {
    const hidden = collectProblemDisplayHiddenShapeIds(content, shapes, ONLY_PROBLEM);

    expect([...hidden].sort()).toEqual([
      "group_on_solution",
      "in_solution",
      "in_solution_item",
      "label_of_solution_figure",
      "member",
    ]);
  });

  it("hides figures placed on the problem itself once 問題 is hidden", () => {
    const hidden = collectProblemDisplayHiddenShapeIds(content, shapes, ONLY_SOLUTION);

    expect(hidden.has("on_problem")).toBe(true);
    expect(hidden.has("in_prompt")).toBe(true);
    expect(hidden.has("in_solution")).toBe(false);
    expect(hidden.has("on_body")).toBe(false);
    expect(hidden.has("on_page")).toBe(false);
    expect(hidden.has("unanchored")).toBe(false);
  });

  it("hides a group member even when only the group names the hidden anchor", () => {
    const groupOnly = [
      shape("group", { type: "block", blockId: "q1_hint", dy: 0 }, { type: "group" } as Partial<OverlayShape>),
      shape("member", undefined, { parentId: "group" }),
    ];

    expect([...collectProblemDisplayHiddenShapeIds(content, groupOnly, ONLY_PROBLEM)].sort()).toEqual(["group", "member"]);
  });

  it("hides nothing while every part is shown", () => {
    expect(collectProblemDisplayHiddenShapeIds(content, shapes, FULL_PROBLEM_DISPLAY).size).toBe(0);
  });
});
