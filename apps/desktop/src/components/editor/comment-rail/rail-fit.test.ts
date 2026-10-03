import { describe, expect, it } from "vitest";

import { shouldCompactCommentRail } from "./rail-fit";

describe("shouldCompactCommentRail", () => {
  it("keeps the full cards when there is room right of the paper (1400px window)", () => {
    // 用紙の右端 1097、窓の右端 1400: 並びは 1084 から。余白 (13px) に掛かるだけ。
    expect(shouldCompactCommentRail({ canvasRight: 1400, canvasWidth: 1400, paperRight: 1097 })).toBe(false);
  });

  it("allows the cards to reach into the paper's blank margin, but not onto the text", () => {
    // 並びの左端 = 窓の右端 - 316。用紙の右端 - 48 まで。
    expect(shouldCompactCommentRail({ canvasRight: 1400, canvasWidth: 1400, paperRight: 1131 })).toBe(false);
    expect(shouldCompactCommentRail({ canvasRight: 1400, canvasWidth: 1400, paperRight: 1133 })).toBe(true);
  });

  it("switches to icons when the sidebar narrows the editor column", () => {
    expect(shouldCompactCommentRail({ canvasRight: 1000, canvasWidth: 1000, paperRight: 897 })).toBe(true);
  });

  it("decides a whiteboard by the window's width alone", () => {
    expect(shouldCompactCommentRail({ canvasRight: 1400, canvasWidth: 1400, paperRight: null })).toBe(false);
    expect(shouldCompactCommentRail({ canvasRight: 1000, canvasWidth: 979, paperRight: null })).toBe(true);
  });
});
