import { describe, expect, it } from "vitest";

import { FLOW_EPS, type FlowBand, type FlowItem, type FlowLine, type FlowModel, type FlowSection, type PageGeometry } from "./model";
import { placeFlow } from "./place-flow";

/**
 * 乱数で作った行モデルに対して、配置エンジンの不変条件を確かめる。
 *
 * I1 すべての行がちょうど 1 回置かれる。
 * I2 行は領域の中に収まる (領域より背の高い行は領域の頭に置かれる)。
 * I3 最小性: 領域 r の最後の行 L と、同じ流れで次に置かれた行 M が別の領域にあるとき、
 *    M は r の残りに入らない (間に手動改ページ・空白・独立段組があるときは除く)。
 * I4 同じ流れの中で、行は (領域, y) の順に並ぶ。
 * I5 決定的。
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  model: FlowModel;
  geometry: PageGeometry;
  /** 流れごとの項目 (行・改ページ・空白・band) を文書順に。 */
  flows: Map<string, FlowItem[]>;
}

function generate(seed: number): Generated {
  const random = mulberry32(seed);
  const pick = (min: number, max: number) => min + random() * (max - min);
  const columnCount = 1 + Math.floor(random() * 3);
  const contentHeight = Math.round(pick(80, 400));
  const geometry: PageGeometry = {
    pageHeight: contentHeight + 40,
    pageGap: 30,
    contentTop: 20,
    contentHeight,
    contentLeft: 10,
    contentWidth: 300,
    columnCount,
    columnWidth: (300 - 10 * (columnCount - 1)) / columnCount,
    columnGap: 10,
  };
  const flows = new Map<string, FlowItem[]>();
  let y = geometry.contentTop;
  let serial = 0;
  const makeLine = (flowKey: string, top: number): FlowLine => {
    const height = random() < 0.02 ? pick(contentHeight * 1.1, contentHeight * 1.8) : pick(5, 60);
    const glue = random() < 0.1 ? pick(2, 12) : 0;
    const key = `${flowKey}:l${serial}`;
    serial += 1;
    return { kind: "line", key, ownerId: key, top, fitBottom: top + height + glue, bottom: top + height + glue, leadingSpace: random() < 0.2 ? pick(0, 10) : 0 };
  };
  const rootItems: FlowItem[] = [];
  flows.set("root", rootItems);
  const itemCount = 5 + Math.floor(random() * 60);
  for (let index = 0; index < itemCount; index += 1) {
    const gap = random() < 0.5 ? 0 : pick(0, 20);
    y += gap;
    const roll = random();
    if (roll < 0.05) {
      rootItems.push({ kind: "break", key: `break${serial++}`, ownerId: "b", target: random() < 0.5 ? "page" : "column" });
    } else if (roll < 0.1) {
      const height = pick(0, 400);
      rootItems.push({ kind: "blank", key: `blank${serial++}`, ownerId: "k", top: y, height, virtual: false, closingChrome: random() < 0.3 ? pick(1, 10) : 0 });
      y += height;
    } else if (roll < 0.15) {
      const bandKey = `band${serial++}`;
      const columns = Array.from({ length: 2 + Math.floor(random() * 2) }, (_, columnIndex) => {
        const key = `${bandKey}:c${columnIndex}`;
        const items: FlowItem[] = [];
        let columnY = y;
        for (let lineIndex = 0; lineIndex < 1 + Math.floor(random() * 10); lineIndex += 1) {
          const line = makeLine(key, columnY);
          items.push(line);
          columnY = line.bottom + (random() < 0.5 ? 0 : pick(0, 8));
        }
        flows.set(key, items);
        return { key, ownerId: key, xOffset: columnIndex * 50, width: 45, items };
      });
      const bottom = Math.max(...columns.flatMap((column) => column.items.map((item) => (item as FlowLine).bottom)));
      const band: FlowBand = { kind: "band", key: bandKey, ownerId: bandKey, top: y, bottom, columns };
      rootItems.push(band);
      y = bottom;
    } else {
      const line = makeLine("root", y);
      rootItems.push(line);
      y = line.bottom;
    }
  }
  return { model: { sections: [{ key: "s0", span: "column", items: rootItems }], containers: [] }, geometry, flows };
}

