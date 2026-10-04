import { describe, expect, it } from "vitest";
import { buildFlowModel } from "./build-flow-model";
import { placeFlow } from "./place-flow";
import { planFlowRender } from "./plan-render";
import type { PageGeometry } from "./model";
import type { ProbeTree } from "./probe-types";

const geometry: PageGeometry = {
  pageHeight: 120, pageGap: 36, contentTop: 10, contentHeight: 100,
  contentLeft: 20, contentWidth: 200, columnCount: 1, columnWidth: 200, columnGap: 0,
};
function columns(count: number, rows: number): ProbeTree {
  return { units: [{
    id: "columns", rect: { top: 8, bottom: 10 + rows * 20, left: 20, width: 200 },
    span: "column", breakBefore: false, attachments: [], nodes: [],
    columns: Array.from({ length: count }, (_, index) => ({
      index, rect: { top: 10, bottom: 10 + rows * 20, left: 20 + index * 100, width: 90 },
      nodes: Array.from({ length: rows - index }, (_, row) => ({
        id: `c${index}p${row}`,
        rect: { top: 10 + row * 20, bottom: 30 + row * 20, left: 20 + index * 100, width: 90 },
        ink: [{ kind: "text" as const, top: 10 + row * 20, bottom: 30 + row * 20 }],
        chrome: [], breakBefore: false,
      })),
    })),
  }] };
}

describe("column separator placement", () => {
  it.each([2, 3])("uses the longest of %i columns and excludes page gaps", count => {
    const built = buildFlowModel(columns(count, 12), { breakTarget: "page" });
    const plan = planFlowRender(built, placeFlow(built.model, geometry));
    expect(plan.columnRulePieces.columns).toEqual([
      { x: 0, y: 0, height: 100 },
      { x: 0, y: 156, height: 100 },
      { x: 0, y: 312, height: 40 },
    ]);
  });
  it("follows enclosing page columns horizontally before moving to the next page", () => {
    const built = buildFlowModel(columns(2, 12), { breakTarget: "column" });
    const plan = planFlowRender(built, placeFlow(built.model, {
      ...geometry, contentWidth: 420, columnCount: 2, columnGap: 20,
    }));
    expect(plan.columnRulePieces.columns).toEqual([
      { x: 0, y: 0, height: 100 },
      { x: 220, y: 0, height: 100 },
      { x: 0, y: 156, height: 40 },
    ]);
  });
  it("keeps the measured grid origin for a single short section", () => {
    const built = buildFlowModel(columns(2, 2), { breakTarget: "page" });
    const plan = planFlowRender(built, placeFlow(built.model, geometry));
    expect(plan.columnRulePieces.columns).toEqual([{ x: 0, y: 0, height: 40 }]);
  });
});

describe("fragments split by a manual break inside a block", () => {
  // 引用の 2 行目と 3 行目の間に改ページ。印は y=62〜86、3 行目の子は y=96 から。
  const tree: ProbeTree = { units: [{
    id: "unit", rect: { top: 10, bottom: 130, left: 20, width: 200 },
    span: "column", breakBefore: false, attachments: [],
    nodes: [{
      id: "quote", rect: { top: 10, bottom: 130, left: 20, width: 200 },
      ink: [
        { kind: "text", top: 14, bottom: 36 },
        { kind: "text", top: 40, bottom: 58 },
        { kind: "text", top: 98, bottom: 120 },
      ],
      chrome: [], breakBefore: false,
      innerBreaks: [{ top: 96, contentEnd: 62 }],
    }],
  }] };
  const tall: PageGeometry = { ...geometry, pageHeight: 400, contentHeight: 380 };

  it("keeps the marker in the first piece on the editing surface", () => {
    const built = buildFlowModel(tree, { breakTarget: "page" });
    const plan = planFlowRender(built, placeFlow(built.model, tall));
    expect(plan.fragmentSources.quote.visibleHeight).toBe(96 - 10);
    expect(plan.fragmentReplicas.quote).toHaveLength(1);
  });

  it("ends the first piece where the marker starts when markers are not drawn (print/PDF)", () => {
    const built = buildFlowModel(tree, { breakTarget: "page" });
    const placement = placeFlow(built.model, tall);
    const editor = planFlowRender(built, placement);
    const paged = planFlowRender(built, placement, { hideManualBreakMarkers: true });
    expect(paged.fragmentSources.quote.visibleHeight).toBe(62 - 10);
    // どの行がどのページに行くか・続きの描き始めは同じ。
    expect(paged.fragmentReplicas).toEqual(editor.fragmentReplicas);
    expect(paged.pageCount).toBe(editor.pageCount);
  });
});
