import { describe, expect, it } from "vitest";

import type { InlineNode } from "@/features/document";
import { annotateBoxedInlineRuns } from "@/features/rendering/core";
import {
  annotateBoxedInlineRuns as annotateBoxedInlineRunsFromCompatibilityFacade,
  boxedInlineDomSpec as boxedInlineDomSpecFromCompatibilityFacade,
} from "@/lib/boxed-inline-runs";

describe("boxed inline runs", () => {
  it("keeps the legacy module path as a one-way compatibility facade", () => {
    const children = [
      boxedText("A", { boxedPaddingY: 2, boxedTone: "blue", boxedVariant: "double" }),
      boxedMath("m_compat", "x"),
    ];

    expect(annotateBoxedInlineRunsFromCompatibilityFacade(children)).toEqual(annotateBoxedInlineRuns(children));
    expect(boxedInlineDomSpecFromCompatibilityFacade(children[0])).toEqual({
      attrs: {
        "data-sigma-doc-boxed-padding-y": "2",
        "data-sigma-doc-boxed-text": "true",
        "data-sigma-doc-boxed-tone": "blue",
        "data-sigma-doc-boxed-variant": "double",
      },
      className: "boxed-text",
      style: {
        "--boxed-text-line-height": "calc(1.78em + 6px)",
        "--boxed-text-padding-y": "2px",
      },
    });
  });

  it("connects adjacent boxed text, math, and text with the same style", () => {
    const annotated = annotateBoxedInlineRuns([
      boxedText("辺"),
      boxedMath("m_1", "P(\\alpha)Q(\\beta)"),
      boxedText("は"),
    ]);

    expect(annotated.map((entry) => entry.boxedRun && {
      connectLeft: entry.boxedRun.connectLeft,
      connectRight: entry.boxedRun.connectRight,
      segmentCount: entry.boxedRun.segmentCount,
    })).toEqual([
      { connectLeft: false, connectRight: true, segmentCount: 3 },
      { connectLeft: true, connectRight: true, segmentCount: 3 },
      { connectLeft: true, connectRight: false, segmentCount: 3 },
    ]);
  });

  it("connects double boxed math and text without changing variants", () => {
    const annotated = annotateBoxedInlineRuns([
      boxedMath("m_left", "\\alpha\\beta = X + Yi", { boxedVariant: "double" }),
      boxedMath("m_middle", "\\alpha\\beta", { boxedVariant: "double" }),
      boxedText("とすると,", { boxedVariant: "double" }),
    ], { runIdPrefix: "double-case" });

    expect(annotated.map((entry) => entry.boxedRun?.styleKey)).toEqual([
      "0|double|",
      "0|double|",
      "0|double|",
    ]);
    expect(annotated[0].boxedRun?.runId).toBe("double-case-boxed-run-0");
    expect(annotated[1].boxedRun?.connectLeft).toBe(true);
    expect(annotated[1].boxedRun?.connectRight).toBe(true);
  });

  it("breaks runs on visible unboxed text and different boxed styles", () => {
    const annotated = annotateBoxedInlineRuns([
      boxedText("A"),
      { type: "text", text: " " },
      boxedMath("m_1", "x"),
      boxedText("B", { boxedVariant: "thick" }),
    ]);

    expect(annotated.map((entry) => entry.boxedRun && {
      connectLeft: entry.boxedRun.connectLeft,
      connectRight: entry.boxedRun.connectRight,
      runId: entry.boxedRun.runId,
    })).toEqual([
      { connectLeft: false, connectRight: false, runId: "boxed-run-0" },
      undefined,
      { connectLeft: false, connectRight: false, runId: "boxed-run-1" },
      { connectLeft: false, connectRight: false, runId: "boxed-run-2" },
    ]);
  });

  it("ignores empty and zero-width text when deciding adjacency", () => {
    const annotated = annotateBoxedInlineRuns([
      boxedText("A"),
      { type: "text", text: "\u200B" },
      { type: "text", text: "" },
      boxedMath("m_1", "x"),
    ]);

    expect(annotated[0].boxedRun?.connectRight).toBe(true);
    expect(annotated[1].boxedRun).toBeUndefined();
    expect(annotated[2].boxedRun).toBeUndefined();
    expect(annotated[3].boxedRun?.connectLeft).toBe(true);
  });
});

function boxedText(text: string, attrs: Partial<Extract<InlineNode, { type: "text" }>> = {}): InlineNode {
  return { type: "text", text, marks: ["boxed"], ...attrs };
}

function boxedMath(id: string, tex: string, attrs: Partial<Extract<InlineNode, { type: "mathInline" }>> = {}): InlineNode {
  return { type: "mathInline", id, tex, display: "inline", marks: ["boxed"], ...attrs };
}
