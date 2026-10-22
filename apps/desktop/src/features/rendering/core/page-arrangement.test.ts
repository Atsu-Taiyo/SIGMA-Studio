import { describe, expect, it } from "vitest";
import {
  arrangeFlowPlacement,
  createPageArrangement,
  displayCanvasSize,
  displayRectToModel,
  displayToModel,
  modelToDisplay,
  pageIndexAtDisplayPoint,
  pageOrigin,
  pageShift,
  planArrangedFlowRender,
  visiblePageSpanForDisplayRange,
} from "./page-arrangement";
import { buildFlowModel } from "./pagination/build-flow-model";
import type { PageGeometry } from "./pagination/model";
import { placeFlow } from "./pagination/place-flow";
import { planFlowRender } from "./pagination/plan-render";
import type { ProbeTree } from "./pagination/probe-types";

const base = { pageWidth: 600, pageHeight: 800, pageGap: 36 };
const single = createPageArrangement({ ...base, mode: "single" });
const spread = createPageArrangement({ ...base, mode: "spread" });

describe("single-column arrangement", () => {
  it("is the identity everywhere", () => {
    for (const page of [0, 1, 2, 5]) {
      expect(pageShift(single, page)).toEqual({ x: 0, y: 0 });
      expect(pageOrigin(single, page)).toEqual({ x: 0, y: page * 836 });
    }
    const point = { x: 120, y: 2000 };
    expect(modelToDisplay(single, point)).toBe(point);
    expect(displayToModel(single, point)).toEqual({ ...point, page: 2 });
    const rect = { top: 900, left: 40, width: 10, height: 10 };
    expect(displayRectToModel(single, rect)).toBe(rect);
    expect(displayCanvasSize(single, 3)).toEqual({ width: 600, height: 2 * 836 + 800 });
    expect(visiblePageSpanForDisplayRange(single, 900, 1700, 5)).toEqual({ start: 1, end: 2 });
  });
});

describe("two-page spread arrangement", () => {
  it("puts pages 1|2 on the first row and 3|4 below", () => {
    expect(pageOrigin(spread, 0)).toEqual({ x: 0, y: 0 });
    expect(pageOrigin(spread, 1)).toEqual({ x: 636, y: 0 });
    expect(pageOrigin(spread, 2)).toEqual({ x: 0, y: 836 });
    expect(pageOrigin(spread, 3)).toEqual({ x: 636, y: 836 });
    expect(pageShift(spread, 3)).toEqual({ x: 636, y: -2 * 836 });
  });

  it("keeps the shift integral for fractional page sizes", () => {
    const a4 = createPageArrangement({ mode: "spread", pageWidth: 793.7, pageHeight: 1122.52, pageGap: 36 });
    for (const page of [1, 2, 3, 6, 7]) {
      const shift = pageShift(a4, page);
      expect(Number.isInteger(shift.x)).toBe(true);
      expect(Number.isInteger(shift.y)).toBe(true);
    }
  });

  it("round-trips points between model and display coordinates", () => {
    for (const page of [0, 1, 2, 3, 4]) {
      const model = { x: 30 + page, y: page * 836 + 120 };
      const display = modelToDisplay(spread, model);
      expect(displayToModel(spread, display)).toEqual({ ...model, page });
    }
  });

  it("maps gaps to the nearest page", () => {
    expect(pageIndexAtDisplayPoint(spread, { x: 610, y: 10 })).toBe(0);
    expect(pageIndexAtDisplayPoint(spread, { x: 625, y: 10 })).toBe(1);
    expect(pageIndexAtDisplayPoint(spread, { x: 100, y: 810 })).toBe(0);
    expect(pageIndexAtDisplayPoint(spread, { x: 100, y: 825 })).toBe(2);
    expect(pageIndexAtDisplayPoint(spread, { x: -40, y: -40 })).toBe(0);
  });

  it("reads a drawn rect back on the page it sits on", () => {
    expect(displayRectToModel(spread, { top: 900, left: 700, width: 20, height: 30 }))
      .toEqual({ top: 900 + 3 * 836 - 836, left: 64, width: 20, height: 30 });
  });

  it("sizes the canvas for rows of two pages", () => {
    expect(displayCanvasSize(spread, 1)).toEqual({ width: 1236, height: 800 });
    expect(displayCanvasSize(spread, 3)).toEqual({ width: 1236, height: 836 + 800 });
    expect(displayCanvasSize(spread, 4)).toEqual({ width: 1236, height: 836 + 800 });
  });

  it("counts visible pages by display row", () => {
    expect(visiblePageSpanForDisplayRange(spread, 0, 400, 5)).toEqual({ start: 0, end: 1 });
    expect(visiblePageSpanForDisplayRange(spread, 900, 1700, 5)).toEqual({ start: 2, end: 4 });
  });
});

const geometry: PageGeometry = {
  pageHeight: 120, pageGap: 36, contentTop: 10, contentHeight: 100,
  contentLeft: 20, contentWidth: 200, columnCount: 1, columnWidth: 200, columnGap: 0,
};

