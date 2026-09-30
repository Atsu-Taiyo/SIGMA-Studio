import { describe, expect, it } from "vitest";

import { joinBoxColor, splitBoxColor } from "./box-color";

describe("box colors carry their opacity in an 8-digit hex", () => {
  it("splits a color into #rrggbb and an opacity", () => {
    expect(splitBoxColor("#333333")).toEqual({ color: "#333333", opacity: 1 });
    expect(splitBoxColor("#33333380")).toEqual({ color: "#333333", opacity: 0.5 });
    expect(splitBoxColor("#fff")).toEqual({ color: "#ffffff", opacity: 1 });
    expect(splitBoxColor("#ffffff00")).toEqual({ color: "#ffffff", opacity: 0 });
  });

  it("does not pretend to understand names and transparent", () => {
    expect(splitBoxColor("transparent")).toBeNull();
    expect(splitBoxColor("red")).toBeNull();
    expect(splitBoxColor(undefined)).toBeNull();
  });

  it("stores an opaque color as #rrggbb and anything else with an alpha byte", () => {
    expect(joinBoxColor("#333333", 1)).toBe("#333333");
    expect(joinBoxColor("#333333", 0.5)).toBe("#33333380");
    expect(joinBoxColor("#333333", 0)).toBe("#33333300");
  });

  it("round-trips what the palette shows", () => {
    for (const percent of [0, 10, 25, 50, 75, 99, 100]) {
      const joined = joinBoxColor("#1f3864", percent / 100);
      expect(Math.round((splitBoxColor(joined)?.opacity ?? -1) * 100)).toBe(percent);
    }
  });
});
