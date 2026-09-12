import { describe, expect, it } from "vitest";

import type { ProblemNode, RichBlock } from "@/features/document";
import {
  decidePagination,
  detectGapOscillation,
  gapMapSignature,
  type PaginationItem,
} from "./pagination-decisions";
import { buildRenderUnits } from "./render-units";
import type { AppliedGapIndex } from "./applied-gaps";
import {
  collectProblemAreaPaginationItems,
  shouldKeepProblemAreaAtomic,
} from "./problem-area-pagination";

function paragraph(id: string): RichBlock {
  return { type: "paragraph", id, children: [{ type: "text", text: id }] };
}

function problem(overrides: Partial<ProblemNode> = {}): ProblemNode {
  return {
    type: "problem",
    id: "problem_1",
    tags: [],
    lead: [],
    prompt: [paragraph("prompt_1")],
    hints: [],
    solution: [paragraph("solution_1"), paragraph("solution_2")],
    frame: { enabled: true },
    ...overrides,
  };
}

function collect(
  source: ProblemNode,
  heights: Partial<Record<string, number>>,
  innerSpacers: Partial<Record<string, number>> = {},
) {
  const units = buildRenderUnits([source]);
  const unitElements = new Map<string, HTMLElement>();
  const innerSpacerHeightByUnitId = new Map<string, number>();
  let top = 100;
  for (const unit of units) {
    if (unit.type !== "problemArea" && unit.type !== "problemLayoutSection") {
      continue;
    }
    const height = heights[unit.id] ?? heights[unit.area] ?? 0;
    const unitTop = top;
    unitElements.set(unit.id, {
      getBoundingClientRect: () => ({ top: unitTop, height }) as DOMRect,
    } as HTMLElement);
    const spacer = innerSpacers[unit.id] ?? innerSpacers[unit.area] ?? 0;
    if (spacer > 0) {
      innerSpacerHeightByUnitId.set(unit.id, spacer);
    }
    top += height;
  }
  const appliedGaps: AppliedGapIndex = {
    spacerHeightByBlockId: new Map(),
    unitElementByUnitId: unitElements,
    innerSpacerHeightByUnitId,
    unitMarginTopByUnitId: new Map(),
  };
  return collectProblemAreaPaginationItems(
    appliedGaps,
    { top: 100 } as DOMRect,
    units,
    1,
    1_000,
  );
}

describe("shouldKeepProblemAreaAtomic", () => {
  it("returns a framed prompt taller than one page to block flow", () => {
    expect(shouldKeepProblemAreaAtomic({
      flowEligible: false,
      gapFreeHeightPx: 1_400,
      contentHeightPx: 1_000,
      minHeightMm: 0,
      hasManualBreak: false,
    })).toBe(false);
  });

  it("keeps a framed prompt atomic while it fits one page", () => {
    expect(shouldKeepProblemAreaAtomic({
      flowEligible: false,
      gapFreeHeightPx: 1_000,
      contentHeightPx: 1_000,
      minHeightMm: 0,
      hasManualBreak: false,
    })).toBe(true);
  });

  it("keeps a min-height reservation together when the rendered area fits one page", () => {
    expect(shouldKeepProblemAreaAtomic({
      flowEligible: true,
      gapFreeHeightPx: 800,
      contentHeightPx: 1_000,
      minHeightMm: 120,
      hasManualBreak: false,
    })).toBe(true);
  });

  it("returns an over-tall solution area to block flow", () => {
    expect(shouldKeepProblemAreaAtomic({
      flowEligible: true,
      gapFreeHeightPx: 1_400,
      contentHeightPx: 1_000,
      minHeightMm: 120,
      hasManualBreak: false,
    })).toBe(false);
  });

  it("does not make an ordinary area atomic", () => {
    expect(shouldKeepProblemAreaAtomic({
      flowEligible: true,
      gapFreeHeightPx: 400,
      contentHeightPx: 1_000,
      minHeightMm: 0,
      hasManualBreak: false,
    })).toBe(false);
  });

  it("never re-atomizes an explicit manual break because of min-height", () => {
    expect(shouldKeepProblemAreaAtomic({
      flowEligible: true,
      gapFreeHeightPx: 800,
      contentHeightPx: 1_000,
      minHeightMm: 120,
      hasManualBreak: true,
    })).toBe(false);
  });
});

