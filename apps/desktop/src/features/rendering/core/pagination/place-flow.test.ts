import { describe, expect, it } from "vitest";

import type { FlowItem, FlowLine, FlowModel, PageGeometry } from "./model";
import { placeFlow } from "./place-flow";

// region k = [10 + 156k, 110 + 156k]
const GEOMETRY: PageGeometry = {
  pageHeight: 120,
  pageGap: 36,
  contentTop: 10,
  contentHeight: 100,
  contentLeft: 20,
  contentWidth: 200,
  columnCount: 1,
  columnWidth: 200,
  columnGap: 0,
};

function line(key: string, top: number, height: number, extra: Partial<FlowLine> = {}): FlowLine {
  return { kind: "line", key, ownerId: key, top, fitBottom: top + height, bottom: top + height, leadingSpace: 0, ...extra };
}

function lines(count: number, height: number, start = 10, gap = 0): FlowLine[] {
  return Array.from({ length: count }, (_, index) => line(`l${index}`, start + index * (height + gap), height));
}

function model(items: FlowItem[], span: "column" | "full" = "column"): FlowModel {
  return { sections: [{ key: "s0", span, items }], containers: [] };
}

function placedY(result: ReturnType<typeof placeFlow>, key: string) {
  return result.lines.get(key)?.y;
}

