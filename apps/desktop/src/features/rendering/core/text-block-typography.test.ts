import { describe, expect, it } from "vitest";

import { resolveTextBlockTypography, textBlockFontRuns } from "./text-block-typography";

describe("text block typography", () => {
  it("lets the smallest run establish the baseline without reserving the largest run on every line", () => {
    expect(resolveTextBlockTypography(textBlockFontRuns([
      { type: "text", text: "本文", fontSize: 12 },
      { type: "text", text: "\n注記", fontSize: 1 },
    ]))).toEqual({ minimumFontSizePt: 1, hasInheritedFontSize: false });
  });

  it("keeps unspecified text and math at the block style's default size", () => {
    expect(resolveTextBlockTypography(textBlockFontRuns([
      { type: "text", text: "注記", fontSize: 1 },
      { type: "text", text: "本文" },
      { type: "mathInline", display: "inline", id: "m", tex: "\\frac{1}{2}" },
    ]))).toEqual({ minimumFontSizePt: 1, hasInheritedFontSize: true });
  });

  it("does not let invisible empty runs reserve a baseline", () => {
    expect(resolveTextBlockTypography(textBlockFontRuns([
      { type: "text", text: "", fontSize: 72 },
      { type: "text", text: "\n" },
      { type: "text", text: "注記", fontSize: 1 },
    ]))).toEqual({ minimumFontSizePt: 1, hasInheritedFontSize: false });
  });

  it("leaves empty and unformatted paragraphs on their normal block style", () => {
    expect(resolveTextBlockTypography([])).toBeUndefined();
    expect(resolveTextBlockTypography(textBlockFontRuns([{ type: "text", text: "本文" }]))).toBeUndefined();
  });
});
