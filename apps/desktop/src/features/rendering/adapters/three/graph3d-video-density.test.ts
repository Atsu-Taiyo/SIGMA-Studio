import { describe, expect, it } from "vitest";

import {
  GRAPH3D_RECORDING_DENSITY_LADDER,
  pickGraph3DRecordingDensity,
} from "./graph3d-video";

describe("動画に焼くplot密度", () => {
  it("この機械が保てる最大の密度まで上げる", () => {
    const tried: number[] = [];
    // 立方コストの図形を模す。倍率1で20ms、2で160ms、3で540ms。
    const density = pickGraph3DRecordingDensity((factor) => {
      tried.push(factor);
      return 20 * factor ** 3;
    }, 100);
    expect(density).toBe(1.5);
    // 予算を超えた最初の1回で止める。天井まで測りにいかない。
    expect(tried).toEqual([1, 1.25, 1.5, 2]);
  });

  it("作者が書いた密度より粗くは焼かない", () => {
    // 倍率1でも予算に収まらない図形。それでも1を返す (粗くするのではなく、コマ数を落とす)。
    expect(pickGraph3DRecordingDensity(() => 500, 100)).toBe(1);
  });

  it("速い図形は段の上限まで届く", () => {
    const density = pickGraph3DRecordingDensity(() => 1, 100);
    expect(density).toBe(GRAPH3D_RECORDING_DENSITY_LADDER.at(-1));
  });
});
