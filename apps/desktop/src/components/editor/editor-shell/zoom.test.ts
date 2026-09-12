import { describe, expect, it } from "vitest";

import { MAX_ZOOM, MIN_ZOOM, ZOOM_PRESETS } from "@/components/editor/editor-shell/constants";
import { clampZoom } from "@/components/editor/editor-shell/zoom";

describe("editor zoom", () => {
  it("clamps every entry path to 10–800%", () => {
    expect(clampZoom(5)).toBe(10);
    expect(clampZoom(9)).toBe(10);
    expect(clampZoom(10)).toBe(10);
    expect(clampZoom(1000)).toBe(800);
    expect(MIN_ZOOM).toBe(10);
    expect(MAX_ZOOM).toBe(800);
  });

  it("offers the low zoom presets in ascending order", () => {
    expect(ZOOM_PRESETS[0]).toBe(10);
    expect(ZOOM_PRESETS.at(-1)).toBe(800);
    expect(ZOOM_PRESETS).toEqual([...ZOOM_PRESETS].sort((left, right) => left - right));
    expect(ZOOM_PRESETS).toEqual(expect.arrayContaining([10, 15, 25, 33]));
  });
});
