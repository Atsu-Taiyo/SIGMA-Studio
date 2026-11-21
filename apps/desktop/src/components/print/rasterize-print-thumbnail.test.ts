import { describe, expect, it } from "vitest";

import { drawWhenSettled, printThumbnailRasterSize } from "./rasterize-print-thumbnail";

describe("printThumbnailRasterSize", () => {
  it("crops the top half of page 1 at about 2x the workspace card width", () => {
    const size = printThumbnailRasterSize(688, 972, 360);
    expect(size.width).toBe(360);
    expect(size.sourceHeight).toBe(486);
    expect(size.height).toBe(Math.round(486 * (360 / 688)));
  });
});

describe("drawWhenSettled", () => {
  it("keeps drawing until the embedded fonts have repainted the image, then stops", async () => {
    // 3 回目の描画で文字が出る (フォントの読み込みが終わる)、その後は変わらない。
    const frames = [[0], [0], [1], [1], [1]].map((pixels) => new Uint8ClampedArray(pixels));
    let draws = 0;
    const waits: number[] = [];
    await drawWhenSettled(() => frames[Math.min(draws++, frames.length - 1)]!, async (ms) => { waits.push(ms); });
    expect(draws).toBe(4);
    expect(waits.length).toBe(3);
  });

  it("gives up after a bounded number of rounds when the image never settles", async () => {
    let draws = 0;
    await drawWhenSettled(() => new Uint8ClampedArray([draws++]), async () => {});
    expect(draws).toBeLessThanOrEqual(14);
  });
});
