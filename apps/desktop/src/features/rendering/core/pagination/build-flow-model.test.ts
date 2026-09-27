import { describe, expect, it } from "vitest";

import { groupInkIntoBands } from "./build-flow-model";

describe("groupInkIntoBands", () => {
  it("keeps tightly spaced lines apart even when their glyph boxes overlap", () => {
    // 行送り 16px、文字の矩形 23px (line-height が文字より小さい段落)。
    const ink = [0, 16, 32].map((top) => ({ top, bottom: top + 23 }));
    const bands = groupInkIntoBands(ink);
    expect(bands).toHaveLength(3);
    // 重なりの中ほどを境にする。
    expect(bands[0]).toEqual({ top: 0, bottom: 19.5 });
    expect(bands[1]).toEqual({ top: 19.5, bottom: 35.5 });
    expect(bands[2]).toEqual({ top: 35.5, bottom: 55 });
  });

  it("joins ink drawn on the same line (taller atoms, raised or lowered text)", () => {
    const bands = groupInkIntoBands([
      { top: 0, bottom: 23 },
      { top: -8, bottom: 30 },
      { top: -5, bottom: 8 },
      { top: 14, bottom: 26 },
      { top: 40, bottom: 63 },
    ]);
    expect(bands).toEqual([{ top: -8, bottom: 30 }, { top: 40, bottom: 63 }]);
  });

  it("treats rects that only touch within rounding as separate lines", () => {
    expect(groupInkIntoBands([{ top: 0, bottom: 20.5 }, { top: 20, bottom: 40 }])).toHaveLength(2);
  });
});
