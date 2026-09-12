import { describe, expect, it } from "vitest";

import {
  getAiInlineDragPosition,
  getAiInlineHostPosition,
  getAiInlineTopBoundaryFromRects,
} from "./ai-inline-placement";

describe("getAiInlineHostPosition", () => {
  it("keeps the inline composer below the top editor chrome", () => {
    const position = getAiInlineHostPosition(
      { left: 240, top: 80 },
      { width: 1200, height: 800 },
      { topBoundary: 148 },
    );

    expect(position.top).toBe(148);
  });

  it("keeps the inline composer inside the horizontal viewport", () => {
    const position = getAiInlineHostPosition(
      { left: 1180, top: 300 },
      { width: 1200, height: 800 },
      { hostWidth: 440, topBoundary: 148 },
    );

    expect(position.left).toBe(748);
  });

  it("keeps the inline composer above the viewport bottom", () => {
    const position = getAiInlineHostPosition(
      { left: 240, top: 760 },
      { width: 1200, height: 800 },
      { topBoundary: 148 },
    );

    expect(position.top).toBe(580);
  });
});

describe("getAiInlineDragPosition", () => {
  it("does not let a dragged inline composer move under the top editor chrome", () => {
    const position = getAiInlineDragPosition(
      { left: 240, top: 20 },
      { width: 1200, height: 800 },
      { topBoundary: 148 },
    );

    expect(position.top).toBe(148);
  });

  it("clamps the default shortcut position below the top editor chrome too", () => {
    const position = getAiInlineDragPosition(
      { left: 320, top: 140 },
      { width: 1200, height: 800 },
      { topBoundary: 148 },
    );

    expect(position.top).toBe(148);
  });
});

describe("getAiInlineTopBoundaryFromRects", () => {
  it("uses the bottom of the visible editor chrome plus a gap", () => {
    expect(getAiInlineTopBoundaryFromRects([
      { top: 0, bottom: 28 },
      { top: 28, bottom: 136 },
    ], 800)).toBe(144);
  });

  it("falls back to the viewport margin when the editor chrome is offscreen", () => {
    expect(getAiInlineTopBoundaryFromRects([
      { top: 900, bottom: 940 },
    ], 800)).toBe(12);
  });
});
