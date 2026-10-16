import { describe, expect, it } from "vitest";

import type { InlineNode } from "@/features/document";
import { annotateBoxedInlineRuns, normalizeBoxedInlineStyle } from "@/features/rendering/core";
import { boxedInlineDomSpec } from "@/features/rendering/adapters";
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

describe("boxed corner roundness", () => {
  it("is read only for an oval box that is less round than the default", () => {
    expect(normalizeBoxedInlineStyle({ boxedVariant: "oval", boxedRoundness: 40 })).toMatchObject({ roundness: 40 });
    expect(normalizeBoxedInlineStyle({ boxedVariant: "oval", boxedRoundness: 140 })).not.toHaveProperty("roundness");
    expect(normalizeBoxedInlineStyle({ boxedVariant: "oval", boxedRoundness: 100 })).not.toHaveProperty("roundness");
    expect(normalizeBoxedInlineStyle({ boxedVariant: "oval", boxedRoundness: -5 })).not.toHaveProperty("roundness");
    // Square variants keep square corners whatever a stale value says.
    expect(normalizeBoxedInlineStyle({ boxedVariant: "thick", boxedRoundness: 40 })).not.toHaveProperty("roundness");
    expect(normalizeBoxedInlineStyle({ boxedRoundness: 40 })).not.toHaveProperty("roundness");
  });

  it("hands the roundness to the stylesheet as a ratio of the oval's full rounding", () => {
    expect(boxedInlineDomSpec(boxedText("A", { boxedVariant: "oval", boxedRoundness: 30 }) as never)).toEqual({
      attrs: {
        "data-sigma-doc-boxed-text": "true",
        "data-sigma-doc-boxed-variant": "oval",
        "data-sigma-doc-boxed-roundness": "30",
      },
      className: "boxed-text",
      style: { "--boxed-text-roundness": "0.3" },
    });
    expect(boxedInlineDomSpec(boxedText("A", { boxedVariant: "oval" }) as never).style).toBeUndefined();
  });

  it("starts a new run where the roundness changes", () => {
    const runs = annotateBoxedInlineRuns([
      boxedText("A", { boxedVariant: "oval", boxedRoundness: 30 }),
      boxedText("B", { boxedVariant: "oval", boxedRoundness: 30 }),
      boxedText("C", { boxedVariant: "oval" }),
    ]);
    expect(runs[0].boxedRun?.runId).toBe(runs[1].boxedRun?.runId);
    expect(runs[2].boxedRun?.runId).not.toBe(runs[1].boxedRun?.runId);
  });
});

function boxedText(text: string, attrs: Partial<Extract<InlineNode, { type: "text" }>> = {}): InlineNode {
  return { type: "text", text, marks: ["boxed"], ...attrs };
}

function boxedMath(id: string, tex: string, attrs: Partial<Extract<InlineNode, { type: "mathInline" }>> = {}): InlineNode {
  return { type: "mathInline", id, tex, display: "inline", marks: ["boxed"], ...attrs };
}
