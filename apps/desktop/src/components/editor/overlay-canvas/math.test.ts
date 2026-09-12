import { describe, expect, it } from "vitest";

import { shouldShowArcRadiusHandle, shouldShowPointHandles } from "./math";

describe("point handle visibility thresholds", () => {
  it("hides all point handles when the selection short axis is below 24px", () => {
    expect(shouldShowPointHandles({ x: 0, y: 0, w: 23, h: 100 })).toBe(false);
    expect(shouldShowPointHandles({ x: 0, y: 0, w: 100, h: 23 })).toBe(false);
    expect(shouldShowPointHandles({ x: 0, y: 0, w: 24, h: 100 })).toBe(true);
    expect(shouldShowPointHandles({ x: 0, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("hides the arc radius handle below 40px while angle handles stay visible", () => {
    const bounds = { x: 0, y: 0, w: 39, h: 100 };
    expect(shouldShowPointHandles(bounds)).toBe(true);
    expect(shouldShowArcRadiusHandle(bounds)).toBe(false);
    expect(shouldShowArcRadiusHandle({ x: 0, y: 0, w: 40, h: 100 })).toBe(true);
  });
});
