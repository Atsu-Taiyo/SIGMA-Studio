import { describe, expect, it } from "vitest";

import { resolveFirstCellShare, subtitleShareFromFirstShare } from "./box-split-handle";

describe("box split handle geometry", () => {
  it("turns the pointer position into the share of the left cell", () => {
    // 幅 600・隙間なし: 150px の位置は左の欄が 25%。
    expect(resolveFirstCellShare({ pointerX: 150, contentWidth: 600, gapPx: 0 })).toBe(0.25);
    // 隙間 20px は境界の中心が (隙間 / 2) ずれる。使える幅は 580。
    expect(resolveFirstCellShare({ pointerX: 300, contentWidth: 600, gapPx: 20 })).toBe(0.5);
  });

  it("keeps both cells usable", () => {
    expect(resolveFirstCellShare({ pointerX: -80, contentWidth: 600, gapPx: 0 })).toBe(0.05);
    expect(resolveFirstCellShare({ pointerX: 900, contentWidth: 600, gapPx: 0 })).toBe(0.95);
  });

  it("stores the subtitle's share whichever side it sits on", () => {
    expect(subtitleShareFromFirstShare(0.3, "subtitleFirst")).toBe(0.3);
    expect(subtitleShareFromFirstShare(0.3, "titleFirst")).toBe(0.7);
  });
});
