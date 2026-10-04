import { describe, expect, it } from "vitest";

import { buildFlowModel, groupInkIntoBands } from "./build-flow-model";
import type { FlowLine, PageGeometry } from "./model";
import { placeFlow } from "./place-flow";
import { planFlowRender } from "./plan-render";
import type { ProbeInk, ProbeInnerBreak, ProbeNode, ProbeTree } from "./probe-types";

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

describe("extension nodes (feature content placed after a body block)", () => {
  // 段落 a (0〜20) → 拡張ノード (30〜130、中身の行は 3 本) → 段落 b (140〜160)。
  const textNode = (id: string, top: number): ProbeNode => ({
    id,
    rect: { top, bottom: top + 20, left: 0, width: 400 },
    ink: [{ top, bottom: top + 20, kind: "text" }],
    chrome: [],
    breakBefore: false,
  });
  const extensionNode: ProbeNode = {
    id: "extension:card",
    kind: "extension",
    rect: { top: 30, bottom: 130, left: 0, width: 400 },
    ink: [
      { top: 40, bottom: 60, kind: "text" },
      { top: 70, bottom: 90, kind: "text" },
      { top: 100, bottom: 115, kind: "text" },
    ],
    chrome: [],
    breakBefore: false,
  };
  const tree = (attachments: ProbeInk[] = []): ProbeTree => ({
    units: [{
      id: "unit",
      rect: { top: 0, bottom: 160, left: 0, width: 400 },
      span: "column",
      breakBefore: false,
      nodes: [textNode("a", 0), extensionNode, textNode("b", 140)],
      attachments,
    }],
  });
  const extensionLines = (built: ReturnType<typeof buildFlowModel>): FlowLine[] => (
    built.units[0].nodes.find((node) => node.id === extensionNode.id)?.lineKeys
      .map((key) => built.lines.get(key)!) ?? []
  );
  // 領域 0 = [0, 120]、領域 1 = [160, 280]。
  const geometry: PageGeometry = {
    pageHeight: 140, pageGap: 20, contentTop: 0, contentHeight: 120,
    contentLeft: 0, contentWidth: 400, columnCount: 1, columnWidth: 400, columnGap: 0,
  };

  it("makes each row of the node its own line between the surrounding blocks, in document order", () => {
    const built = buildFlowModel(tree(), { breakTarget: "page" });
    expect(built.model.sections[0].items.map((item) => item.key)).toEqual([
      "a#0", "extension:card#0", "extension:card#1", "extension:card#2", "b#0",
    ]);
  });

  it("glues the node's own edges to its first and last line", () => {
    const lines = extensionLines(buildFlowModel(tree(), { breakTarget: "page" }));
    expect(lines.map((line) => [line.top, line.fitBottom])).toEqual([[30, 60], [65, 90], [95, 130]]);
    expect(lines[0].opens).toEqual(["extension:card"]);
    expect(lines[2].closes).toEqual(["extension:card"]);
  });

  it("never absorbs a unit attachment (problem number) into the node", () => {
    const built = buildFlowModel(tree([{ top: 42, bottom: 58, kind: "atom" }]), { breakTarget: "page" });
    expect(extensionLines(built).map((line) => line.fitBottom)).toEqual([60, 90, 130]);
    expect(built.units[0].ownLineKeys).toEqual(["unit#attachment0"]);
  });

  it("moves only the overflowing row (with the closing edge) to the next page and continues the node there", () => {
    const built = buildFlowModel(tree(), { breakTarget: "page" });
    const placement = placeFlow(built.model, geometry);
    expect(["extension:card#0", "extension:card#1", "extension:card#2", "b#0"].map((key) => placement.lines.get(key)?.y))
      .toEqual([30, 65, 160, 205]);
    const plan = planFlowRender(built, placement);
    // 正本は 2 行目の後で切り、続きは次のページの頭から 3 行目以降を描く。
    expect(plan.fragmentSources["extension:card"]).toEqual({
      visibleHeight: 65,
      origin: { x: 0, y: 30, width: 400 },
      totalHeight: 100,
    });
    expect(plan.fragmentReplicas["extension:card"]).toEqual([{
      blockId: "extension:card",
      fragmentIndex: 1,
      sourceOffsetY: 65,
      height: 35,
      x: 0,
      y: 160,
      width: 400,
      totalHeight: 100,
    }]);
    expect(plan.nodeDisplacements["extension:card"]).toEqual({ dx: 0, dy: 0 });
    expect(plan.nodeDisplacements.b).toEqual({ dx: 0, dy: 65 });
  });
});
