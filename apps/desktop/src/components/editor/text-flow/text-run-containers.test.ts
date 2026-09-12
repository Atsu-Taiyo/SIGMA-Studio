import { describe, expect, it } from "vitest";

import type { ParagraphNode, ProblemNode } from "@/features/document";

import {
  wrapTextRunBlocksInContainers,
  type TextRunScopeContainer,
} from "./text-run-containers";

function paragraph(id: string, text = id): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

const problem: ProblemNode = {
  type: "problem",
  id: "prob_1",
  tags: ["代数"],
  lead: [paragraph("prob_lead")],
  prompt: [paragraph("prob_prompt")],
  hints: [],
  solution: [paragraph("prob_solution")],
  numbering: { enabled: true, value: 3 },
};

function problemArea(area: "lead" | "prompt" | "hints" | "solution"): TextRunScopeContainer {
  return [{ kind: "problemArea", id: problem.id, area, template: problem }];
}

describe("wrapTextRunBlocksInContainers", () => {
  it("入れ物の無いブロックはそのまま文書順に並ぶ", () => {
    expect(wrapTextRunBlocksInContainers([
      { blocks: [paragraph("p1")] },
      { blocks: [paragraph("p2")] },
    ])).toEqual([paragraph("p1"), paragraph("p2")]);
  });

  it("問題の各エリアは 1 つの問題へ束ねられる", () => {
    const [block] = wrapTextRunBlocksInContainers([
      { blocks: [paragraph("a")], containers: problemArea("lead") },
      { blocks: [paragraph("b")], containers: problemArea("prompt") },
      { blocks: [paragraph("c")], containers: problemArea("solution") },
    ]);

    expect(block).toMatchObject({
      type: "problem",
      id: "prob_1",
      tags: ["代数"],
      numbering: { enabled: true, value: 3 },
      lead: [paragraph("a")],
      prompt: [paragraph("b")],
      hints: [],
      solution: [paragraph("c")],
    });
  });

  it("選択に入らなかったエリアは空のまま運ばれる (原本の中身は引き継がない)", () => {
    const [block] = wrapTextRunBlocksInContainers([
      { blocks: [paragraph("b")], containers: problemArea("prompt") },
    ]);

    expect(block).toMatchObject({ type: "problem", lead: [], hints: [], solution: [] });
  });

  it("問題の前後の本文は問題の外に残る", () => {
    expect(wrapTextRunBlocksInContainers([
      { blocks: [paragraph("before")] },
      { blocks: [paragraph("b")], containers: problemArea("prompt") },
      { blocks: [paragraph("after")] },
    ]).map((block) => block.type)).toEqual(["paragraph", "problem", "paragraph"]);
  });

  it("別の問題は別のブロックになる", () => {
    const other: ProblemNode = { ...problem, id: "prob_2" };
    const blocks = wrapTextRunBlocksInContainers([
      { blocks: [paragraph("a")], containers: problemArea("prompt") },
      {
        blocks: [paragraph("b")],
        containers: [{ kind: "problemArea", id: other.id, area: "prompt", template: other }],
      },
    ]);

    expect(blocks.map((block) => block.id)).toEqual(["prob_1", "prob_2"]);
  });

  it("空エリアの編集用段落 (SigmaDoc に無い派生ブロック) は運ばない", () => {
    expect(wrapTextRunBlocksInContainers([
      {
        blocks: [{ type: "paragraph", id: "prob_1_hints_empty", children: [] }],
        containers: problemArea("hints"),
      },
    ])).toEqual([]);
  });

  it("問題エリアの中の段組は入れ子のまま組み直す", () => {
    const [block] = wrapTextRunBlocksInContainers([
      {
        blocks: [paragraph("col1"), paragraph("col2")],
        containers: [
          { kind: "problemArea", id: problem.id, area: "prompt", template: problem },
          { kind: "layoutSection", id: "layout_1", layout: { columnCount: 2 } },
        ],
      },
    ]);

    expect(block).toMatchObject({
      type: "problem",
      prompt: [{
        type: "layoutSection",
        id: "layout_1",
        layout: { columnCount: 2 },
        children: [paragraph("col1"), paragraph("col2")],
      }],
    });
  });

  it("同じ段組を分けて持つユニットは 1 つの段組へ束ねられる", () => {
    const containers: TextRunScopeContainer = [
      { kind: "layoutSection", id: "layout_1", layout: { columnCount: 2 } },
    ];
    const [block] = wrapTextRunBlocksInContainers([
      { blocks: [paragraph("left")], containers },
      { blocks: [paragraph("right")], containers },
    ]);

    expect(block).toMatchObject({
      type: "layoutSection",
      children: [paragraph("left"), paragraph("right")],
    });
  });

  it("段の中に段組は入れない", () => {
    expect(wrapTextRunBlocksInContainers([
      {
        blocks: [{ type: "layoutSection", id: "nested", layout: { columnCount: 2 }, children: [paragraph("x")] }],
        containers: [{ kind: "layoutSection", id: "layout_1", layout: { columnCount: 2 } }],
      },
    ])).toEqual([]);
  });

  it("問題エリアに見出し行 (section) は入れない", () => {
    expect(wrapTextRunBlocksInContainers([
      { blocks: [{ type: "section", id: "s1", title: "章" }], containers: problemArea("prompt") },
    ])).toEqual([]);
  });
});
