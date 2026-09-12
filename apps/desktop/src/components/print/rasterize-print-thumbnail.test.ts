import { describe, expect, it } from "vitest";

import { printThumbnailRasterSize } from "./rasterize-print-thumbnail";

describe("printThumbnailRasterSize", () => {
  it("crops the top half of page 1 at about 2x the workspace card width", () => {
    const size = printThumbnailRasterSize(688, 972, 360);
    expect(size.width).toBe(360);
    expect(size.sourceHeight).toBe(486);
    expect(size.height).toBe(Math.round(486 * (360 / 688)));
  });
});
