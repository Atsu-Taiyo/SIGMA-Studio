import { describe, expect, it } from "vitest";

import {
  InlineContent as LegacyInlineContent,
  renderInlineContent as legacyRenderInlineContent,
} from "@/components/editor/InlineContent";
import {
  InlineMathPreview as LegacyInlineMathPreview,
  MathPreview as LegacyMathPreview,
} from "@/components/math/MathPreview";
import { Graph2DPreview as LegacyGraph2DPreview } from "@/components/graph/Graph2DPreview";

import {
  Graph2DPreview,
  InlineContent,
  InlineMathPreview,
  MathPreview,
  renderInlineContent,
} from ".";

describe("React rendering compatibility facades", () => {
  it("keep the former component entrypoints on the canonical implementations", () => {
    expect(LegacyInlineContent).toBe(InlineContent);
    expect(legacyRenderInlineContent).toBe(renderInlineContent);
    expect(LegacyInlineMathPreview).toBe(InlineMathPreview);
    expect(LegacyMathPreview).toBe(MathPreview);
    expect(LegacyGraph2DPreview).toBe(Graph2DPreview);
  });
});
