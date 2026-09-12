// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { getPageMetrics, normalizePageLayout, type ProblemNode, type RichBlock, type SigmaBlock } from "@/features/document";
import type { MeasuredBlock } from "@/features/drawing";

import { composeFlowMeasurement } from "./incremental-layout";
import { buildRenderUnits } from "./render-units";
import { computeSingleColumnLayouts, measureSingleColumnLayoutInput } from "./single-column-layout";

function paragraph(id: string, pagination?: RichBlock["pagination"]): RichBlock {
  return { type: "paragraph", id, children: [{ type: "text", text: id }], ...(pagination ? { pagination } : {}) };
}

function problem(overrides: Partial<ProblemNode>): ProblemNode {
  return { type: "problem", id: "problem", tags: [], lead: [], prompt: [], hints: [], solution: [], ...overrides };
}

function measured(id: string, top: number, height: number): MeasuredBlock {
  return { id, top, height, left: 10, width: 200, lines: [] };
}

function fixture(content: SigmaBlock[], blocks: MeasuredBlock[], zoomFactor = 1) {
  const metrics = getPageMetrics(normalizePageLayout());
  metrics.content.heightPx = 100;
  metrics.content.widthPx = 200;
  metrics.margins.topPx = 10;
  metrics.margins.leftPx = 10;
  const flow = document.createElement("div");
  const units = buildRenderUnits(content);
  const element = (top: number, height: number, width = 200, left = 10) => {
    const node = document.createElement("div");
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(
      30 + left * zoomFactor, 50 + top * zoomFactor, width * zoomFactor, height * zoomFactor,
    ));
    return node;
  };
  vi.spyOn(flow, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 50, 220 * zoomFactor, 500 * zoomFactor));
  const addUnit = (id: string, top: number, height: number, marginTop = 0) => {
    const node = element(top, height);
    node.dataset.flowUnitId = id;
    node.style.marginTop = `${marginTop}px`;
    flow.append(node);
    return node;
  };
  const input = {
    content, flow, units, metrics, zoomFactor,
    pageHeightPx: 120, pageStride: 140, marginTopPx: 10, contentHeightPx: 100,
    reserveSpaceGaps: {} as Record<string, number>,
    measuredAppliedGaps: null,
    measurement: composeFlowMeasurement([{ unitId: null, entries: blocks.map((block) => ({ block, isFlowUnit: true })) }]),
  };
  return { input, addUnit, element, compute: () => computeSingleColumnLayouts(measureSingleColumnLayoutInput(input)) };
}