describe("collectProblemAreaPaginationItems", () => {
  it("leaves measured framed prompts and long solutions on the block walk", () => {
    const result = collect(problem(), { prompt: 180, solution: 1_300 });
    expect(result.atomicItems).toEqual([]);
    expect(result.splitFrameUnits).toEqual([{
      unitId: "problem_1:prompt:100",
      blockIds: ["prompt_1"],
    }]);
  });

  it("returns an over-tall framed prompt to block flow and identifies its frame unit", () => {
    const result = collect(problem(), { prompt: 1_001, solution: 100 });

    expect(result.atomicItems.flatMap((item) => item.ownedBlockIds)).not.toContain("prompt_1");
    expect(result.splitFrameUnits).toEqual([{
      unitId: "problem_1:prompt:100",
      blockIds: ["prompt_1"],
    }]);
  });

  it("keeps a one-page min-height solution on its own DOM gap carrier", () => {
    const source = problem({ areaLayout: { solution: { minHeightMm: 120 } } });
    const { atomicItems: items } = collect(source, { prompt: 180, solution: 800 });
    const solution = items.find((item) => item.ownedBlockIds.includes("solution_1"));

    expect(solution).toMatchObject({
      height: 800,
      ownedBlockIds: ["solution_1", "solution_2"],
    });
    expect(solution?.gapKey).toBe(solution?.firstUnitId);
  });

  it("classifies from gap-free height so an applied inner spacer cannot flip the mode", () => {
    const source = problem({ areaLayout: { solution: { minHeightMm: 120 } } });
    const first = collect(source, { prompt: 180, solution: 1_200 }, { solution: 300 });
    const second = collect(source, { prompt: 180, solution: 1_200 }, { solution: 300 });
    const solution = first.atomicItems.find((item) => item.ownedBlockIds.includes("solution_1"));

    expect(solution?.height).toBe(900);
    expect(first).toEqual(second);
  });

  it("does not subtract a spacer below the explicit min-height floor", () => {
    const source = problem({ areaLayout: { solution: { minHeightMm: 200 } } });
    const { atomicItems: items } = collect(source, { prompt: 180, solution: 800 }, { solution: 300 });
    const solution = items.find((item) => item.ownedBlockIds.includes("solution_1"));

    expect(solution?.height).toBeCloseTo(200 * (96 / 25.4));
    expect(solution?.reservedHeightDeficitPx).toBe(0);
  });

  it("keeps a manual break inside a framed min-height prompt on the block walk", () => {
    const source = problem({
      prompt: [
        paragraph("prompt_1"),
        { ...paragraph("prompt_2"), pagination: { break: true } },
      ],
      areaLayout: { prompt: { minHeightMm: 120 } },
    });
    const result = collect(source, { prompt: 800, solution: 100 });

    expect(result.atomicItems.flatMap((item) => item.ownedBlockIds)).not.toContain("prompt_1");
    expect(result.atomicItems.flatMap((item) => item.ownedBlockIds)).not.toContain("prompt_2");
  });

  it("represents a layout-section-only min-height solution as one atomic area", () => {
    const source = problem({
      solution: [{
        type: "layoutSection",
        id: "solution_columns",
        layout: { columnCount: 2 },
        children: [paragraph("solution_column_child")],
      }],
      areaLayout: { solution: { minHeightMm: 120 } },
    });
    const result = collect(source, { prompt: 100, solution: 100 });
    const solution = result.atomicItems.find((item) => item.ownedBlockIds.includes("solution_columns"));

    expect(solution?.gapKey).toBe("solution_columns");
    expect(solution?.height).toBeCloseTo(120 * (96 / 25.4));
    expect(solution?.reservedHeightDeficitPx).toBe(0);
  });

  it("emits an area-end boundary for an over-tall min-height solution", () => {
    const source = problem({ areaLayout: { solution: { minHeightMm: 400 } } });
    const result = collect(source, { prompt: 100, solution: 1_520 });

    expect(result.atomicItems.flatMap((item) => item.ownedBlockIds)).not.toContain("solution_1");
    expect(result.reservedAreaEnds).toEqual([{
      gapKey: "problem-area-end:problem_1:solution",
      naturalTopAdjustmentPx: 0,
      top: 1_620,
    }]);
  });

  it("keeps an absorbed spacer out of a reserved area-end natural top on pass two", () => {
    const minHeightMm = 400;
    const minHeightPx = minHeightMm * (96 / 25.4);
    const source = problem({ areaLayout: { solution: { minHeightMm } } });
    const first = collect(source, { prompt: 100, solution: minHeightPx });
    // CSS min-height absorbs this spacer: the measured area bottom remains unchanged.
    const second = collect(source, { prompt: 100, solution: minHeightPx }, { solution: 200 });
    const firstBoundary = first.reservedAreaEnds[0];
    const secondBoundary = second.reservedAreaEnds[0];
    const naturalTop = (boundary: typeof firstBoundary, appliedSpacer: number) => (
      boundary.top - appliedSpacer + boundary.naturalTopAdjustmentPx
    );
    const decision = (topNat: number): PaginationItem[] => [
      { kind: "block", gapKey: "solution_1", topNat: 0, height: 100 },
      { kind: "reservedAreaEnd", gapKey: "solution_end", topNat, height: 0 },
    ];

    expect(secondBoundary.top).toBe(firstBoundary.top);
    expect(secondBoundary.naturalTopAdjustmentPx).toBeCloseTo(200);
    expect(naturalTop(secondBoundary, 200)).toBeCloseTo(naturalTop(firstBoundary, 0));
    const firstDecision = decidePagination(decision(naturalTop(firstBoundary, 0)), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    const secondDecision = decidePagination(decision(naturalTop(secondBoundary, 200)), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    expect(secondDecision).toEqual(firstDecision);
    const repeated = decidePagination(decision(naturalTop(secondBoundary, 200)), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    expect(repeated).toEqual(secondDecision);
    const signature = gapMapSignature(secondDecision.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(repeated.gaps))).toBe("stable");
  });

  it("adds a missing multi-section reservation to the gap-free area end", () => {
    const minHeightMm = 400;
    const minHeightPx = minHeightMm * (96 / 25.4);
    const source = problem({
      solution: [
        {
          type: "layoutSection",
          id: "solution_columns_1",
          layout: { columnCount: 2 },
          children: [paragraph("solution_column_child_1")],
        },
        {
          type: "layoutSection",
          id: "solution_columns_2",
          layout: { columnCount: 2 },
          children: [paragraph("solution_column_child_2")],
        },
      ],
      areaLayout: { solution: { minHeightMm } },
    });
    const first = collect(source, {
      prompt: 100,
      solution_columns_1: 400,
      solution_columns_2: 400,
    });
    // The first section grows by the rendered spacer; subtracting it must recover the same
    // natural boundary and the logical reservation must remain present on both passes.
    const second = collect(source, {
      prompt: 100,
      solution_columns_1: 600,
      solution_columns_2: 400,
    }, { solution_columns_1: 200 });
    const firstBoundary = first.reservedAreaEnds[0];
    const secondBoundary = second.reservedAreaEnds[0];
    const firstNaturalTop = firstBoundary.top + firstBoundary.naturalTopAdjustmentPx;
    const secondNaturalTop = secondBoundary.top - 200 + secondBoundary.naturalTopAdjustmentPx;

    expect(first.atomicItems.flatMap((item) => item.ownedBlockIds)).not.toContain("solution_columns_1");
    expect(firstBoundary.naturalTopAdjustmentPx).toBeCloseTo(minHeightPx - 800);
    expect(secondBoundary.naturalTopAdjustmentPx).toBeCloseTo(firstBoundary.naturalTopAdjustmentPx);
    expect(secondNaturalTop).toBeCloseTo(firstNaturalTop);
    const items = (topNat: number): PaginationItem[] => [
      { kind: "block", gapKey: "solution_columns_1", topNat: 100, height: 400 },
      { kind: "block", gapKey: "solution_columns_2", topNat: 500, height: 400 },
      { kind: "reservedAreaEnd", gapKey: "solution_end", topNat, height: 0 },
    ];
    const firstDecision = decidePagination(items(firstNaturalTop), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    const secondDecision = decidePagination(items(secondNaturalTop), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    expect(secondDecision).toEqual(firstDecision);
    const repeated = decidePagination(items(secondNaturalTop), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    expect(repeated).toEqual(secondDecision);
    expect(secondDecision.pageCount).toBe(2);
    const signature = gapMapSignature(secondDecision.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(repeated.gaps))).toBe("stable");
  });

  it("keeps text-layout-text area collection stable across two passes", () => {
    const source = problem({
      lead: [
        paragraph("lead_before"),
        {
          type: "layoutSection",
          id: "lead_columns",
          layout: { columnCount: 2 },
          children: [paragraph("lead_column_child")],
        },
        paragraph("lead_after"),
      ],
      areaLayout: { lead: { minHeightMm: 100 } },
    });
    const first = collect(source, { lead: 100, prompt: 100, solution: 100 });
    const second = collect(source, { lead: 100, prompt: 100, solution: 100 });
    const lead = first.atomicItems.find((item) => item.ownedBlockIds.includes("lead_before"));

    expect(lead?.gapKey).toBe("problem_1");
    expect(first).toEqual(second);
  });

  it("honors a break on the second child of a nested layout section", () => {
    const source = problem({
      prompt: [{
        type: "layoutSection",
        id: "prompt_columns",
        layout: { columnCount: 2 },
        children: [
          paragraph("prompt_column_1"),
          { ...paragraph("prompt_column_2"), pagination: { break: true } },
        ],
      }],
      areaLayout: { prompt: { minHeightMm: 120 } },
    });
    const result = collect(source, { prompt: 800, solution: 100 });
    const ownedIds = result.atomicItems.flatMap((item) => item.ownedBlockIds);

    expect(ownedIds).not.toContain("prompt_columns");
    expect(ownedIds).not.toContain("prompt_column_1");
    expect(ownedIds).not.toContain("prompt_column_2");
  });

  it("does not feed an absorbed prior-pass spacer into the next gap decision", () => {
    const minHeightMm = 200;
    const minHeightPx = minHeightMm * (96 / 25.4);
    const source = problem({ areaLayout: { solution: { minHeightMm } } });
    // Both passes have the same realistic DOM height and following top: CSS min-height absorbs
    // the prior 200px spacer, so the outer area does not grow on the second measurement.
    const withoutSpacer = collect(source, { prompt: 100, solution: minHeightPx });
    const withAbsorbedSpacer = collect(
      source,
      { prompt: 100, solution: minHeightPx },
      { solution: 200 },
    );
    const decisionItems = (result: ReturnType<typeof collect>): PaginationItem[] => {
      const solution = result.atomicItems.find((item) => item.ownedBlockIds.includes("solution_1"));
      if (!solution) {
        throw new Error("atomic solution item was not collected");
      }
      return [
        {
          kind: "atomicProblemArea",
          gapKey: solution.gapKey,
          topNat: 600,
          height: solution.height,
          reservedHeightDeficitPx: solution.reservedHeightDeficitPx,
        },
        { kind: "block", gapKey: "after", topNat: 600 + minHeightPx, height: 100 },
      ];
    };

    const withoutDecision = decidePagination(decisionItems(withoutSpacer), {
      contentHeightPx: 1_000,
      pageStride: 1_100,
    }, {});
    const absorbedItems = decisionItems(withAbsorbedSpacer);
    const absorbedFirst = decidePagination(absorbedItems, { contentHeightPx: 1_000, pageStride: 1_100 }, {});
    const absorbedSecond = decidePagination(absorbedItems, { contentHeightPx: 1_000, pageStride: 1_100 }, {});

    expect(
      withAbsorbedSpacer.atomicItems.find((item) => item.ownedBlockIds.includes("solution_1"))
        ?.reservedHeightDeficitPx,
    ).toBe(0);
    expect(absorbedFirst).toEqual(withoutDecision);
    expect(absorbedSecond).toEqual(absorbedFirst);
    const signature = gapMapSignature(absorbedFirst.gaps);
    expect(detectGapOscillation([signature, signature], gapMapSignature(absorbedSecond.gaps))).toBe("stable");
  });
});
