import { describe, expect, it } from "vitest";
import { inheritProblemStyle, inheritPreviousProblemStyle } from "./problem-style";
import type { ProblemNode } from "../model/blocks";

const problem = (id: string): ProblemNode => ({
  type: "problem", id, tags: [], lead: [], hints: [], solution: [],
  prompt: [{ type: "paragraph", id: `${id}_prompt`, children: [{ type: "text", text: id }] }],
  answer: { type: "math", expected: "" },
});

describe("new problem presentation", () => {
  it("inherits number, frame and area settings while retaining fresh content and automatic numbering", () => {
    const previous: ProblemNode = {
      ...problem("previous"), tags: ["private tag"], answer: { type: "text", expected: "answer" },
      numbering: { enabled: true, value: 137, fontFamily: "serif", fontSize: 10, format: "fullwidth", widthPx: 20, heightPx: 22, borderWidthPx: .5, offsetYPx: 2 },
      frame: { enabled: true, styleId: "doublebox", borderWidthPx: .5 },
      areaLayout: { lead: { hidden: true }, prompt: { minHeightMm: 20, widthMm: 80, marginTopPx: 0, paddingPx: { top: 2, right: 4, bottom: 6, left: 8 } } },
      pagination: { break: true }, spaceAfterPx: 300,
    };
    const next = problem("next"), result = inheritProblemStyle(next, previous);
    expect(result).toEqual({ ...next, numbering: { ...previous.numbering, value: undefined }, frame: previous.frame, areaLayout: previous.areaLayout });
    expect(result.numbering).not.toHaveProperty("value");
    result.areaLayout!.prompt!.paddingPx!.top = 99;
    expect(previous.areaLayout!.prompt!.paddingPx!.top).toBe(2);
    expect(result.frame).not.toBe(previous.frame);
  });

  it("uses the preceding problem at the insertion location rather than the last problem in the document", () => {
    const first = { ...problem("first"), numbering: { fontFamily: "serif", value: 5 } };
    const last = { ...problem("last"), numbering: { enabled: false, fontFamily: "sans-serif" } };
    const inserted = problem("inserted");
    const result = inheritPreviousProblemStyle([first, inserted, last], inserted.id);
    expect(result?.numbering).toEqual({ fontFamily: "serif" });
    expect(inheritPreviousProblemStyle([inserted, last], inserted.id)).toBe(inserted);
    expect(inheritPreviousProblemStyle([first], "absent")).toBeNull();
  });

  it("follows nested boxes in page order and retains disabled number and frame settings", () => {
    const previous = { ...problem("nested"), numbering: { enabled: false }, frame: { enabled: false } };
    const inserted = problem("inserted");
    expect(inheritPreviousProblemStyle([{ type: "boxBlock", id: "box", styleId: "plain", blocks: [previous, inserted] }], inserted.id))
      .toMatchObject({ numbering: { enabled: false }, frame: { enabled: false } });
  });
});
