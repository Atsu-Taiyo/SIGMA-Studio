import { describe, expect, it } from "vitest";

import type {
  ProblemNode,
  SigmaBlock,
} from "@/types/sigma-doc";

import {
  getHiddenOptionalProblemAreas,
  getOptionalProblemAreaBlockIdPrefix,
  resolveProblemAreaTransition,
} from "./problem-area-model";

describe("problem area model", () => {
  it("reports hidden optional areas in their stable menu order", () => {
    const problem = problemNode("problem");
    problem.areaLayout = {
      solution: {
        minHeightMm: 4,
      },
    };

    expect(getHiddenOptionalProblemAreas(problem)).toEqual(["hints"]);
    expect(getHiddenOptionalProblemAreas({
      ...problem,
      areaLayout: undefined,
    })).toEqual(["hints", "solution"]);
  });

  it("creates stable editor ids only when an optional area first becomes visible", () => {
    const problem = problemNode("problem");
    expect(getOptionalProblemAreaBlockIdPrefix("hints")).toBe("comment");
    expect(getOptionalProblemAreaBlockIdPrefix("solution")).toBe("answer");

    const showHints = resolveProblemAreaTransition(problem.id, {
      type: "showOptionalArea",
      area: "hints",
      emptyBlockId: "comment_stable",
    });

    expect(showHints.targetId).toBe(problem.id);
    expect(showHints.reduce(paragraph("outside", "本文"))).toEqual(
      paragraph("outside", "本文"),
    );

    const shown = showHints.reduce(problem);
    expect(shown.type).toBe("problem");
    if (shown.type !== "problem") {
      return;
    }
    expect(shown.hints).toHaveLength(1);
    expect(shown.hints[0]).toMatchObject({
      type: "paragraph",
      children: [],
    });
    expect(shown.hints[0]?.id).toBe("comment_stable");

    const repeated = showHints.reduce(shown);
    expect(repeated).toBe(shown);
    expect(
      repeated.type === "problem" ? repeated.hints[0]?.id : null,
    ).toBe(shown.hints[0]?.id);
    const replayed = showHints.reduce(problem);
    expect(
      replayed.type === "problem" ? replayed.hints[0]?.id : null,
    ).toBe("comment_stable");

    const showSolution = resolveProblemAreaTransition(problem.id, {
      type: "showOptionalArea",
      area: "solution",
      emptyBlockId: "answer_stable",
    }).reduce(problem);
    expect(
      showSolution.type === "problem" ? showSolution.solution[0]?.id : null,
    ).toBe("answer_stable");
  });

  it("does not mutate required lead or prompt areas", () => {
    const problem = problemNode("problem", {
      lead: [paragraph("lead", "導入")],
      prompt: [paragraph("prompt", "問題")],
    });

    expect(resolveProblemAreaTransition(problem.id, {
      type: "showOptionalArea",
      area: "lead",
      emptyBlockId: "answer_unused",
    }).reduce(problem)).toBe(problem);
    expect(resolveProblemAreaTransition(problem.id, {
      type: "clearOptionalArea",
      area: "prompt",
    }).reduce(problem)).toBe(problem);
  });

  it("clears only the requested optional area and its layout", () => {
    const prompt = paragraph("prompt", "問題");
    const solution = paragraph("solution", "解答");
    const problem = problemNode("problem", {
      prompt: [prompt],
      hints: [paragraph("hint", "コメント")],
      solution: [solution],
    });
    problem.areaLayout = {
      hints: {
        minHeightMm: 8,
        columnSpan: "full",
      },
      solution: {
        minHeightMm: 6,
      },
    };

    const result = resolveProblemAreaTransition(problem.id, {
      type: "clearOptionalArea",
      area: "hints",
    }).reduce(problem);

    expect(result.type).toBe("problem");
    if (result.type !== "problem") {
      return;
    }
    expect(result.id).toBe(problem.id);
    expect(result.prompt).toBe(problem.prompt);
    expect(result.solution).toBe(problem.solution);
    expect(result.hints).toEqual([]);
    expect(result.areaLayout).toEqual({
      solution: {
        minHeightMm: 6,
      },
    });
  });

  it("rounds minimum height while preserving unrelated layout and block ids", () => {
    const prompt = paragraph("prompt", "問題");
    const problem = problemNode("problem", {
      prompt: [prompt],
    });
    problem.areaLayout = {
      prompt: {
        minHeightMm: 4,
        columnSpan: "full",
      },
      solution: {
        minHeightMm: 6,
      },
    };

    const resized = resolveProblemAreaTransition(problem.id, {
      type: "setMinHeight",
      area: "prompt",
      minHeightMm: 7.26,
    }).reduce(problem);

    expect(resized.type).toBe("problem");
    if (resized.type !== "problem") {
      return;
    }
    expect(resized.id).toBe(problem.id);
    expect(resized.prompt).toBe(problem.prompt);
    expect(resized.prompt[0]?.id).toBe(prompt.id);
    expect(resized.areaLayout).toEqual({
      prompt: {
        minHeightMm: 7.5,
        columnSpan: "full",
      },
      solution: {
        minHeightMm: 6,
      },
    });

    const clearedHeight = resolveProblemAreaTransition(problem.id, {
      type: "setMinHeight",
      area: "prompt",
      minHeightMm: -1,
    }).reduce(problem);
    expect(
      clearedHeight.type === "problem"
        ? clearedHeight.areaLayout?.prompt
        : null,
    ).toEqual({
      columnSpan: "full",
    });
  });

  it("removes an empty areaLayout after its last minimum height is cleared", () => {
    const problem = problemNode("problem");
    problem.areaLayout = {
      hints: {
        minHeightMm: 3,
      },
    };

    const result = resolveProblemAreaTransition(problem.id, {
      type: "setMinHeight",
      area: "hints",
      minHeightMm: 0,
    }).reduce(problem);

    expect(
      result.type === "problem" ? result.areaLayout : null,
    ).toBeUndefined();
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
  areas: Partial<
    Pick<ProblemNode, "lead" | "prompt" | "hints" | "solution">
  > = {},
): ProblemNode {
  return {
    type: "problem",
    id,
    tags: [],
    lead: areas.lead ?? [],
    prompt: areas.prompt ?? [],
    hints: areas.hints ?? [],
    solution: areas.solution ?? [],
  };
}
