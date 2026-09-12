import { describe, expect, it } from "vitest";

import { normalizeLineHeight, stepLineHeight } from "@/lib/line-height";

describe("line-height helpers", () => {
  it("normalizes unitless line-height multipliers", () => {
    expect(normalizeLineHeight("1.20")).toBe("1.2");
    expect(normalizeLineHeight("1.8")).toBe("1.8");
    expect(normalizeLineHeight(".9")).toBe("0.9");
  });

  it("rejects unsafe or out-of-range values", () => {
    expect(normalizeLineHeight("20px")).toBeUndefined();
    expect(normalizeLineHeight("normal")).toBeUndefined();
    expect(normalizeLineHeight("0.7")).toBeUndefined();
    expect(normalizeLineHeight("3.1")).toBeUndefined();
  });

  it("steps by 0.05 without floating-point artifacts", () => {
    expect(stepLineHeight("1.15", "increase")).toBe("1.2");
    expect(stepLineHeight("1.2", "decrease")).toBe("1.15");
  });

  it("clamps stepping at the supported bounds", () => {
    expect(stepLineHeight("0.8", "decrease")).toBe("0.8");
    expect(stepLineHeight("3", "increase")).toBe("3");
  });
});

describe("stepLineHeight", () => {
  it("steps by 0.05 in each direction from a preset value", () => {
    expect(stepLineHeight("1.5", "increase")).toBe("1.55");
    expect(stepLineHeight("1.5", "decrease")).toBe("1.45");
  });

  it("steps by 0.05 from a non-preset value", () => {
    expect(stepLineHeight("1.35", "increase")).toBe("1.4");
    expect(stepLineHeight("1.35", "decrease")).toBe("1.3");
  });

  it("clamps at the minimum and maximum", () => {
    expect(stepLineHeight("0.8", "decrease")).toBe("0.8");
    expect(stepLineHeight("3", "increase")).toBe("3");
  });

  it("round-trips increase then decrease back to the original", () => {
    expect(stepLineHeight(stepLineHeight("1.15", "increase"), "decrease")).toBe("1.15");
  });
});
