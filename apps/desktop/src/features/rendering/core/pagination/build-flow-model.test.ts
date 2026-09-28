import { describe, expect, it } from "vitest";

import { buildFlowModel, groupInkIntoBands } from "./build-flow-model";
import type { ProbeInnerBreak } from "./probe-types";

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

describe("manual breaks inside a top-level block (quote, box)", () => {
  // 3 行の引用。2 行目と 3 行目の間に改ページの印 (y=62〜86) があり、3 行目の子の上端は y=96。
  const quoteNode = (innerBreaks: ProbeInnerBreak[]) => ({
    id: "quote",
    rect: { top: 0, bottom: 130, left: 0, width: 400 },
    ink: [
      { top: 4, bottom: 26, kind: "text" as const },
      { top: 34, bottom: 56, kind: "text" as const },
      { top: 98, bottom: 120, kind: "text" as const },
    ],
    chrome: [],
    breakBefore: false,
    innerBreaks,
  });
  const tree = (innerBreaks: ProbeInnerBreak[], unitBreak = false) => ({
    units: [{
      id: "unit",
      rect: { top: 0, bottom: 130, left: 0, width: 400 },
      span: "column" as const,
      breakBefore: unitBreak,
      nodes: [quoteNode(innerBreaks)],
      attachments: [],
      objects: [],
    }],
  });

  it("breaks before the child's first line and keeps the marker space with the previous page", () => {
    const built = buildFlowModel(tree([{ top: 96, contentEnd: 62 }]), { breakTarget: "page" });
    const items = built.model.sections[0].items;
    expect(items.map((item) => item.kind)).toEqual(["line", "line", "break", "line"]);
    // 送った先の行はその子の上端から始まる (印は前の片に残る)。文字の上端より下にはしない。
    const moved = items[3];
    expect(moved.kind === "line" && moved.top).toBe(96);
    // 印を描かない面が前の片を切る位置 (印の上端)。
    expect(moved.kind === "line" && built.manualBreakContentEnds.get(moved.key)).toBe(62);
  });

  it("treats a break before the first line as a break before the whole block", () => {
    const built = buildFlowModel(tree([{ top: 0, contentEnd: 0 }]), { breakTarget: "column" });
    expect(built.model.sections[0].items.map((item) => item.kind)).toEqual(["break", "line", "line", "line"]);
    const [breakItem] = built.model.sections[0].items;
    expect(breakItem.kind === "break" && breakItem.target).toBe("column");
    // ユニットの区切りと重ねて二重に数えない。
    expect(buildFlowModel(tree([{ top: 0, contentEnd: 0 }], true), { breakTarget: "page" }).model.sections[0].items
      .filter((item) => item.kind === "break")).toHaveLength(1);
  });
});
