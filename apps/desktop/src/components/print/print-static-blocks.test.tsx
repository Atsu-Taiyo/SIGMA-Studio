import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProblemNode } from "@/features/document";

import { buildProblemAreaPrintUnits, PrintProblemArea } from "./print-static-blocks";

function problem(extra: Partial<ProblemNode> = {}): ProblemNode {
  return {
    type: "problem",
    id: "q1",
    tags: [],
    lead: [],
    prompt: [{ type: "paragraph", id: "q1_prompt", children: [{ type: "text", text: "問題文" }] }],
    hints: [],
    solution: [],
    ...extra,
  };
}

function render(unit: ReturnType<typeof buildProblemAreaPrintUnits>[number]) {
  return renderToStaticMarkup(
    <PrintProblemArea
      problemId={unit.problemId}
      area={unit.area}
      blocks={unit.blocks}
      problemNumber={unit.problemNumber}
      numberFontSize={unit.numberFontSize}
      hasFrame={unit.hasFrame}
      isFirstProblemArea={unit.isFirstProblemArea}
      isFirstProblemFrameArea={unit.isFirstProblemFrameArea}
      isLastProblemFrameArea={unit.isLastProblemFrameArea}
      columnGapMm={0}
    />,
  );
}

describe("buildProblemAreaPrintUnits with the lead line turned off", () => {
  it("draws the empty lead with the number by default", () => {
    const units = buildProblemAreaPrintUnits(problem(), 1);

    expect(units.map((unit) => unit.area)).toEqual(["lead", "prompt"]);
    expect(render(units[0]!)).toContain("print-problem-number");
    expect(render(units[1]!)).not.toContain("print-problem-number");
  });

  it("folds the empty lead and puts the number on the problem text", () => {
    const units = buildProblemAreaPrintUnits(problem({ areaLayout: { lead: { hidden: true } } }), 1);

    expect(units.map((unit) => unit.area)).toEqual(["prompt"]);
    expect(units[0]?.isFirstProblemArea).toBe(true);
    expect(render(units[0]!)).toContain("print-problem-number");
  });

  it("keeps a lead that has text even when the line was turned off", () => {
    const units = buildProblemAreaPrintUnits(problem({
      areaLayout: { lead: { hidden: true } },
      lead: [{ type: "paragraph", id: "q1_lead", children: [{ type: "text", text: "導入文" }] }],
    }), 1);

    expect(units.map((unit) => unit.area)).toEqual(["lead", "prompt"]);
    expect(render(units[1]!)).not.toContain("print-problem-number");
  });

  it("draws no number, and no lead, for a problem without a number whose lead line is off", () => {
    const units = buildProblemAreaPrintUnits(problem({ areaLayout: { lead: { hidden: true } } }));

    expect(units.map((unit) => unit.area)).toEqual(["prompt"]);
    expect(render(units[0]!)).not.toContain("print-problem-number");
  });
});