describe("single-column measured layout", () => {
  it("cuts a short box at a nested manual break without adding the descendant twice to the page walk", () => {
    const box: SigmaBlock = { type: "boxBlock", id: "box", styleId: "itembox", blocks: [paragraph("a"), paragraph("b", { break: true })] };
    const f = fixture([box, paragraph("after")], [measured("box", 10, 80), measured("after", 90, 10)]);
    f.input.measurement.rects.set("a", { ...measured("a", 20, 20), containerId: "box" });
    f.input.measurement.rects.set("b", { ...measured("b", 50, 20), containerId: "box" });
    expect(f.compute()).toMatchObject({
      pageCount: 2,
      boxFragmentSourceLayouts: { box: { visibleHeight: 40, totalHeight: 80 } },
      boxBlockFragmentLayouts: { box: [{ sourceOffsetY: 40, y: 150, height: 40 }] },
      gaps: { after: 100 },
    });
  });

  it.each([0.5, 1, 1.5])("keeps manual breaks and figure reservations stable across DOM gap commits at zoom %s", (zoom) => {
    const content = [paragraph("first"), paragraph("second", { break: true })];
    const run = (appliedGap: number) => {
      const f = fixture(content, [measured("first", 10, 20), measured("second", 30 + appliedGap, 20)], zoom);
      f.input.reserveSpaceGaps = { second: 35 };
      const spacer = document.createElement("div");
      spacer.dataset.pageBreakSpacer = "";
      spacer.dataset.pageBreakBlockId = "second";
      Object.defineProperty(spacer, "offsetHeight", { value: appliedGap });
      f.input.flow.append(spacer);
      return f.compute();
    };
    const pending = run(15);
    expect(pending.gaps).toEqual({ second: 120 });
    expect(pending.pageCount).toBe(2);
    expect(run(120)).toEqual(pending);
    expect(content[1].pagination).toEqual({ break: true });
  });

  it("moves an explicit keep-with-next pair together", () => {
    const f = fixture(
      [paragraph("first"), paragraph("heading", { keepWithNext: true }), paragraph("body")],
      [measured("first", 10, 60), measured("heading", 70, 20), measured("body", 90, 30)],
    );
    expect(f.compute()).toMatchObject({ gaps: { heading: 80 }, pageCount: 2, boxBlockFragmentLayouts: {} });
  });

  it("keeps the problem number, lead unit chrome and framed prompt together", () => {
    const p = problem({ lead: [paragraph("lead")], prompt: [paragraph("prompt")], frame: { enabled: true } });
    const f = fixture([paragraph("before"), p], [measured("before", 10, 60), measured("lead", 80, 10), measured("prompt", 90, 10)]);
    const leadUnit = f.input.units.find((unit) => unit.type === "problemArea" && unit.area === "lead")!;
    const promptUnit = f.input.units.find((unit) => unit.type === "problemArea" && unit.area === "prompt")!;
    f.addUnit(leadUnit.id, 70, 25);
    f.addUnit(promptUnit.id, 90, 26);
    expect(f.compute()).toMatchObject({ gaps: { problem: 70 }, pageCount: 2 });
  });

  it("splits a framed prompt at its nested manual break and preserves both frame rectangles", () => {
    const p = problem({ prompt: [paragraph("first"), paragraph("second", { break: true })], frame: { enabled: true } });
    const f = fixture([p], [measured("first", 10, 40), measured("second", 50, 40)]);
    const unit = f.input.units.find((candidate) => candidate.type === "problemArea" && candidate.area === "prompt")!;
    f.addUnit(unit.id, 10, 80);
    expect(f.compute()).toMatchObject({
      gaps: { second: 100 }, pageCount: 2,
      frameFragmentLayouts: { [unit.id]: [
        { x: 0, y: 0, width: 200, height: 40 },
        { x: 0, y: 140, width: 200, height: 40 },
      ] },
    });
  });

  it("reserves frame chrome on every page of a paragraph split at measured lines", () => {
    const p = problem({ prompt: [paragraph("long")], frame: { enabled: true } });
    const block = measured("long", 10, 200);
    block.lines = Array.from({ length: 10 }, (_, index) => ({ index, top: 10 + index * 20, height: 20 }));
    const f = fixture([p], [block]);
    const unit = f.input.units.find((candidate) => candidate.type === "problemArea" && candidate.area === "prompt")!;
    f.addUnit(unit.id, 10, 216);
    const result = f.compute();
    expect(result.pageCount).toBe(3);
    expect(result.boxFragmentSourceLayouts).toEqual({ long: { visibleHeight: 80, totalHeight: 200, origin: { x: 10, y: 10, width: 200 } } });
    expect(result.boxBlockFragmentLayouts.long).toEqual([
      { blockId: "long", fragmentIndex: 1, sourceOffsetY: 80, height: 80, x: 10, y: 150, width: 200, totalHeight: 200 },
      { blockId: "long", fragmentIndex: 2, sourceOffsetY: 160, height: 40, x: 10, y: 290, width: 200, totalHeight: 200 },
    ]);
    expect(result.frameFragmentLayouts[unit.id]).toEqual([
      { x: 0, y: 0, width: 200, height: 80 },
      { x: 0, y: 140, width: 200, height: 80 },
      { x: 0, y: 280, width: 200, height: 40 },
    ]);
  });

  it("carries reserved area height across page gaps before the following block", () => {
    const p = problem({ solution: [paragraph("answer")], areaLayout: { solution: { minHeightMm: 50 } } });
    const f = fixture([p, paragraph("after")], [measured("answer", 10, 20), measured("after", 210, 10)]);
    const unit = f.input.units.find((candidate) => candidate.type === "problemArea" && candidate.area === "solution")!;
    f.addUnit(unit.id, 10, 200);
    expect(f.compute()).toMatchObject({ gaps: { after: 80 }, pageCount: 3 });
  });

  it("lets nested columns own their blocks while continuing onto the next page", () => {
    const children = [paragraph("a"), paragraph("b"), paragraph("c")];
    const section: SigmaBlock = { type: "layoutSection", id: "section", layout: { columnCount: 2 }, children };
    const f = fixture([section], [measured("section", 10, 160), measured("a", 10, 80), measured("b", 10, 80), measured("c", 150, 80)]);
    const unit = f.input.units.find((candidate) => candidate.type === "layoutSection")!;
    const sectionElement = f.addUnit(unit.id, 10, 160);
    const editor = f.element(10, 160);
    editor.className = "text-flow-editor";
    sectionElement.append(editor);
    const input = measureSingleColumnLayoutInput(f.input);
    expect(input.naturalItems.map(({ item }) => item.kind)).toEqual(["area"]);
    const result = computeSingleColumnLayouts(input);
    expect(result.gaps).toEqual({});
    expect(result.pageCount).toBe(2);
    expect(result.areaLayouts[unit.id].blockLayouts).toMatchObject({
      a: { x: 0, y: 0 },
      b: { y: 0 },
      c: { x: 0, y: 140 },
    });
    expect(result.areaLayouts[unit.id].blockLayouts.b.x).toBeGreaterThan(0);
  });
});
