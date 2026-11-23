import { describe, expect, it } from "vitest";

import { FONT_SIZE_PRESETS, formatFontSize, stepFontSize } from "./text-model";

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

describe("formatFontSize", () => {
  it("shows at most one decimal place without trailing zeros", () => {
    expect(formatFontSize(12)).toBe("12");
    expect(formatFontSize(10.5)).toBe("10.5");
    expect(formatFontSize(11.999999999)).toBe("12");
    expect(formatFontSize(10.4999999999)).toBe("10.5");
    expect(formatFontSize(13.04)).toBe("13");
  });
});
