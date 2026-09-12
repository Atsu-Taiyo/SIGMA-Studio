import { describe, expect, it } from "vitest";

import {
  getWhiteboardBackgroundStyle,
  WHITEBOARD_BASE_CELL_PX,
  WHITEBOARD_PATTERN_FADE_SPACING_PX,
  WHITEBOARD_PATTERN_MIN_SPACING_PX,
} from "@/components/editor/page-canvas/whiteboard-background";

const AT_100 = { zoom: 100, panX: 0, panY: 0 };

/** 生成された gradient から色のアルファを読む。フェードはここに載るのが仕様。 */
function patternAlpha(style: { backgroundImage: string } | null): number {
  const match = style?.backgroundImage.match(/rgba\(85, 85, 85, ([0-9.]+)\)/);
  return match ? Number(match[1]) : 0;
}

describe("getWhiteboardBackgroundStyle", () => {
  it("draws nothing when the ground is off or unset", () => {
    expect(getWhiteboardBackgroundStyle({ background: "none", ...AT_100 })).toBeNull();
    expect(getWhiteboardBackgroundStyle({ background: undefined, ...AT_100 })).toBeNull();
  });

  it("draws dots as a radial gradient", () => {
    const style = getWhiteboardBackgroundStyle({ background: "dots", ...AT_100 });

    expect(style?.backgroundImage).toContain("radial-gradient");
    expect(style?.backgroundImage).not.toContain("linear-gradient");
    expect(style?.backgroundImage).toContain("rgba(85, 85, 85, 0.22)");
  });

  it("draws a grid as two crossed linear gradients", () => {
    const style = getWhiteboardBackgroundStyle({ background: "grid", ...AT_100 });

    expect(style?.backgroundImage).toContain("linear-gradient(to right");
    expect(style?.backgroundImage).toContain("linear-gradient(to bottom");
    expect(style?.backgroundImage).toContain("rgba(85, 85, 85, 0.16)");
  });

  it("keeps the dot radius and line width in screen pixels so they never bloat", () => {
    const near = getWhiteboardBackgroundStyle({ background: "dots", zoom: 100, panX: 0, panY: 0 });
    const far = getWhiteboardBackgroundStyle({ background: "dots", zoom: 400, panX: 0, panY: 0 });

    expect(far?.backgroundImage).toBe(near?.backgroundImage);
  });

  it("scales the cell with the zoom and follows the pan", () => {
    const style = getWhiteboardBackgroundStyle({ background: "grid", zoom: 250, panX: -40, panY: 17.5 });

    expect(style?.backgroundSize).toBe(`${WHITEBOARD_BASE_CELL_PX * 2.5}px ${WHITEBOARD_BASE_CELL_PX * 2.5}px`);
    expect(style?.backgroundPosition).toBe("-40px 17.5px");
  });

  it("draws the ink at full strength once the cells are comfortably apart", () => {
    expect(patternAlpha(getWhiteboardBackgroundStyle({ background: "dots", ...AT_100 }))).toBe(0.22);
    expect(patternAlpha(getWhiteboardBackgroundStyle({ background: "grid", ...AT_100 }))).toBe(0.16);
  });

  it("stops drawing once the cells would be closer than the minimum spacing", () => {
    const zoomFor = (spacing: number) => (spacing / WHITEBOARD_BASE_CELL_PX) * 100;

    expect(getWhiteboardBackgroundStyle({ background: "dots", zoom: 25, panX: 0, panY: 0 })).toBeNull();
    expect(getWhiteboardBackgroundStyle({
      background: "grid",
      zoom: zoomFor(WHITEBOARD_PATTERN_MIN_SPACING_PX - 1),
      panX: 0,
      panY: 0,
    })).toBeNull();
  });

  it("stops at the minimum itself instead of painting a fully transparent pattern", () => {
    expect(getWhiteboardBackgroundStyle({
      background: "dots",
      zoom: (WHITEBOARD_PATTERN_MIN_SPACING_PX / WHITEBOARD_BASE_CELL_PX) * 100,
      panX: 0,
      panY: 0,
    })).toBeNull();
  });

  it("fades the ink, not the whole layer, between the minimum and full visibility", () => {
    // 要素の opacity で薄めると `.whiteboard-background` の下地色まで一緒に消える。
    const midSpacing = (WHITEBOARD_PATTERN_MIN_SPACING_PX + WHITEBOARD_PATTERN_FADE_SPACING_PX) / 2;
    const style = getWhiteboardBackgroundStyle({
      background: "dots",
      zoom: (midSpacing / WHITEBOARD_BASE_CELL_PX) * 100,
      panX: 0,
      panY: 0,
    });

    expect(style).not.toBeNull();
    expect(style).not.toHaveProperty("opacity");
    expect(patternAlpha(style)).toBeGreaterThan(0);
    expect(patternAlpha(style)).toBeLessThan(0.22);
  });

  it("follows the agreed fade schedule at the zoom levels people actually use", () => {
    // セル 24px 基準。63% 以上で完全に見え、そこから下は徐々に薄れ、37.5% 未満で消える。
    const schedule: readonly [number, number | null][] = [
      [100, 0.22],
      [63, 0.22],
      [50, 0.11],
      [42, 0.0396],
      [37.5, null],
      [25, null],
    ];

    for (const [zoom, expected] of schedule) {
      const style = getWhiteboardBackgroundStyle({ background: "dots", zoom, panX: 0, panY: 0 });
      if (expected === null) {
        expect(style, `zoom ${zoom}`).toBeNull();
      } else {
        expect(patternAlpha(style), `zoom ${zoom}`).toBe(expected);
      }
    }
  });

  it("increases the ink alpha monotonically across the fade band", () => {
    const alphas = [40, 45, 50, 55, 60, 63, 100].map((zoom) => (
      patternAlpha(getWhiteboardBackgroundStyle({ background: "dots", zoom, panX: 0, panY: 0 }))
    ));

    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeGreaterThanOrEqual(alphas[index - 1]);
    }
    expect(alphas[0]).toBeGreaterThan(0);
    expect(alphas[0]).toBeLessThan(0.22);
    expect(alphas.at(-1)).toBe(0.22);
  });

  it("keeps 'none' blank at every zoom, threshold or not", () => {
    expect(getWhiteboardBackgroundStyle({ background: "none", zoom: 25, panX: 0, panY: 0 })).toBeNull();
    expect(getWhiteboardBackgroundStyle({ background: "none", zoom: 800, panX: 0, panY: 0 })).toBeNull();
  });
});