/** 1 ユニットに 1 段落 (行 15 本)。1 ページに 5 行入るので 3 ページに分かれる。 */
function tallParagraph(): ProbeTree {
  return { units: [{
    id: "unit", rect: { top: 10, bottom: 310, left: 20, width: 200 },
    span: "column", breakBefore: false, attachments: [],
    nodes: [
      {
        id: "first", rect: { top: 10, bottom: 50, left: 20, width: 200 },
        ink: [{ kind: "text" as const, top: 10, bottom: 30 }, { kind: "text" as const, top: 30, bottom: 50 }],
        chrome: [], breakBefore: false,
      },
      {
        id: "tall", rect: { top: 50, bottom: 310, left: 20, width: 200 },
        ink: Array.from({ length: 13 }, (_, row) => ({ kind: "text" as const, top: 50 + row * 20, bottom: 70 + row * 20 })),
        chrome: [], breakBefore: false,
      },
    ],
  }] };
}

describe("arranged render plan", () => {
  it("is the same object in single-column mode", () => {
    const built = buildFlowModel(tallParagraph(), { breakTarget: "page" });
    const placement = placeFlow(built.model, geometry);
    expect(arrangeFlowPlacement(placement, single)).toBe(placement);
  });

  it("shifts content by its page and keeps relative displacements consistent", () => {
    const built = buildFlowModel(tallParagraph(), { breakTarget: "page" });
    const placement = placeFlow(built.model, geometry);
    const arrangement = createPageArrangement({ mode: "spread", pageWidth: 240, pageHeight: 120, pageGap: 36 });
    const model = planFlowRender(built, placement);
    const display = planFlowRender(built, arrangeFlowPlacement(placement, arrangement));
    expect(model.pageCount).toBe(3);
    // ユニット・最初のブロックは 1 ページ目 (ずらし 0)。
    expect(display.unitDisplacements.unit).toEqual(model.unitDisplacements.unit);
    expect(display.nodeDisplacements).toEqual(model.nodeDisplacements);
    // 断片はそのページのずらしだけ動く (2 ページ目は右へ、3 ページ目は 2 行目の左)。
    const modelReplicas = model.fragmentReplicas.tall;
    const displayReplicas = display.fragmentReplicas.tall;
    expect(modelReplicas).toHaveLength(2);
    expect(displayReplicas).toHaveLength(modelReplicas.length);
    displayReplicas.forEach((replica, index) => {
      const page = Math.floor(modelReplicas[index].y / 156);
      const shift = pageShift(arrangement, page);
      expect(replica.x).toBe(modelReplicas[index].x + shift.x);
      expect(replica.y).toBe(modelReplicas[index].y + shift.y);
      expect(replica.sourceOffsetY).toBe(modelReplicas[index].sourceOffsetY);
      expect(replica.height).toBe(modelReplicas[index].height);
    });
    expect(display.fragmentSources).toEqual(model.fragmentSources);
  });
});

/** 5 行の段落だけのユニットを 3 つ。1 ページに 1 ユニットずつ入る。 */
function threeUnits(): ProbeTree {
  return { units: [0, 1, 2].map((index) => {
    const top = 10 + index * 100;
    return {
      id: `u${index}`, rect: { top, bottom: top + 100, left: 20, width: 200 },
      span: "column" as const, breakBefore: false, attachments: [],
      nodes: [{
        id: `p${index}`, rect: { top, bottom: top + 100, left: 20, width: 200 },
        ink: Array.from({ length: 5 }, (_, row) => ({ kind: "text" as const, top: top + row * 20, bottom: top + 20 + row * 20 })),
        chrome: [], breakBefore: false,
      }],
    };
  }) };
}

describe("planArrangedFlowRender", () => {
  it("returns one plan in single-column mode", () => {
    const built = buildFlowModel(threeUnits(), { breakTarget: "page" });
    const plan = planArrangedFlowRender(built, placeFlow(built.model, geometry), single);
    expect(plan.display).toBe(plan.model);
  });

  it("annotates displaced units with the page shift the measurement subtracts", () => {
    const built = buildFlowModel(threeUnits(), { breakTarget: "page" });
    const placement = placeFlow(built.model, geometry);
    const arrangement = createPageArrangement({ mode: "spread", pageWidth: 240, pageHeight: 120, pageGap: 36 });
    const { display, model } = planArrangedFlowRender(built, placement, arrangement);
    expect(model.pageCount).toBe(3);
    expect(display.unitDisplacements.u0).toEqual(model.unitDisplacements.u0);
    for (const [unit, page] of [["u1", 1], ["u2", 2]] as const) {
      const shift = pageShift(arrangement, page);
      expect(display.unitDisplacements[unit]).toEqual({
        dx: model.unitDisplacements[unit].dx + shift.x,
        dy: model.unitDisplacements[unit].dy + shift.y,
        pageShiftX: shift.x,
        pageShiftY: shift.y,
      });
    }
    // ブロックはユニットと同じページなので、相対の変位は変わらない。
    expect(display.nodeDisplacements.p1).toEqual(model.nodeDisplacements.p1);
  });
});
