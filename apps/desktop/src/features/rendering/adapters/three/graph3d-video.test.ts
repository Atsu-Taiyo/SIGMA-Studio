import { describe, expect, it } from "vitest";

import { graph3DVideoPixelSize } from "./graph3d-video";

describe("graph3DVideoPixelSize", () => {
  it("renders well above the size the shape has on the page", () => {
    const size = graph3DVideoPixelSize(320, 240);

    expect(size.scale).toBeCloseTo(4, 5);
    expect(size).toMatchObject({ pixelWidth: 1_280, pixelHeight: 960 });
  });

  it("keeps both sides even, which H.264 requires", () => {
    const size = graph3DVideoPixelSize(333, 251);

    expect(size.pixelWidth % 2).toBe(0);
    expect(size.pixelHeight % 2).toBe(0);
  });

  it("never scales a big shape down, and never blows a small one up past the cap", () => {
    // 長辺が目標を超えていてもそのままの解像度で撮る (縮めると教材より粗くなる)。
    expect(graph3DVideoPixelSize(2_000, 1_000)).toMatchObject({
      scale: 1,
      pixelWidth: 2_000,
      pixelHeight: 1_000,
    });
    // ごく小さい図形を4倍を超えて引き伸ばしても、無いディテールは出てこない。
    expect(graph3DVideoPixelSize(40, 30)).toMatchObject({ scale: 4, pixelWidth: 160, pixelHeight: 120 });
  });
});
