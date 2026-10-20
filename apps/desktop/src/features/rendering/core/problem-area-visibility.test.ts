import { describe, expect, it } from "vitest";

import type { ProblemNode } from "@/features/document";

import { isProblemLeadBlank, isProblemLeadFolded, shouldShowProblemArea } from "./problem-area-visibility";

function problem(extra: Partial<ProblemNode> = {}): ProblemNode {
  return {
    type: "problem",
    id: "q1",
    tags: [],
    lead: [],
    prompt: [],
    hints: [],
    solution: [],
    ...extra,
  };
}

const text = (id: string, value: string) => ({ type: "paragraph" as const, id, children: [{ type: "text" as const, text: value }] });
const empty = (id: string) => ({ type: "paragraph" as const, id, children: [] });

describe("導入文の行を出さない設定", () => {
  const off = { lead: { hidden: true } };

  it("draws the lead and the prompt of a problem that did not turn it off", () => {
    expect(shouldShowProblemArea(problem(), "lead")).toBe(true);
    expect(shouldShowProblemArea(problem(), "prompt")).toBe(true);
  });

  it("folds only an empty lead, and never the prompt", () => {
    expect(shouldShowProblemArea(problem({ areaLayout: off }), "lead")).toBe(false);
    expect(shouldShowProblemArea(problem({ areaLayout: off, lead: [empty("l")] }), "lead")).toBe(false);
    expect(shouldShowProblemArea(problem({ areaLayout: off }), "prompt")).toBe(true);
  });

  it("keeps a lead that holds text, math, or anything but an empty paragraph", () => {
    expect(shouldShowProblemArea(problem({ areaLayout: off, lead: [text("l", "導入")] }), "lead")).toBe(true);
    expect(shouldShowProblemArea(problem({
      areaLayout: off,
      lead: [{ type: "paragraph", id: "l", children: [{ type: "mathInline", id: "m", tex: "x" }] }],
    } as Partial<ProblemNode>), "lead")).toBe(true);
    expect(shouldShowProblemArea(problem({ areaLayout: off, lead: [{ type: "divider", id: "d" }] }), "lead")).toBe(true);
  });

  it("keeps a lead whose height the author reserved", () => {
    expect(isProblemLeadFolded(problem({ areaLayout: { lead: { hidden: true, minHeightMm: 8 } } }))).toBe(false);
  });

  it("still lets the display filter remove an area first", () => {
    const onlySolution = { problem: false, solution: true, hints: false };
    expect(shouldShowProblemArea(problem(), "lead", onlySolution)).toBe(false);
  });

  it("tells a blank lead from a written one", () => {
    expect(isProblemLeadBlank(problem())).toBe(true);
    expect(isProblemLeadBlank(problem({ lead: [empty("a"), empty("b")] }))).toBe(true);
    expect(isProblemLeadBlank(problem({ lead: [empty("a"), text("b", "字")] }))).toBe(false);
  });
});
