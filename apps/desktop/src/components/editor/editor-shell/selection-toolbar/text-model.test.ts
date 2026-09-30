import { describe, expect, it } from "vitest";

import { FONT_SIZE_PRESETS, stepFontSize } from "./text-model";

describe("stepFontSize", () => {
  it("moves one point at a time like the top toolbar", () => {
    expect(stepFontSize(12, 1)).toBe(13);
    expect(stepFontSize(12, -1)).toBe(11);
    expect(stepFontSize(10.5, 1)).toBe(11.5);
  });

  it("never reaches zero and falls back for a broken value", () => {
    expect(stepFontSize(1, -1)).toBe(0.1);
    expect(stepFontSize(Number.NaN, 1)).toBe(13);
  });

  it("offers ascending presets", () => {
    expect([...FONT_SIZE_PRESETS]).toEqual([...FONT_SIZE_PRESETS].sort((a, b) => a - b));
  });
});
