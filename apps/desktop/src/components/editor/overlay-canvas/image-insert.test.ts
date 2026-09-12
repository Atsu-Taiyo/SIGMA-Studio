import { describe, expect, it } from "vitest";

import { fitImageRowToWidth, fitImageSizeWithinArea } from "./image-insert";

describe("overlay image insertion size", () => {
  it("keeps a natural size that already fits without upscaling", () => {
    expect(fitImageSizeWithinArea(
      { w: 100, h: 60 },
      { w: 800, h: 600 },
    )).toEqual({ w: 100, h: 60 });
  });

  it("downscales proportionally to fit either area dimension", () => {
    expect(fitImageSizeWithinArea(
      { w: 1600, h: 900 },
      { w: 800, h: 600 },
    )).toEqual({ w: 800, h: 450 });
    expect(fitImageSizeWithinArea(
      { w: 600, h: 1200 },
      { w: 800, h: 600 },
    )).toEqual({ w: 300, h: 600 });
  });

  it("keeps a multi-image row within the available width without upscaling", () => {
    expect(fitImageRowToWidth(
      [{ w: 500, h: 250 }, { w: 500, h: 250 }],
      800,
      16,
    )).toEqual([{ w: 392, h: 196 }, { w: 392, h: 196 }]);
    expect(fitImageRowToWidth(
      [{ w: 100, h: 60 }, { w: 120, h: 80 }],
      800,
      16,
    )).toEqual([{ w: 100, h: 60 }, { w: 120, h: 80 }]);
  });
});
