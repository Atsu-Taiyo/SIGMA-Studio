import { describe, expect, it } from "vitest";

import {
  clampFillOpacity,
  fillOpacityToPercent,
  normalizeFillOpacity,
  percentToFillOpacity,
} from "./fill-opacity";

describe("fill opacity conversion", () => {
  it.each([0, 1, 35, 50, 99, 100])("survives a round trip at %i%%", (percent) => {
    expect(fillOpacityToPercent(percentToFillOpacity(percent))).toBe(percent);
  });

  it("treats 0 as a value, not as unset", () => {
    // The whole feature hangs on this: `fillOpacity: 0` is a fully transparent *colour*, which is a
    // different thing from having no fill at all.
    expect(percentToFillOpacity(0)).toBe(0);
    expect(fillOpacityToPercent(0)).toBe(0);
    expect(normalizeFillOpacity(0)).toBe(0);
    expect(clampFillOpacity(0)).toBe(0);
  });

  it("reads an omitted opacity as fully opaque", () => {
    expect(fillOpacityToPercent(undefined)).toBe(100);
    expect(normalizeFillOpacity(undefined)).toBe(1);
  });

  it("clamps out-of-range input instead of storing it", () => {
    expect(percentToFillOpacity(-20)).toBe(0);
    expect(percentToFillOpacity(180)).toBe(1);
    expect(clampFillOpacity(-0.5)).toBe(0);
    expect(clampFillOpacity(1.5)).toBe(1);
    expect(fillOpacityToPercent(1.5)).toBe(100);
  });

  it("falls back to opaque for values that are not numbers at all", () => {
    expect(fillOpacityToPercent(Number.NaN)).toBe(100);
    expect(percentToFillOpacity(Number.NaN)).toBe(1);
    expect(clampFillOpacity(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("keeps 0 distinguishable from an omitted value", () => {
    // `undefined` and `0` both read as "no number here" to truthiness checks; the whole feature
    // depends on them staying apart.
    expect(normalizeFillOpacity(0)).not.toBe(normalizeFillOpacity(undefined));
    expect(fillOpacityToPercent(0)).not.toBe(fillOpacityToPercent(undefined));
  });

  it("rounds to whole percents so the slider and the number box agree", () => {
    expect(fillOpacityToPercent(0.355)).toBe(36);
    expect(fillOpacityToPercent(0.354)).toBe(35);
    expect(percentToFillOpacity(35.4)).toBe(0.35);
  });
});
