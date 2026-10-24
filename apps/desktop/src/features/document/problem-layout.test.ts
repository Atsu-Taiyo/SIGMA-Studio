import { describe, expect, it } from "vitest";
import { sampleDocument } from "@/lib/sample-document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { getProblemAreaLayoutStyle, getProblemFrameLayoutStyle, getProblemNumberLayoutStyle, formatProblemNumberLabel } from "./problem-layout";
import type { ProblemNode } from "./model/blocks";

describe("problem dimensions", () => {
  const problem: ProblemNode = {
    type: "problem", id: "precise_problem", tags: [], lead: [], prompt: [], solution: [], hints: [],
    numbering: { enabled: true, value: 12, fontSize: 10, fontFamily: "Noto Serif JP", fontWeight: 400, format: "fullwidth", widthPx: 20.5, heightPx: 18, gapPx: 2, borderWidthPx: 0.5, borderRadiusPx: 0, borderStyle: "double", offsetXPx: -1, offsetYPx: 0.25 },
    areaLayout: { prompt: { minHeightMm: 12, paddingPx: { top: 0, right: 3.5, bottom: 1, left: 2 }, marginTopPx: 0, marginBottomPx: 0, widthMm: 80 } },
    frame: { enabled: true, borderWidthPx: 0.5, borderRadiusPx: 0 },
  };
  it("keeps explicit zero spacing and fractional dimensions through a file round trip", () => {
    const file = JSON.parse(JSON.stringify({ ...sampleDocument, version: "2.0", metadata: { ...sampleDocument.metadata, styleUnits: { fontSize: "pt" } }, content: [problem] }));
    const restored = parseSigmaDocument(file).content[0] as ProblemNode;
    expect(restored).toEqual(problem);
    expect(formatProblemNumberLabel(12, restored.numbering)).toBe("１２");
    expect(getProblemNumberLayoutStyle(restored.numbering)).toMatchObject({ "--problem-number-width": "20.5px", "--problem-number-gap": "2px", "--problem-number-border-width": "0.5px" });
    expect(getProblemAreaLayoutStyle(restored.areaLayout?.prompt)).toMatchObject({ paddingTop: "0px", paddingLeft: "2px", marginTop: "0px", width: "min(80mm, 100%)" });
    expect(getProblemFrameLayoutStyle(restored.frame)).toMatchObject({ "--problem-frame-border-width": "0.5px" });
  });
  it("does not add overrides to older files", () => {
    expect(getProblemNumberLayoutStyle(undefined)).toEqual({});
    expect(getProblemAreaLayoutStyle({ minHeightMm: 8 })).toEqual({});
    expect(getProblemFrameLayoutStyle({ enabled: true })).toEqual({});
    expect(formatProblemNumberLabel(12)).toBe("12");
    expect(getProblemAreaLayoutStyle({ offsetXPx: 0 }, "280px").left).toBe("calc(280px + 0px)");
    expect(getProblemAreaLayoutStyle({ offsetXPx: -1 }, 280).left).toBe("calc(280px + -1px)");
  });
  it("rejects unsafe fonts and invalid dimensions at the schema and guards direct renderer input", () => {
    expect(() => parseSigmaDocument({ ...sampleDocument, content: [{ ...problem, numbering: { fontFamily: 'serif;position:fixed' } }] })).toThrow();
    expect(() => parseSigmaDocument({ ...sampleDocument, content: [{ ...problem, areaLayout: { prompt: { paddingPx: { top: -1, right: 0, bottom: 0, left: 0 } } } }] })).toThrow();
    expect(getProblemNumberLayoutStyle({ widthPx: Infinity, gapPx: -1, fontFamily: 'serif;position:fixed' })).toEqual({});
    expect(getProblemFrameLayoutStyle({ borderWidthPx: NaN })).toEqual({});
  });
});