describe("placeFlow", () => {
  it("moves only the line that overflows", () => {
    const result = placeFlow(model(lines(6, 20)), GEOMETRY);
    expect([0, 1, 2, 3, 4].map((index) => placedY(result, `l${index}`))).toEqual([10, 30, 50, 70, 90]);
    expect(placedY(result, "l5")).toBe(166);
    expect(result.pageCount).toBe(2);
  });

  it("keeps a line that fits within 0.5px and moves one that exceeds it", () => {
    const fits = placeFlow(model([line("a", 10, 100.4)]), GEOMETRY);
    expect(fits.pageCount).toBe(1);
    const moves = placeFlow(model([line("a", 10, 60), line("b", 70, 40.6)]), GEOMETRY);
    expect(placedY(moves, "b")).toBe(166);
  });

  it("truncates the margin above a line moved to the next page", () => {
    const items = [...lines(5, 20), line("m", 122, 20)];
    expect(placedY(placeFlow(model(items), GEOMETRY), "m")).toBe(166);
  });

  it("preserves natural gaps inside a region", () => {
    const items = [line("a", 10, 20), line("b", 40, 20)];
    expect(placedY(placeFlow(model(items), GEOMETRY), "b")).toBe(40);
  });

  it("applies a manual break unless nothing is placed yet", () => {
    const items: FlowItem[] = [
      { kind: "break", key: "b0", ownerId: "x", target: "page" },
      line("a", 10, 20),
      { kind: "break", key: "b1", ownerId: "y", target: "page" },
      line("b", 40, 20, { leadingSpace: 8 }),
    ];
    const result = placeFlow(model(items), GEOMETRY);
    expect(placedY(result, "a")).toBe(10);
    expect(placedY(result, "b")).toBe(174);
  });

  it("splits blank space across pages and continues after it", () => {
    const items: FlowItem[] = [
      line("a", 10, 40),
      { kind: "blank", key: "k", ownerId: "u", top: 50, height: 130, virtual: false },
      line("b", 180, 20),
    ];
    const result = placeFlow(model(items), GEOMETRY);
    expect(result.blanks.map((piece) => [piece.y, piece.height])).toEqual([[50, 60], [166, 70]]);
    expect(placedY(result, "b")).toBe(236);
  });

  it("keeps closing chrome with the last blank piece", () => {
    const items: FlowItem[] = [
      line("a", 10, 40),
      { kind: "blank", key: "k", ownerId: "u", top: 50, height: 58, virtual: false, closingChrome: 10 },
    ];
    const result = placeFlow(model(items), GEOMETRY);
    const last = result.blanks.at(-1)!;
    expect(last.y + last.height + 10).toBeLessThanOrEqual(110 + 156 + 0.5);
    expect(result.blanks.reduce((sum, piece) => sum + piece.height, 0)).toBeCloseTo(58);
  });

  it("places a line taller than a page at the page top and clears its overflow", () => {
    const items = [line("a", 10, 20), line("tall", 30, 250), line("b", 280, 20)];
    const result = placeFlow(model(items), GEOMETRY);
    expect(placedY(result, "tall")).toBe(166);
    expect(placedY(result, "b")).toBe(478);
    expect(result.diagnostics.tallLines).toEqual(["tall"]);
  });

  it("keeps glued opening chrome with its first line", () => {
    // 10px の上縁を持つ箱の 1 行目: 行だけなら収まるが、縁ごとでは収まらない。
    const items = [...lines(4, 20), line("box", 90, 22, { top: 90 })];
    const result = placeFlow(model(items), GEOMETRY);
    expect(placedY(result, "box")).toBe(166);
  });

  it("flows through page columns then pages", () => {
    const geometry = { ...GEOMETRY, columnCount: 2, columnWidth: 95, columnGap: 10 };
    const result = placeFlow(model(lines(11, 20)), geometry);
    expect(result.lines.get("l5")).toMatchObject({ y: 10, dx: 105 });
    expect(result.lines.get("l10")).toMatchObject({ y: 166, dx: 0 });
  });

  it("balances the last page's columns before a full-span section", () => {
    const geometry = { ...GEOMETRY, columnCount: 2, columnWidth: 95, columnGap: 10 };
    const result = placeFlow({
      sections: [
        { key: "cols", span: "column", items: lines(6, 20) },
        { key: "full", span: "full", items: [line("f", 130, 20)] },
      ],
      containers: [],
    }, geometry);
    expect(result.lines.get("l2")).toMatchObject({ y: 50, dx: 0 });
    expect(result.lines.get("l3")).toMatchObject({ y: 10, dx: 105 });
    expect(placedY(result, "f")).toBe(70);
    expect(result.diagnostics.balanced).toEqual(["cols"]);
  });

  it("balances a tail that holds a reservation blank", () => {
    const geometry = { ...GEOMETRY, columnCount: 2, columnWidth: 95, columnGap: 10 };
    const blank: FlowItem = { kind: "blank", key: "k", ownerId: "u", top: 50, height: 40, virtual: false, closingChrome: 0 };
    const result = placeFlow({
      sections: [
        { key: "cols", span: "column", items: [...lines(2, 20), blank] },
        { key: "full", span: "full", items: [line("f", 100, 20)] },
      ],
      containers: [],
    }, geometry);
    // 20 + 20 + 40 = 80 を 2 段に: 左に 2 行 (40)、右に空白 (40)。
    expect(result.diagnostics.balanced).toEqual(["cols"]);
    expect(result.blanks).toEqual([expect.objectContaining({ key: "k", y: 10, height: 40 })]);
    expect(placedY(result, "f")).toBe(60);
  });

  it("balances column content that sits in the first column only", () => {
    const geometry = { ...GEOMETRY, columnCount: 2, columnWidth: 95, columnGap: 10 };
    const result = placeFlow({
      sections: [
        { key: "cols", span: "column", items: lines(4, 20) },
        { key: "full", span: "full", items: [line("f", 90, 20)] },
      ],
      containers: [],
    }, geometry);
    expect(result.lines.get("l1")).toMatchObject({ y: 30, dx: 0 });
    expect(result.lines.get("l2")).toMatchObject({ y: 10, dx: 105 });
    expect(placedY(result, "f")).toBe(50);
  });

  it("starts every column of a mid-page column section at its first line", () => {
    const geometry = { ...GEOMETRY, columnCount: 2, columnWidth: 95, columnGap: 10, contentHeight: 100 };
    const tail = lines(4, 20, 48).map((item) => ({ ...item, key: `t${item.key}` }));
    const result = placeFlow({
      sections: [
        { key: "full", span: "full", items: [line("f", 10, 20)] },
        { key: "cols", span: "column", items: tail },
      ],
      containers: [],
    }, geometry);
    // 全幅の行の下端 30 と後続の最初の行 48 の間の 18px は、どちらの段の上端にも入る。
    expect(result.lines.get("tl0")).toMatchObject({ y: 48, dx: 0 });
    expect(result.lines.get("tl3")).toMatchObject({ y: 48, dx: 105 });
  });

  it("flows independent band columns separately and continues after the longest", () => {
    const band: FlowItem = {
      kind: "band",
      key: "band",
      ownerId: "section",
      top: 70,
      bottom: 170,
      columns: [
        { key: "c0", ownerId: "c0", xOffset: 0, width: 90, items: lines(5, 20, 70).map((item) => ({ ...item, key: `a${item.key}` })) },
        { key: "c1", ownerId: "c1", xOffset: 100, width: 90, items: lines(2, 20, 70).map((item) => ({ ...item, key: `b${item.key}` })) },
      ],
    };
    const items = [...lines(3, 20), band, line("after", 180, 20)];
    const result = placeFlow(model(items), GEOMETRY);
    expect(placedY(result, "al1")).toBe(90);
    expect(placedY(result, "al2")).toBe(166);
    expect(result.lines.get("bl1")).toMatchObject({ y: 90, dx: 0 });
    expect(placedY(result, "after")).toBe(236);
  });

  it("is deterministic", () => {
    const items = [...lines(9, 17, 10, 3), { kind: "blank", key: "k", ownerId: "u", top: 190, height: 80, virtual: false } as FlowItem];
    const a = placeFlow(model(items), GEOMETRY);
    const b = placeFlow(model(items), GEOMETRY);
    expect(JSON.stringify([...a.lines.values()])).toBe(JSON.stringify([...b.lines.values()]));
  });
});
