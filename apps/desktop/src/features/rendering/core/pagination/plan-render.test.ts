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
    span: "column", breakBefore: false, attachments: [], objects: [], nodes: [],
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