describe("placeFlow invariants (seeded)", () => {
  it("holds I1-I5 for 2,000 random models", () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const { model, geometry, flows } = generate(seed);
      const placement = placeFlow(model, geometry);
      const again = placeFlow(model, geometry);
      const label = `seed ${seed}`;
      // I5
      expect(JSON.stringify([...again.lines.entries()]), label).toBe(JSON.stringify([...placement.lines.entries()]));
      for (const [flowKey, items] of flows) {
        const lines = items.filter((item): item is FlowLine => item.kind === "line");
        let previous: { line: FlowLine; y: number; regionIndex: number } | null = null;
        let interrupted = false;
        for (const item of items) {
          if (item.kind !== "line") {
            interrupted = true;
            continue;
          }
          const placed = placement.lines.get(item.key);
          // I1
          expect(placed, `${label} ${flowKey} ${item.key} placed`).toBeDefined();
          if (!placed) continue;
          const region = placement.regions[placed.regionIndex];
          const height = item.fitBottom - item.top;
          // I2 (背の高い行 = 空の領域 1 つ分より高い行。途中から始まる領域の残りで判断しない)
          if (height <= geometry.contentHeight + FLOW_EPS) {
            expect(placed.y, `${label} ${item.key} top`).toBeGreaterThanOrEqual(region.top - FLOW_EPS);
            expect(placed.y + height, `${label} ${item.key} bottom`).toBeLessThanOrEqual(region.bottom + FLOW_EPS);
          } else {
            expect(placed.y, `${label} ${item.key} tall`).toBe(region.top);
          }
          if (previous) {
            const previousRegion = placement.regions[previous.regionIndex];
            // I4
            if (previous.regionIndex === placed.regionIndex) {
              expect(placed.y, `${label} ${item.key} order`).toBeGreaterThanOrEqual(previous.y - FLOW_EPS);
            }
            // I3
            const previousHeight = previous.line.fitBottom - previous.line.top;
            const previousWasTall = previousHeight > geometry.contentHeight + FLOW_EPS;
            if (!interrupted && previous.regionIndex !== placed.regionIndex && !previousWasTall) {
              const wouldTop = previous.y + (previous.line.bottom - previous.line.top) + (item.top - previous.line.bottom);
              expect(wouldTop + height, `${label} ${item.key} minimal`).toBeGreaterThan(previousRegion.bottom + FLOW_EPS);
            }
          }
          previous = { line: item, y: placed.y, regionIndex: placed.regionIndex };
          interrupted = false;
        }
        expect(lines.every((line) => placement.lines.has(line.key)), label).toBe(true);
      }
    }
  });
});

/**
 * 段組みの区間と全幅の区間が交互に来る文書。
 *
 * J1 すべての行がちょうど 1 回、領域の中に置かれる (背の高い行を除く)。
 * J2 同じページでは、後の区間の行・空白は前の区間のどの行・空白よりも下にある。
 * J3 最小性: 同じ区間で次の領域へ送られた行は前の領域の残りに入らない
 *    (全幅の区間の直前で左右を揃えたページの段から段への送りを除く)。
 */
function generateSections(seed: number): { model: FlowModel; geometry: PageGeometry } {
  const random = mulberry32(seed);
  const pick = (min: number, max: number) => min + random() * (max - min);
  const columnCount = 2 + Math.floor(random() * 2);
  const contentHeight = Math.round(pick(120, 400));
  const geometry: PageGeometry = {
    pageHeight: contentHeight + 40,
    pageGap: 30,
    contentTop: 20,
    contentHeight,
    contentLeft: 10,
    contentWidth: 300,
    columnCount,
    columnWidth: (300 - 10 * (columnCount - 1)) / columnCount,
    columnGap: 10,
  };
  let y = geometry.contentTop;
  let serial = 0;
  const sections: FlowSection[] = [];
  const sectionCount = 1 + Math.floor(random() * 5);
  let span: "column" | "full" = random() < 0.5 ? "column" : "full";
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const items: FlowItem[] = [];
    const itemCount = 1 + Math.floor(random() * 25);
    for (let index = 0; index < itemCount; index += 1) {
      y += random() < 0.5 ? 0 : pick(0, 15);
      if (span === "column" && random() < 0.08) {
        const height = pick(0, 200);
        const closingChrome = random() < 0.3 ? pick(1, 8) : 0;
        items.push({ kind: "blank", key: `blank${serial++}`, ownerId: "k", top: y, height, virtual: false, closingChrome });
        y += height + closingChrome;
        continue;
      }
      const height = pick(5, 50);
      const key = `s${sectionIndex}:l${serial++}`;
      items.push({ kind: "line", key, ownerId: key, top: y, fitBottom: y + height, bottom: y + height, leadingSpace: 0 });
      y += height;
    }
    sections.push({ key: `s${sectionIndex}`, span, items });
    span = span === "column" ? "full" : "column";
  }
  return { model: { sections, containers: [] }, geometry };
}

