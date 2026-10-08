import { describe, expect, it } from "vitest";

import type { ProblemNode } from "@/features/document";

import { shouldShowProblemArea } from "./problem-area-visibility";
import {
  FULL_PROBLEM_DISPLAY,
  isProblemAreaDisplayed,
  isProblemDisplayFiltered,
  problemDisplayPartOf,
  toggleProblemDisplayPart,
  type ProblemDisplayFilter,
} from "./problem-display-filter";

function paragraph(id: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text: id }] };
}

function problemWith(areas: Partial<Pick<ProblemNode, "lead" | "prompt" | "hints" | "solution">>): ProblemNode {
  return { type: "problem", id: "q1", tags: [], lead: [], prompt: [], hints: [], solution: [], ...areas };
}

const ONLY_SOLUTION: ProblemDisplayFilter = { problem: false, solution: true, hints: false };

describe("problem display filter", () => {
  it("maps the lead and the prompt to 問題, and the other areas to themselves", () => {
    expect(problemDisplayPartOf("lead")).toBe("problem");
    expect(problemDisplayPartOf("prompt")).toBe("problem");
    expect(problemDisplayPartOf("hints")).toBe("hints");
    expect(problemDisplayPartOf("solution")).toBe("solution");
  });

  it("is not filtering until something is hidden", () => {
    expect(isProblemDisplayFiltered(FULL_PROBLEM_DISPLAY)).toBe(false);
    expect(isProblemDisplayFiltered({ ...FULL_PROBLEM_DISPLAY, hints: false })).toBe(true);
  });

  it("toggles one part at a time without touching the shared default", () => {
    const withoutSolution = toggleProblemDisplayPart(FULL_PROBLEM_DISPLAY, "solution");

    expect(withoutSolution).toEqual({ problem: true, solution: false, hints: true });
    expect(FULL_PROBLEM_DISPLAY).toEqual({ problem: true, solution: true, hints: true });
    expect(toggleProblemDisplayPart(withoutSolution, "solution")).toEqual(FULL_PROBLEM_DISPLAY);
  });

  it("never lets the last visible part be switched off", () => {
    const onlyProblem: ProblemDisplayFilter = { problem: true, solution: false, hints: false };

    // 同じ参照を返す = state が変わらず、再描画も起きない。
    expect(toggleProblemDisplayPart(onlyProblem, "problem")).toBe(onlyProblem);
    expect(toggleProblemDisplayPart(onlyProblem, "hints")).toEqual({ problem: true, solution: false, hints: true });
  });

  it("answers per area whether it is displayed", () => {
    expect(isProblemAreaDisplayed(ONLY_SOLUTION, "solution")).toBe(true);
    expect(isProblemAreaDisplayed(ONLY_SOLUTION, "lead")).toBe(false);
    expect(isProblemAreaDisplayed(ONLY_SOLUTION, "prompt")).toBe(false);
    expect(isProblemAreaDisplayed(ONLY_SOLUTION, "hints")).toBe(false);
  });
});

describe("shouldShowProblemArea with a display filter", () => {
  const full = problemWith({
    lead: [paragraph("lead")],
    prompt: [paragraph("prompt")],
    hints: [paragraph("hint")],
    solution: [paragraph("solution")],
  });

  it("behaves exactly as before when no filter is given", () => {
    expect(shouldShowProblemArea(full, "lead")).toBe(true);
    expect(shouldShowProblemArea(problemWith({}), "prompt")).toBe(true);
    expect(shouldShowProblemArea(problemWith({}), "solution")).toBe(false);
    expect(shouldShowProblemArea(problemWith({}), "hints")).toBe(false);
  });

  it("hides the always-rendered lead and prompt when 問題 is off", () => {
    expect(shouldShowProblemArea(full, "lead", ONLY_SOLUTION)).toBe(false);
    expect(shouldShowProblemArea(full, "prompt", ONLY_SOLUTION)).toBe(false);
  });

  it("hides an area that has content when its part is off", () => {
    const onlyProblem: ProblemDisplayFilter = { problem: true, solution: false, hints: false };

    expect(shouldShowProblemArea(full, "solution", onlyProblem)).toBe(false);
    expect(shouldShowProblemArea(full, "hints", onlyProblem)).toBe(false);
    expect(shouldShowProblemArea(full, "prompt", onlyProblem)).toBe(true);
  });

  it("never invents an empty area: a part that is on still needs content or reserved height", () => {
    expect(shouldShowProblemArea(problemWith({}), "solution", ONLY_SOLUTION)).toBe(false);
    expect(shouldShowProblemArea(full, "solution", ONLY_SOLUTION)).toBe(true);
  });
});
