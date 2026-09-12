import { describe, expect, it } from "vitest";

import { getLocalResizeDelta, resizeBounds, shouldPreserveResizeAspect } from "./resize";
import type { OverlayBounds } from "./types";

const bounds: OverlayBounds = { x: 10, y: 20, w: 100, h: 80 };

describe("overlay resize bounds", () => {
  it("resizes from edge handles on one axis only", () => {
    expect(resizeBounds(bounds, "e", 25, 400)).toEqual({ x: 10, y: 20, w: 125, h: 80 });
    expect(resizeBounds(bounds, "w", 25, 400)).toEqual({ x: 35, y: 20, w: 75, h: 80 });
    expect(resizeBounds(bounds, "s", 400, 25)).toEqual({ x: 10, y: 20, w: 100, h: 105 });
    expect(resizeBounds(bounds, "n", 400, 25)).toEqual({ x: 10, y: 45, w: 100, h: 55 });
  });

  it("keeps edge handles axis-only even when aspect preservation is requested", () => {
    expect(resizeBounds(bounds, "e", 25, 400, { preserveAspect: true })).toEqual({ x: 10, y: 20, w: 125, h: 80 });
    expect(resizeBounds(bounds, "s", 400, 25, { targetAspect: 1 })).toEqual({ x: 10, y: 20, w: 100, h: 105 });
  });

  it("preserves existing aspect behavior for corner handles", () => {
    expect(resizeBounds(bounds, "se", 20, 1, { preserveAspect: true })).toEqual({ x: 10, y: 20, w: 120, h: 96 });
    expect(resizeBounds(bounds, "nw", -20, -1, { targetAspect: 1 })).toEqual({ x: -10, y: -20, w: 120, h: 120 });
  });

  it("converts page movement into the rotated selection's local axes", () => {
    expect(getLocalResizeDelta(0, 25, Math.PI / 2).x).toBeCloseTo(25);
    expect(getLocalResizeDelta(0, 25, Math.PI / 2).y).toBeCloseTo(0);
    expect(getLocalResizeDelta(20, 10, 0)).toEqual({ x: 20, y: 10 });
  });

  it("preserves a single image's aspect from corner handles unless Shift is held", () => {
    const imageShapes = [{ type: "image" }] as const;

    for (const handle of ["nw", "ne", "sw", "se"] as const) {
      expect(shouldPreserveResizeAspect(imageShapes, handle, false)).toBe(true);
      expect(shouldPreserveResizeAspect(imageShapes, handle, true)).toBe(false);
    }
  });

  it("keeps the existing Shift behavior outside single-image corner resize", () => {
    expect(shouldPreserveResizeAspect([{ type: "image" }], "e", false)).toBe(false);
    expect(shouldPreserveResizeAspect([{ type: "image" }], "e", true)).toBe(true);
    expect(shouldPreserveResizeAspect([{ type: "text" }], "se", false)).toBe(false);
    expect(shouldPreserveResizeAspect([{ type: "text" }], "se", true)).toBe(true);
    expect(shouldPreserveResizeAspect([{ type: "image" }, { type: "image" }], "se", false)).toBe(false);
    expect(shouldPreserveResizeAspect([{ type: "image" }, { type: "image" }], "se", true)).toBe(true);
  });
});