describe("placeFlow invariants with full-width sections (seeded)", () => {
  it("holds J1-J3 for 1,500 random section sequences", () => {
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const { model, geometry } = generateSections(seed);
      const placement = placeFlow(model, geometry);
      const label = `seed ${seed}`;
      const extentOf = (item: FlowItem): { page: number; top: number; bottom: number }[] => {
        if (item.kind === "line") {
          const placed = placement.lines.get(item.key);
          if (!placed) return [];
          const region = placement.regions[placed.regionIndex];
          return [{ page: region.page, top: placed.y, bottom: placed.y + (item.fitBottom - item.top) }];
        }
        if (item.kind === "blank") {
          return placement.blanks.filter((piece) => piece.key === item.key).map((piece) => ({
            page: placement.regions[piece.regionIndex].page,
            top: piece.y,
            bottom: piece.y + piece.height,
          }));
        }
        return [];
      };
      const balancedPages = new Set(placement.diagnostics.balancedTails.map((tail) => `${tail.sectionKey}:${tail.page}`));
      model.sections.forEach((section, sectionIndex) => {
        let previous: { line: FlowLine; y: number; regionIndex: number } | null = null;
        let interrupted = false;
        for (const item of section.items) {
          if (item.kind !== "line") {
            interrupted = true;
            continue;
          }
          const placed = placement.lines.get(item.key);
          // J1
          expect(placed, `${label} ${item.key} placed`).toBeDefined();
          if (!placed) continue;
          const region = placement.regions[placed.regionIndex];
          const height = item.fitBottom - item.top;
          const tall = height > geometry.contentHeight + FLOW_EPS;
          if (!tall) {
            expect(placed.y, `${label} ${item.key} top`).toBeGreaterThanOrEqual(region.top - FLOW_EPS);
            expect(placed.y + height, `${label} ${item.key} bottom`).toBeLessThanOrEqual(region.bottom + FLOW_EPS);
          }
          // J3
          if (previous && !interrupted && previous.regionIndex !== placed.regionIndex) {
            const previousRegion = placement.regions[previous.regionIndex];
            const previousHeight = previous.line.fitBottom - previous.line.top;
            const previousTall = previousHeight > geometry.contentHeight + FLOW_EPS;
            const withinBalancedPage = previousRegion.page === region.page && balancedPages.has(`${section.key}:${region.page}`);
            if (!previousTall && !withinBalancedPage) {
              const wouldTop = previous.y + (previous.line.bottom - previous.line.top) + (item.top - previous.line.bottom);
              expect(wouldTop + height, `${label} ${item.key} minimal`).toBeGreaterThan(previousRegion.bottom + FLOW_EPS);
            }
          }
          previous = { line: item, y: placed.y, regionIndex: placed.regionIndex };
          interrupted = false;
        }
        // J2
        if (sectionIndex === 0) return;
        const earlier = model.sections.slice(0, sectionIndex).flatMap((other) => other.items.flatMap(extentOf));
        const hasTall = placement.diagnostics.tallLines.length > 0;
        if (hasTall) return;
        for (const extent of section.items.flatMap(extentOf)) {
          for (const before of earlier) {
            if (before.page !== extent.page) continue;
            expect(extent.top, `${label} ${section.key} below earlier sections on page ${extent.page}`).toBeGreaterThanOrEqual(before.bottom - FLOW_EPS);
          }
        }
      });
    }
  });
});
