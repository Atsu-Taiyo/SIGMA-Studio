import { getProblemFrameChromePaddingPx } from "@/lib/problem-frame";
import { describe, expect, it } from "vitest";

import { deriveAiEditPreviewOverlayShapes, hasOverlayAiEditChanges, type AiEditPreviewState } from "@/components/editor/ai-edit-preview-types";
import type { BlockExtent } from "@/components/editor/overlay-canvas/anchor";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import { canInsertManualColumnBreak } from "@/components/editor/page-canvas/block-ops";
import  {
  computeColumnUnitLayouts,
  createSingleColumnBoxFragments,
  getBoxFragmentBreakOffsetsFromMeasuredBox,
  getColumnBreakBeforeBlockIdForContextMenu,
  isFlowBlockFragmentable,
} from "@/components/editor/page-canvas/column-layout";
import { measureBoxLayoutSectionSideNotes } from "@/components/editor/page-canvas/layout-measure";
import { getSelectionActionPopoverPosition, viewportToCanvasAnchor } from "@/components/editor/page-canvas/popover-anchors";
import { collectProblemAreaColumnInputs } from "@/components/editor/page-canvas/problem-area-flow";
import  {
  buildProblemAreaOwnerByBlockId,
  buildRenderUnits,
  getLayoutSectionColumnGapPx,
  getPageColumnSideNoteOffsetPx,
} from "@/components/editor/page-canvas/render-units";
import type { ProblemAreaColumnLayout, RenderUnit } from "@/components/editor/page-canvas/types";
import { calculateVisiblePageRange, getVisiblePageIndexes } from "@/components/editor/page-canvas/virtualization";
import { getBlockPaginationGapCarrier } from "@/components/editor/page-canvas/single-column-layout";
import { groupAiEditPreviewEntries } from "@/features/ai-edit";
import { computeProblemAreaColumnFlow, simulateBalancedColumnHeightPx } from "@/features/rendering/core";
import { BUILTIN_BOX_STYLES, createBoxBlock } from "@/lib/box-blocks";
import { collectBlocksById } from "@/lib/document-tree";
import  {
  getPageMetrics,
  mmToPx,
  normalizePageLayout,
  PAGE_GAP_PX,
  type PageMetrics,
} from "@/lib/page-layout";
import type { ProblemNode, RichBlock, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

describe("local layout section columns", () => {
  it("resolves an empty problem-area editor placeholder to its owning unit", () => {
    const problem = createProblem({ id: "empty_lead_problem" });
    const leadUnit = problemAreaUnit(problem, "lead", "empty_lead_unit");

    expect(buildProblemAreaOwnerByBlockId([leadUnit]).get("empty_lead_problem_lead_empty")).toBe(leadUnit);
  });

  it("carries a first lead block break on the problem-area unit", () => {
    const lead = paragraph("lead_first", "Lead");
    const problem = createProblem({ id: "lead_carrier_problem", lead: [lead] });
    const leadUnit = problemAreaUnit(problem, "lead", "lead_carrier_unit");
    const owners = buildProblemAreaOwnerByBlockId([leadUnit]);

    expect(getBlockPaginationGapCarrier(lead.id, owners)).toEqual({
      gapKey: problem.id,
      appliedGapItem: { kind: "unit", unitId: leadUnit.id },
    });
  });

  it("carries an empty first lead break on the problem-area unit", () => {
    const problem = createProblem({ id: "empty_lead_carrier_problem" });
    const leadUnit = problemAreaUnit(problem, "lead", "empty_lead_carrier_unit");
    const owners = buildProblemAreaOwnerByBlockId([leadUnit]);

    expect(getBlockPaginationGapCarrier("empty_lead_carrier_problem_lead_empty", owners)).toEqual({
      gapKey: problem.id,
      appliedGapItem: { kind: "unit", unitId: leadUnit.id },
    });
  });

  it("keeps later problem-area blocks on their block spacer", () => {
    const first = paragraph("lead_first", "First");
    const second = paragraph("lead_second", "Second");
    const problem = createProblem({ id: "later_block_carrier_problem", lead: [first, second] });
    const leadUnit = problemAreaUnit(problem, "lead", "later_block_carrier_unit");
    const owners = buildProblemAreaOwnerByBlockId([leadUnit]);

    expect(getBlockPaginationGapCarrier(second.id, owners)).toEqual({
      gapKey: second.id,
      appliedGapItem: { kind: "block", id: second.id },
    });
  });

  it("uses the section column gap instead of the document-wide fallback", () => {
    expect(getLayoutSectionColumnGapPx({
      type: "layoutSection",
      id: "local_columns",
      layout: { columnCount: 2, columnGapMm: 7 },
      children: [],
    }, 8, mmToPx(8))).toBeCloseTo(mmToPx(7));
  });

  it("places side notes immediately before the outer page column containing the section", () => {
    const metrics = getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 3, columnGapMm: 8 },
    }));
    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    const nestedInset = 14;
    const firstColumnAnchor = metrics.margins.leftPx + nestedInset;
    const secondColumnLeft = metrics.margins.leftPx + columnStep;
    const thirdColumnLeft = metrics.margins.leftPx + columnStep * 2;

    expect(getPageColumnSideNoteOffsetPx(
      firstColumnAnchor,
      firstColumnAnchor,
      metrics,
    )).toBeCloseTo(firstColumnAnchor);
    expect(getPageColumnSideNoteOffsetPx(
      secondColumnLeft + nestedInset,
      secondColumnLeft + nestedInset,
      metrics,
    )).toBeCloseTo(nestedInset + metrics.flow.columnGapPx / 2);
    expect(getPageColumnSideNoteOffsetPx(
      thirdColumnLeft + nestedInset,
      thirdColumnLeft + nestedInset,
      metrics,
    )).toBeCloseTo(nestedInset + metrics.flow.columnGapPx / 2);
  });

  it("limits box-local manual column breaks to columnCount minus one", () => {
    const section = (columnCount: number, breakIndexes: number[]) => ({
      type: "layoutSection" as const,
      id: `local_columns_${columnCount}`,
      layout: { columnCount, columnGapMm: 8 },
      children: Array.from({ length: 4 }, (_, index) => ({
        ...paragraph(`local_${columnCount}_${index}`, String(index)),
        ...(breakIndexes.includes(index) ? { pagination: { break: true as const } } : {}),
      })),
    });

    expect(canInsertManualColumnBreak(section(2, []))).toBe(true);
    expect(canInsertManualColumnBreak(section(2, [1]))).toBe(false);
    expect(canInsertManualColumnBreak(section(3, [1]))).toBe(true);
    expect(canInsertManualColumnBreak(section(3, [1, 2]))).toBe(false);
  });

  it("does not count a break on the first layout-section child toward the limit", () => {
    const section = {
      type: "layoutSection" as const,
      id: "local_columns_first_break",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [
        { ...paragraph("first", "first"), pagination: { break: true as const } },
        paragraph("second", "second"),
      ],
    };

    expect(canInsertManualColumnBreak(section)).toBe(true);
  });

  it("measures only the first box-local layout section in canvas coordinates", () => {
    const box = {
      getAttribute: () => null,
      parentElement: null,
    };
    const sectionElement = (
      id: string,
      bounds: ReturnType<typeof rect>,
      insideBox: boolean,
    ) => ({
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? id : null,
      closest: (selector: string) => selector === ".sigma-doc-box-block" && insideBox ? box : null,
      getBoundingClientRect: () => bounds,
    });
    const flow = {
      getBoundingClientRect: () => rect({ left: 100, top: 200, width: 600, height: 800 }),
      querySelectorAll: () => [
        sectionElement("box_columns", rect({ left: 180, top: 260, width: 320, height: 120 }), true),
        sectionElement("body_columns", rect({ left: 180, top: 420, width: 320, height: 90 }), false),
        sectionElement("box_columns", rect({ left: 180, top: 620, width: 320, height: 70 }), true),
      ],
    } as unknown as HTMLElement;

    expect(measureBoxLayoutSectionSideNotes(flow, 2)).toEqual({
      box_columns: { x: 40, y: 30, width: 160, height: 60 },
    });
  });

  it("clamps box-local section side notes to a split box's visible source fragment", () => {
    const splitBox = {
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? "split_box" : null,
      getBoundingClientRect: () => rect({ left: 140, top: 200, width: 400, height: 300 }),
    };
    const wholeBox = {
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? "whole_box" : null,
      getBoundingClientRect: () => rect({ left: 140, top: 400, width: 400, height: 200 }),
    };
    const sectionElement = (
      id: string,
      bounds: ReturnType<typeof rect>,
      ancestor: {
        getAttribute: (name: string) => string | null;
        getBoundingClientRect: () => DOMRect;
      },
    ) => ({
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? id : null,
      closest: (selector: string) => selector === ".sigma-doc-box-block" ? ancestor : null,
      getBoundingClientRect: () => bounds,
    });
    const flow = {
      getBoundingClientRect: () => rect({ left: 100, top: 100, width: 600, height: 800 }),
      querySelectorAll: () => [
        sectionElement("split_columns", rect({ left: 180, top: 260, width: 320, height: 120 }), splitBox),
        sectionElement("hidden_columns", rect({ left: 180, top: 320, width: 320, height: 40 }), splitBox),
        sectionElement("whole_columns", rect({ left: 180, top: 440, width: 320, height: 80 }), wholeBox),
      ],
    } as unknown as HTMLElement;

    expect(measureBoxLayoutSectionSideNotes(flow, 2, {
      split_box: { visibleHeight: 50, totalHeight: 150 },
    })).toEqual({
      split_columns: { x: 40, y: 80, width: 160, height: 20 },
      whole_columns: { x: 40, y: 170, width: 160, height: 40 },
    });
  });

  it("clamps a nested box's section side note to every split box ancestor", () => {
    const outerBox = {
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? "split_outer_box" : null,
      getBoundingClientRect: () => rect({ left: 140, top: 200, width: 400, height: 300 }),
      parentElement: null,
    } as unknown as HTMLElement;
    const innerBox = {
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? "whole_inner_box" : null,
      getBoundingClientRect: () => rect({ left: 160, top: 240, width: 360, height: 180 }),
      parentElement: {
        closest: (selector: string) => selector === ".sigma-doc-box-block" ? outerBox : null,
      },
    } as unknown as HTMLElement;
    const sectionElement = {
      getAttribute: (name: string) => name === "data-sigma-doc-id" ? "inner_columns" : null,
      closest: (selector: string) => selector === ".sigma-doc-box-block" ? innerBox : null,
      getBoundingClientRect: () => rect({ left: 180, top: 260, width: 320, height: 120 }),
    };
    const flow = {
      getBoundingClientRect: () => rect({ left: 100, top: 100, width: 600, height: 800 }),
      querySelectorAll: () => [sectionElement],
    } as unknown as HTMLElement;

    expect(measureBoxLayoutSectionSideNotes(flow, 2, {
      split_outer_box: { visibleHeight: 50, totalHeight: 150 },
    })).toEqual({
      inner_columns: { x: 40, y: 80, width: 160, height: 20 },
    });
  });
});

describe("viewportToCanvasAnchor", () => {
  it("converts viewport coordinates into page-canvas local coordinates", () => {
    const canvas = {
      getBoundingClientRect: () => rect({ left: 80, top: 120, width: 700, height: 900 }),
      closest: () => null,
    } as unknown as HTMLElement;

    expect(viewportToCanvasAnchor({ left: 180, top: 220 }, canvas)).toEqual({
      left: 100,
      top: 100,
    });
  });

  it("keeps the same canvas-local anchor when the page scrolls", () => {
    const canvasBeforeScroll = {
      getBoundingClientRect: () => rect({ left: 80, top: 120, width: 700, height: 900 }),
      closest: () => null,
    } as unknown as HTMLElement;
    const canvasAfterScroll = {
      getBoundingClientRect: () => rect({ left: 80, top: 70, width: 700, height: 900 }),
      closest: () => null,
    } as unknown as HTMLElement;

    expect(viewportToCanvasAnchor({ left: 180, top: 220 }, canvasBeforeScroll)).toEqual({
      left: 100,
      top: 100,
    });
    expect(viewportToCanvasAnchor({ left: 180, top: 170 }, canvasAfterScroll)).toEqual({
      left: 100,
      top: 100,
    });
  });
});

describe("getSelectionActionPopoverPosition", () => {
  it("keeps the default text-selection popover close to the selection", () => {
    expect(getSelectionActionPopoverPosition(
      rect({ left: 120, top: 200, width: 80, height: 24 }),
      { viewport: { width: 800, height: 600 } },
    )).toEqual({
      left: 104,
      top: 154,
    });
  });

  it("moves overlay selection actions above the rotate handle clearance", () => {
    expect(getSelectionActionPopoverPosition(
      rect({ left: 120, top: 200, width: 80, height: 24 }),
      { verticalClearance: 42, viewport: { width: 800, height: 600 } },
    )).toEqual({
      left: 104,
      top: 120,
    });
  });

  it("places overlay selection actions below when there is not room above the handle", () => {
    expect(getSelectionActionPopoverPosition(
      rect({ left: 120, top: 40, width: 80, height: 24 }),
      { verticalClearance: 42, viewport: { width: 800, height: 600 } },
    )).toEqual({
      left: 104,
      top: 72,
    });
  });
});

describe("groupAiEditPreviewEntries", () => {
  it("keeps overlay-shape insertions out of body flow and available to the overlay approval path", () => {
    const preview: AiEditPreviewState = {
      targetId: "p_target",
      createdAt: Date.now(),
      proposalIds: ["mcp_proposal_1"],
      baseRevision: 1,
      providers: [],
      draft: {
        summary: "図形を挿入",
        plan: ["図形を挿入する"],
        warnings: [],
        operations: [
          {
            operation: "insertOverlayShape",
            summary: "長方形を挿入",
            targetId: "p_target",
            overlayShape: rectangleShape("shape_1"),
            assets: {},
          },
        ],
      },
    };

    const grouped = groupAiEditPreviewEntries([preview]);

    expect(grouped.size).toBe(0);
    expect(hasOverlayAiEditChanges(preview)).toBe(true);
    expect(deriveAiEditPreviewOverlayShapes(preview, [])).toEqual([rectangleShape("shape_1")]);
  });
});

describe("computeColumnUnitLayouts", () => {
  it("consumes a short section's manual break exactly once", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const before = paragraph("short_before", "before");
    const children = [paragraph("short_left", "left"), paragraph("short_right", "right")];
    const section = {
      type: "layoutSection" as const, id: "short_section", pagination: { break: true },
      layout: { columnCount: 2 }, children,
    };
    const result = computeColumnUnitLayouts(fakeFlow({
      [before.id]: 20, [section.id]: { blocks: { short_left: 20, short_right: 20 } },
    }), [textUnit(before, before.id), {
      type: "layoutSection", id: section.id, section, blocks: children,
    }], metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    expect(result.layouts[section.id].x).toBe(Math.round(metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx));
    expect(result.layouts[section.id].y).toBe(Math.round(metrics.margins.topPx));
    expect(result.pageCount).toBe(1);
  });

  it("preserves independent nested column ownership and unequal widths after a section break", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const before = paragraph("ownership_before", "before");
    const left = paragraph("ownership_left", "left");
    const right = paragraph("ownership_right", "right");
    const section = {
      type: "layoutSection" as const, id: "ownership_section",
      pagination: { break: true },
      layout: { columnCount: 2, columnGapMm: 4, columnStartIds: [left.id, right.id], columnWidths: [3000, 7000] },
      children: [left, right],
    };
    const units: RenderUnit[] = [textUnit(before, before.id), {
      type: "layoutSection", id: section.id, section, blocks: section.children,
    }];
    const result = computeColumnUnitLayouts(fakeFlow({
      [before.id]: 20, [section.id]: { blocks: { [left.id]: 220, [right.id]: 20 } },
    }), units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const nested = result.nestedColumnLayouts[section.id];
    expect(result.layouts[section.id].x).toBe(Math.round(metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx));
    expect(result.layouts[section.id].width).toBe(Math.round(metrics.flow.columnWidthPx));
    expect(result.markerLayouts[section.id]).toBeDefined();
    expect(nested.blockLayouts[right.id].x).toBe(0);
    expect(nested.blockLayouts[right.id].y).toBe(0);
    expect(nested.blockLayouts[right.id].width / nested.blockLayouts[left.id].width).toBeCloseTo(7 / 3, 1);
    expect(result.boxBlockFragmentLayouts[left.id]).toHaveLength(2);
  });

  it("keeps a problem lead with its framed prompt in the same page column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const problem = createProblem({
      lead: [paragraph("problem_lead", "1")],
      prompt: [paragraph("problem_prompt", "prompt")],
      frame: { enabled: true, styleId: "fancybox" },
    });
    const leadUnit = problemAreaUnit(problem, "lead", "problem_1:lead");
    const promptUnit = problemAreaUnit(problem, "prompt", "problem_1:prompt");
    const units: RenderUnit[] = [
      textUnit(paragraph("lead_keep_filler", "filler"), "lead_keep_filler"),
      leadUnit,
      promptUnit,
    ];
    const flow = fakeFlow({
      lead_keep_filler: 80,
      "problem_1:lead": { blocks: { problem_lead: 20 } },
      "problem_1:prompt": { blocks: { problem_prompt: 30 } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.layouts[leadUnit.id].x).toBe(first.layouts[promptUnit.id].x);
    expect(first.layouts[leadUnit.id].y).toBe(first.layouts[promptUnit.id].y - 20 - getProblemFrameChromePaddingPx("fancybox").y);
    expect(first.layouts[leadUnit.id].x).toBeGreaterThan(metrics.margins.leftPx);
    expect(second.layouts).toEqual(first.layouts);
  });

  it("keeps a problem lead on the page where its full-span prompt starts", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const problem = createProblem({
      lead: [paragraph("full_lead", "1")],
      prompt: [paragraph("full_prompt", "prompt")],
      areaLayout: { prompt: { columnSpan: "full" } },
    });
    const leadUnit = problemAreaUnit(problem, "lead", "full_problem:lead");
    const promptUnit = problemAreaUnit(problem, "prompt", "full_problem:prompt");
    const units: RenderUnit[] = [
      textUnit(paragraph("full_lead_filler", "filler"), "full_lead_filler"),
      leadUnit,
      promptUnit,
    ];
    const flow = fakeFlow({
      full_lead_filler: 80,
      "full_problem:lead": { blocks: { full_lead: 20 } },
      "full_problem:prompt": { blocks: { full_prompt: 30 } },
    });

    const result = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const leadPage = Math.floor(result.layouts[leadUnit.id].y / (metrics.page.heightPx + PAGE_GAP_PX));
    const promptPage = Math.floor(result.layouts[promptUnit.id].y / (metrics.page.heightPx + PAGE_GAP_PX));

    expect(leadPage).toBe(promptPage);
    expect(promptPage).toBe(1);
    expect(result.layouts[promptUnit.id].y).toBe(result.layouts[leadUnit.id].y + 20);
  });

  it("places full-span prompt areas across the page and starts solution columns below them", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 250);
    const problem = createProblem({
      prompt: [paragraph("prompt_block", "問題文")],
      solution: [paragraph("solution_block", "解答")],
      areaLayout: {
        prompt: { columnSpan: "full" },
      },
    });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "prompt", "problem_1:prompt"),
      problemAreaUnit(problem, "solution", "problem_1:solution"),
      {
        type: "textFlow",
        id: "after_solution",
        blocks: [paragraph("after_solution_block", "続き")],
      },
    ];
    const flow = fakeFlow({
      "problem_1:prompt": 50,
      "problem_1:solution": 180,
      after_solution: 80,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["problem_1:prompt"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.content.widthPx,
    }));
    expect(result.layouts["problem_1:solution"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx + 50,
      width: metrics.flow.columnWidthPx,
      height: 180,
    }));
    expect(result.layouts.after_solution).toEqual(roundedLayout({
      x: metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx,
      y: metrics.margins.topPx + 50,
      width: metrics.flow.columnWidthPx,
      height: 80,
    }));
  });

  it("moves the first column unit after a full-span area to the next page when it cannot fit below it", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 250);
    const problem = createProblem({
      prompt: [paragraph("prompt_block", "問題文")],
      solution: [paragraph("solution_block", "解答")],
      areaLayout: {
        prompt: { columnSpan: "full" },
      },
    });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "prompt", "problem_1:prompt"),
      problemAreaUnit(problem, "solution", "problem_1:solution"),
    ];
    const flow = fakeFlow({
      "problem_1:prompt": 220,
      "problem_1:solution": 80,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["problem_1:prompt"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.content.widthPx,
    }));
    expect(result.layouts["problem_1:solution"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.page.heightPx + PAGE_GAP_PX + metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
      height: 80,
    }));
    expect(result.pageCount).toBe(2);
  });

  it("uses every remaining column below a full-span band before continuing on the next page", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const problem = createProblem({
      prompt: [paragraph("full_span_before_nested", "full")],
      areaLayout: { prompt: { columnSpan: "full" } },
    });
    const children = Array.from({ length: 5 }, (_, index) => paragraph(`after_full_inner_${index}`, String(index)));
    const section = {
      type: "layoutSection" as const,
      id: "after_full_nested",
      layout: { columnCount: 2, columnGapMm: 4, columnStartIds: [children[0].id, children[3].id] },
      children,
    };
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "prompt", "problem_1:prompt"),
      { type: "layoutSection", id: section.id, section, blocks: children },
    ];
    const flow = fakeFlow({
      "problem_1:prompt": 40,
      [section.id]: { blocks: Object.fromEntries(children.map((child) => [child.id, 60])) },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.layouts[section.id].y).toBe(Math.round(metrics.margins.topPx + 40));
    expect(first.nestedColumnLayouts[section.id].blockLayouts.after_full_inner_1.x).toBeGreaterThan(0);
    expect(first.nestedColumnLayouts[section.id].blockLayouts.after_full_inner_2.y).toBe(
      Math.round(metrics.page.heightPx + PAGE_GAP_PX - 40),
    );
    expect(first.pageCount).toBe(2);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.nestedColumnLayouts).toEqual(first.nestedColumnLayouts);
  });

  it("advances manual break to the next column, then to the next physical page", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 250);
    const units: RenderUnit[] = [
      textUnit(paragraph("p_first", "1"), "p_first:0"),
      textUnit({ ...paragraph("p_second", "2"), pagination: { break: true } }, "p_second:1"),
      textUnit({ ...paragraph("p_third", "3"), pagination: { break: true } }, "p_third:2"),
    ];
    const flow = fakeFlow({
      "p_first:0": 40,
      "p_second:1": 40,
      "p_third:2": 40,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["p_first:0"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
      height: 40,
    }));
    expect(result.layouts["p_second:1"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx,
      y: metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
      height: 40,
    }));
    expect(result.layouts["p_third:2"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.page.heightPx + PAGE_GAP_PX + metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
      height: 40,
    }));
    expect(result.pageCount).toBe(2);
  });

  it("keeps a block with its next block when the pair fits the next column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const blocks = [
      paragraph("filler", "filler"),
      { ...paragraph("heading", "heading"), pagination: { keepWithNext: true } },
      paragraph("body", "body"),
    ];
    const units: RenderUnit[] = [textRunUnit(blocks, "flow")];
    const flow = fakeFlow({
      flow: { blocks: { filler: 50, heading: 30, body: 30 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(result.blockLayouts.heading.x).toBe(Math.round(columnStep));
    expect(result.blockLayouts.body.x).toBe(Math.round(columnStep));
    expect(result.blockLayouts.heading.y).toBe(0);
    expect(result.blockLayouts.body.y).toBe(30);
  });

  it("keeps a fitting box together by moving it to the next column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const filler = paragraph("filler", "filler");
    const box = {
      type: "boxBlock" as const,
      id: "kept_box",
      styleId: "fancybox",
      blocks: [paragraph("box_body", "box")],
      pagination: { keepTogether: true },
    };
    const units: RenderUnit[] = [{ type: "textFlow", id: "flow", blocks: [filler, box] }];
    const flow = fakeFlow({
      flow: { blocks: { filler: 60, kept_box: 60 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(result.blockLayouts.kept_box.x).toBe(Math.round(columnStep));
    expect(result.blockLayouts.kept_box.y).toBe(0);
    expect(result.boxBlockFragmentLayouts.kept_box).toBeUndefined();
  });

  it("flows an oversized layout section through its inner columns and into the next page column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const children = Array.from({ length: 5 }, (_, index) => paragraph(`inner_${index}`, String(index)));
    const section = {
      type: "layoutSection" as const,
      id: "nested_columns",
      layout: { columnCount: 2, columnGapMm: 4, columnStartIds: [children[0].id, children[3].id] },
      children,
    };
    const units: RenderUnit[] = [{
      type: "layoutSection",
      id: section.id,
      section,
      blocks: children,
    }];
    const flow = fakeFlow({
      nested_columns: { blocks: Object.fromEntries(children.map((block) => [block.id, 60])) },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const nested = result.nestedColumnLayouts.nested_columns;
    const outerColumnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(nested).toBeDefined();
    expect(nested.blockLayouts.inner_0.x).toBe(0);
    expect(nested.blockLayouts.inner_1.x).toBeGreaterThan(0);
    expect(nested.blockLayouts.inner_1.x).toBeCloseTo(Math.round(outerColumnStep), 0);
    expect(nested.blockLayouts.inner_2.y).toBeGreaterThanOrEqual(metrics.page.heightPx + PAGE_GAP_PX - 1);
    expect(result.pageCount).toBe(2);
  });

  it("fragments a tall paragraph while its independent neighbor stays at the section start", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const tall = paragraph("nested_tall", "tall");
    const innerTail = paragraph("nested_tail", "tail");
    const section = {
      type: "layoutSection" as const,
      id: "nested_tall_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [tall, innerTail],
    };
    const after = paragraph("after_nested_tall", "after");
    const units: RenderUnit[] = [
      { type: "layoutSection", id: section.id, section, blocks: section.children },
      textUnit(after, after.id),
    ];
    const flow = fakeFlow({
      [section.id]: { blocks: { [tall.id]: 220, [innerTail.id]: 20 } },
      [after.id]: 10,
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const fragments = first.boxBlockFragmentLayouts[tall.id];

    expect(first.boxFragmentSourceLayouts[tall.id]).toEqual({ visibleHeight: 100, totalHeight: 220, origin: { x: 64, y: 68, width: 151 } });
    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toEqual(expect.objectContaining({
      blockId: tall.id,
      fragmentIndex: 1,
      sourceOffsetY: 100,
      height: 100,
    }));
    expect(fragments[1]).toEqual(expect.objectContaining({
      blockId: tall.id,
      fragmentIndex: 2,
      sourceOffsetY: 200,
      height: 20,
    }));
    expect(first.nestedColumnLayouts[section.id].blockLayouts[innerTail.id].y).toBe(0);
    expect(first.layouts[after.id].y).toBe(fragments[1].y + fragments[1].height);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.nestedColumnLayouts).toEqual(first.nestedColumnLayouts);
    expect(second.boxFragmentSourceLayouts).toEqual(first.boxFragmentSourceLayouts);
    expect(second.boxBlockFragmentLayouts).toEqual(first.boxBlockFragmentLayouts);
  });

  it("bounds all nested-column replicas across one layout operation", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const firstTall = paragraph("nested_budget_a", "a");
    const secondTall = paragraph("nested_budget_b", "b");
    const section = {
      type: "layoutSection" as const,
      id: "nested_budget_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [firstTall, secondTall],
    };
    const units: RenderUnit[] = [{ type: "layoutSection", id: section.id, section, blocks: section.children }];
    const flow = fakeFlow({
      [section.id]: { blocks: { [firstTall.id]: 1_000_000, [secondTall.id]: 1_000_000 } },
    });

    const result = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const fragmentCount = Object.values(result.boxBlockFragmentLayouts)
      .reduce((count, fragments) => count + fragments.length + 1, 0);

    expect(fragmentCount).toBeLessThanOrEqual(1_000);
    expect(Number.isFinite(result.layouts[section.id].height)).toBe(true);
    expect(result.nestedColumnLayouts[section.id].blockLayouts[secondTall.id]).toBeDefined();
  });

  it("uses the remaining nested-column space for a box before continuing in the next inner column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const filler = paragraph("nested_box_filler", "filler");
    const box = {
      type: "boxBlock" as const,
      id: "nested_flow_box",
      styleId: "fancybox",
      blocks: [paragraph("nested_flow_box_body", "box")],
    };
    const tail = paragraph("nested_box_tail", "tail");
    const section = {
      type: "layoutSection" as const,
      id: "nested_flow_box_section",
      layout: { columnCount: 2, columnGapMm: 4 },
      children: [filler, box, tail],
    };
    const units: RenderUnit[] = [{ type: "layoutSection", id: section.id, section, blocks: section.children }];
    const flow = fakeFlow({
      [section.id]: { blocks: { [filler.id]: 40, [box.id]: 80, [tail.id]: 100 } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const continuation = first.boxBlockFragmentLayouts[box.id];

    expect(first.boxFragmentSourceLayouts[box.id]).toEqual({ visibleHeight: 60, totalHeight: 80, origin: { x: 64, y: 108, width: 151 } });
    expect(continuation).toHaveLength(1);
    expect(continuation[0]).toEqual(expect.objectContaining({
      blockId: box.id,
      fragmentIndex: 1,
      sourceOffsetY: 60,
      height: 20,
    }));
    expect(continuation[0].x).toBeGreaterThan(first.layouts[section.id].x);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.nestedColumnLayouts).toEqual(first.nestedColumnLayouts);
    expect(second.boxFragmentSourceLayouts).toEqual(first.boxFragmentSourceLayouts);
    expect(second.boxBlockFragmentLayouts).toEqual(first.boxBlockFragmentLayouts);
  });

  it("does not reinterpret legacy inner breaks as page breaks in independent columns", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const children = [
      paragraph("inner_before", "before"),
      { ...paragraph("inner_after", "after"), pagination: { break: true as const } },
      paragraph("inner_neighbor", "neighbor"),
    ];
    const section = {
      type: "layoutSection" as const,
      id: "manual_nested_columns",
      layout: { columnCount: 2, columnGapMm: 4 },
      children,
    };
    const units: RenderUnit[] = [{
      type: "layoutSection",
      id: section.id,
      section,
      blocks: children,
    }];
    const flow = fakeFlow({
      manual_nested_columns: { blocks: { inner_before: 20, inner_after: 20, inner_neighbor: 20 } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    expect(first.nestedColumnLayouts.manual_nested_columns).toBeUndefined();
    expect(first.pageCount).toBe(1);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.nestedColumnLayouts).toEqual(first.nestedColumnLayouts);
    expect(second.pageCount).toBe(first.pageCount);
  });

  it("honors child keep hints inside a flowed layout section", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const children = [
      paragraph("inner_filler", "filler"),
      { ...paragraph("inner_heading", "heading"), pagination: { keepWithNext: true } },
      paragraph("inner_body", "body"),
      {
        type: "boxBlock" as const,
        id: "inner_box",
        styleId: "fancybox",
        blocks: [paragraph("inner_box_body", "box")],
        pagination: { keepTogether: true },
      },
      paragraph("inner_tail", "tail"),
    ];
    const section = {
      type: "layoutSection" as const,
      id: "nested_keep_hints",
      layout: { columnCount: 2, columnGapMm: 4 },
      children,
    };
    const units: RenderUnit[] = [{ type: "layoutSection", id: section.id, section, blocks: children }];
    const flow = fakeFlow({
      nested_keep_hints: { blocks: {
        inner_filler: 60,
        inner_heading: 25,
        inner_body: 25,
        inner_box: 60,
        inner_tail: 100,
      } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const nested = first.nestedColumnLayouts.nested_keep_hints;

    expect(nested.blockLayouts.inner_heading.x).toBeGreaterThan(nested.blockLayouts.inner_filler.x);
    expect(nested.blockLayouts.inner_body.x).toBe(nested.blockLayouts.inner_heading.x);
    expect(nested.blockLayouts.inner_box.y).toBeGreaterThan(nested.blockLayouts.inner_heading.y);
    expect(second.nestedColumnLayouts).toEqual(first.nestedColumnLayouts);
  });

  it.each([80, 100])("advances before nested flow when the starting column already consumed %ipx", (fillerHeight) => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const children = [
      paragraph("boundary_inner_1", "1"),
      paragraph("boundary_inner_2", "2"),
      paragraph("boundary_inner_3", "3"),
    ];
    const section = {
      type: "layoutSection" as const,
      id: `nested_boundary_${fillerHeight}`,
      layout: { columnCount: 2, columnGapMm: 4 },
      children,
    };
    const after = paragraph("after_nested_boundary", "after");
    const units: RenderUnit[] = [
      textUnit(paragraph("boundary_filler", "filler"), "boundary_filler"),
      { type: "layoutSection", id: section.id, section, blocks: children },
      textUnit(after, after.id),
    ];
    const flow = fakeFlow({
      boundary_filler: fillerHeight,
      [section.id]: { blocks: Object.fromEntries(children.map((child) => [child.id, 60])) },
      [after.id]: 10,
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const outerColumnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;

    expect(first.layouts[section.id].x).toBeCloseTo(metrics.margins.leftPx + outerColumnStep, 0);
    expect(first.nestedColumnLayouts[section.id].blockLayouts.boundary_inner_1.x).toBe(0);
    expect(first.layouts[after.id].y).toBeGreaterThanOrEqual(metrics.page.heightPx + PAGE_GAP_PX);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.pageCount).toBe(first.pageCount);
  });

  it("uses nested flow occupancy, not vertically summed children, for the remaining reservation", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const children = Array.from({ length: 4 }, (_, index) => paragraph(`reserved_inner_${index}`, String(index)));
    const section = {
      type: "layoutSection" as const,
      id: "reserved_nested",
      layout: { columnCount: 2, columnGapMm: 4, columnStartIds: [children[0].id, children[2].id] },
      children,
    };
    const problem = createProblem({
      solution: [section],
      areaLayout: { solution: { minHeightMm: 250 / mmToPx(1) } },
    });
    const unit = buildRenderUnits([problem]).find((candidate) => candidate.type === "problemLayoutSection");
    if (!unit) throw new Error("problem layout section expected");
    const after = paragraph("after_reserved_nested", "after");
    const units: RenderUnit[] = [unit, textUnit(after, after.id)];
    const flow = fakeFlow({
      [section.id]: { blocks: Object.fromEntries(children.map((child) => [child.id, 60])) },
      [after.id]: 10,
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.layouts[after.id].y).toBeCloseTo(metrics.page.heightPx + PAGE_GAP_PX + metrics.margins.topPx + 50, 0);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.nestedColumnLayouts).toEqual(first.nestedColumnLayouts);
  });

  it("consumes a balanced layout-section reservation and ignores a non-finite reservation", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const run = (minHeightMm: number) => {
      const children = [paragraph("balanced_1", "1"), paragraph("balanced_2", "2")];
      const section = {
        type: "layoutSection" as const,
        id: "balanced_reserved",
        layout: { columnCount: 2, columnGapMm: 4 },
        children,
      };
      const problem = createProblem({ solution: [section], areaLayout: { solution: { minHeightMm } } });
      const unit = buildRenderUnits([problem]).find((candidate) => candidate.type === "problemLayoutSection");
      if (!unit) throw new Error("problem layout section expected");
      const after = paragraph("after_balanced", "after");
      const units: RenderUnit[] = [unit, textUnit(after, after.id)];
      const flow = fakeFlow({ [section.id]: { blocks: { balanced_1: 20, balanced_2: 20 } }, [after.id]: 10 });
      return computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    };

    const reserved = run(80 / mmToPx(1));
    expect(reserved.nestedColumnLayouts.balanced_reserved).toBeUndefined();
    expect(reserved.layouts.after_balanced.y).toBeCloseTo(metrics.margins.topPx + 80, 0);

    const nonFinite = run(Number.POSITIVE_INFINITY);
    expect(nonFinite.layouts.after_balanced.y).toBeCloseTo(metrics.margins.topPx + 40, 0);
    expect(run(Number.POSITIVE_INFINITY).layouts).toEqual(nonFinite.layouts);
  });

  it("preserves problem-level break when prompt blocks use column flow", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 250);
    const problem = createProblem({
      pagination: { break: true },
      prompt: [paragraph("prompt_block", "問題文")],
    });
    const units: RenderUnit[] = [
      textUnit(paragraph("before_problem", "前の本文"), "before_problem"),
      problemAreaUnit(problem, "prompt", "problem_1:prompt"),
    ];
    const flow = fakeFlow({
      before_problem: 40,
      "problem_1:prompt": {
        blocks: { prompt_block: 50 },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const nextColumnX = metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(result.layouts["problem_1:prompt"]).toEqual(roundedLayout({
      x: nextColumnX,
      y: metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
      height: 50,
    }));
    expect(result.blockLayouts.prompt_block).toEqual(roundedTextBlockLayout({
      x: 0,
      y: 0,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.markerLayouts.problem_1).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx + 40,
      width: metrics.flow.columnWidthPx,
    }));
  });

  it("keeps adjacent text blocks in one flow unit while positioning them by column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 70);
    const first = paragraph("p_first", "1");
    const second = paragraph("p_second", "2");
    const units: RenderUnit[] = [
      textRunUnit([first, second], "p_first"),
    ];
    const flow = fakeFlow({
      p_first: {
        blocks: {
          p_first: 40,
          p_second: 50,
        },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(result.layouts.p_first).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.flow.columnWidthPx + columnStep,
      height: 50,
    }));
    expect(result.blockLayouts.p_first).toEqual(roundedTextBlockLayout({
      x: 0,
      y: 0,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.blockLayouts.p_second).toEqual(roundedTextBlockLayout({
      x: columnStep,
      y: 0,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.pageCount).toBe(1);
  });

  it("finds a manual break target from another block in the same page column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 120);
    const blocks = [
      paragraph("p_first", "1"),
      { ...paragraph("p_break", "2"), pagination: { break: true as const } },
      paragraph("p_after_break", "3"),
    ];
    const units: RenderUnit[] = [
      textRunUnit(blocks, "p_first"),
    ];
    const flow = fakeFlow({
      p_first: {
        blocks: {
          p_first: 40,
          p_break: 40,
          p_after_break: 40,
        },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(getColumnBreakBeforeBlockIdForContextMenu({
      blockId: "p_first",
      blocks,
      units,
      isColumnFlow: true,
      metrics,
      pageStridePx: metrics.page.heightPx + PAGE_GAP_PX,
      paginationMarkerLayouts: result.markerLayouts,
      textFlowBlockLayouts: result.blockLayouts,
      unitLayouts: result.layouts,
      problemAreaColumnLayouts: {},
    })).toBe("p_break");
  });

  it.each([1, 2])("resolves a nested box boundary from its body in %i columns", (columnCount) => {
    const metrics = getPageMetrics(normalizePageLayout({ flow: { type: "columns", columnCount, columnGapMm: 8 } }));
    const blocks: Extract<SigmaBlock, { type: "boxBlock" }>[] = [{
      ...createBoxBlock("fancybox"), id: "outer", blocks: [paragraph("before", "before"), {
        ...createBoxBlock("fancybox"), id: "inner", pagination: { break: true }, blocks: [paragraph("inside", "inside")],
      }],
    }];
    expect(getColumnBreakBeforeBlockIdForContextMenu({
      blockId: "inside", blocks, units: [{ type: "textFlow", id: "outer", blocks }],
      isColumnFlow: columnCount > 1, metrics, pageStridePx: metrics.page.heightPx + PAGE_GAP_PX,
      paginationMarkerLayouts: {}, textFlowBlockLayouts: {}, unitLayouts: {}, problemAreaColumnLayouts: {},
    })).toBe("inner");
  });

  it("does not resolve a preceding outside break from inside a box", () => {
    const blocks: SigmaBlock[] = [
      { ...paragraph("outside_break", "before"), pagination: { break: true } },
      { ...createBoxBlock("fancybox"), id: "box", blocks: [paragraph("inside", "inside")] },
    ];

    expect(resolveContextMenuBreakTarget(blocks, "inside")).toBeNull();
  });

  it("does not carry an outside break through a container into a nested box", () => {
    const blocks: SigmaBlock[] = [
      { ...paragraph("outside_break", "before"), pagination: { break: true } },
      { type: "layoutSection", id: "section", layout: { columnCount: 1 }, children: [{
        ...createBoxBlock("fancybox"), id: "box", blocks: [paragraph("inside", "inside")],
      }] },
    ];

    expect(resolveContextMenuBreakTarget(blocks, "inside")).toBeNull();
  });

  it("keeps a preceding paragraph break available within the same box", () => {
    const blocks: SigmaBlock[] = [{
      ...createBoxBlock("fancybox"), id: "box", blocks: [
        { ...paragraph("box_break", "first"), pagination: { break: true } },
        paragraph("box_tail", "second"),
      ],
    }];

    expect(resolveContextMenuBreakTarget(blocks, "box_tail")).toBe("box_break");
  });

  it("keeps nested box breaks within their own sibling subtree", () => {
    const blocks: SigmaBlock[] = [{
      ...createBoxBlock("fancybox"), id: "outer", blocks: [
        { ...createBoxBlock("fancybox"), id: "first", pagination: { break: true }, blocks: [paragraph("first_body", "first")] },
        { ...createBoxBlock("fancybox"), id: "second", blocks: [paragraph("second_body", "second")] },
      ],
    }];

    expect(resolveContextMenuBreakTarget(blocks, "first_body")).toBe("first");
    expect(resolveContextMenuBreakTarget(blocks, "second_body")).toBeNull();
  });

  it("retains an enclosing box break across an unbroken nested box", () => {
    const blocks: SigmaBlock[] = [{
      ...createBoxBlock("fancybox"), id: "outer", pagination: { break: true }, blocks: [{
        ...createBoxBlock("fancybox"), id: "inner", blocks: [paragraph("inner_body", "inside")],
      }],
    }];

    expect(resolveContextMenuBreakTarget(blocks, "inner_body")).toBe("outer");
  });

  it("resolves the break target from the units being drawn, not from a rebuilt guess", () => {
    // 描画側のチャンク境界は前回の描画から引き継ぐ (`text-run-chunking.ts`)。ここで blocks から
    // 組み直すと id が実描画とずれ、`unitLayouts` が引けずに「改段/改ページを解除」がメニューから
    // 黙って消える (落ちないので気づけない)。組み直すと null になる配置で固定する。
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 1000);
    const body = Array.from({ length: 60 }, (_, index) => paragraph(`b${index}`, `${index}`));
    const blocks = [
      ...body,
      { ...paragraph("brk", "break"), pagination: { break: true as const } },
      paragraph("tail", "tail"),
    ];
    // 実描画では 60 件が 1 ユニットのまま (前回の境界を引き継いだ結果)。組み直すと b40 で切れる。
    const units: RenderUnit[] = [
      textRunUnit(blocks.slice(0, 60), "b0"),
      textRunUnit(blocks.slice(60), "brk"),
    ];
    const flow = fakeFlow({
      b0: { blocks: Object.fromEntries(body.map((block) => [block.id, 10])) },
      brk: { blocks: { brk: 10, tail: 10 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );
    const lookup = {
      blockId: "b45",
      blocks,
      isColumnFlow: true,
      metrics,
      pageStridePx: metrics.page.heightPx + PAGE_GAP_PX,
      paginationMarkerLayouts: result.markerLayouts,
      textFlowBlockLayouts: result.blockLayouts,
      unitLayouts: result.layouts,
      problemAreaColumnLayouts: {},
    };

    expect(buildRenderUnits(blocks).map((unit) => unit.id)).toEqual(["b0", "b40", "brk"]);
    expect(getColumnBreakBeforeBlockIdForContextMenu({ ...lookup, units })).toBe("brk");
    expect(getColumnBreakBeforeBlockIdForContextMenu({
      ...lookup,
      units: buildRenderUnits(blocks),
    })).toBeNull();
  });

  it("finds the plain page break that ends the clicked single-column page", () => {
    const metrics = getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    }));
    const pageStridePx = metrics.page.heightPx + PAGE_GAP_PX;
    const blocks = [
      paragraph("page_first", "first"),
      paragraph("page_clicked", "clicked"),
      { ...paragraph("next_page", "next"), pagination: { break: true as const } },
    ];
    const blockRects = new Map([
      ["page_first", measuredBlock("page_first", metrics.margins.topPx)],
      ["page_clicked", measuredBlock("page_clicked", metrics.margins.topPx + 40)],
      ["next_page", measuredBlock("next_page", pageStridePx + metrics.margins.topPx)],
    ]);

    expect(getColumnBreakBeforeBlockIdForContextMenu({
      blockId: "page_first",
      blocks,
      units: buildRenderUnits(blocks),
      isColumnFlow: false,
      metrics,
      pageStridePx,
      blockRects,
      paginationMarkerLayouts: {},
      textFlowBlockLayouts: {},
      unitLayouts: {},
      problemAreaColumnLayouts: {},
    })).toBe("next_page");
    expect(getColumnBreakBeforeBlockIdForContextMenu({
      blockId: "page_clicked",
      blocks,
      units: buildRenderUnits(blocks),
      isColumnFlow: false,
      metrics,
      pageStridePx,
      blockRects,
      paginationMarkerLayouts: {},
      textFlowBlockLayouts: {},
      unitLayouts: {},
      problemAreaColumnLayouts: {},
    })).toBe("next_page");
  });

  it("finds a manual break target from another flowed problem-area block in the same page column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 120);
    const problem = createProblem({
      solution: [
        paragraph("solution_first", "first"),
        paragraph("solution_clicked", "clicked"),
        { ...paragraph("solution_break", "break"), pagination: { break: true as const } },
        paragraph("solution_after_break", "after"),
      ],
    });
    const units = buildRenderUnits([problem]);
    const solutionUnit = units.find((unit) => unit.type === "problemArea" && unit.area === "solution");
    expect(solutionUnit).toBeDefined();
    if (!solutionUnit || solutionUnit.type !== "problemArea") {
      throw new Error("solution problem-area render unit was not created");
    }
    const flow = fakeFlow({
      [solutionUnit.id]: {
        blocks: {
          solution_first: 30,
          solution_clicked: 30,
          solution_break: 30,
          solution_after_break: 30,
        },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      [solutionUnit],
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(getColumnBreakBeforeBlockIdForContextMenu({
      blockId: "solution_clicked",
      blocks: [problem],
      units: [solutionUnit],
      isColumnFlow: true,
      metrics,
      pageStridePx: metrics.page.heightPx + PAGE_GAP_PX,
      paginationMarkerLayouts: result.markerLayouts,
      textFlowBlockLayouts: result.blockLayouts,
      unitLayouts: result.layouts,
      problemAreaColumnLayouts: {},
    })).toBe("solution_break");
  });

  it("does not add a blank page only because one column unit overflows", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 120);
    const units: RenderUnit[] = [
      textUnit(paragraph("p_large", "large"), "p_large:0"),
    ];
    const flow = fakeFlow({
      "p_large:0": 180,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["p_large:0"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
      height: 180,
    }));
    expect(result.pageCount).toBe(1);
  });

  it("splits an over-tall column unit across columns instead of letting it overflow", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 120);
    const units: RenderUnit[] = [
      textUnit(paragraph("p_large", "large"), "p_large:0"),
      textUnit(paragraph("p_after", "after"), "p_after:1"),
    ];
    const flow = fakeFlow({
      "p_large:0": 180,
      "p_after:1": 30,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    // The 180px block is taller than the 120px column, so it is split into clipped
    // fragments: the first fragment fills the left column and the remainder flows
    // into the right column — nothing overflows.
    const source = result.boxFragmentSourceLayouts["p_large"];
    expect(source).toBeDefined();
    expect(source.totalHeight).toBe(180);
    expect(source.visibleHeight).toBeLessThanOrEqual(metrics.content.heightPx + 0.5);
    const tailFragments = result.boxBlockFragmentLayouts["p_large"] ?? [];
    expect(tailFragments.length).toBeGreaterThanOrEqual(1);
    for (const fragment of [{ height: source.visibleHeight }, ...tailFragments]) {
      expect(fragment.height).toBeLessThanOrEqual(metrics.content.heightPx + 0.5);
    }
    // The remainder lands in the right column, and the following block continues
    // right after it on the same page (no blank-page padding).
    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(tailFragments[0].x).toBe(Math.round(metrics.margins.leftPx + columnStep));
    expect(result.layouts["p_after:1"].x).toBe(Math.round(metrics.margins.leftPx + columnStep));
    expect(result.pageCount).toBe(1);
  });

  it("bounds extreme page-column fragmentation and aggregates the remainder", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const tall = paragraph("bounded_column_block", "tall");
    const result = computeColumnUnitLayouts(
      fakeFlow({ [tall.id]: 1_000_000 }),
      [textUnit(tall, tall.id)],
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );
    const continuations = result.boxBlockFragmentLayouts[tall.id];

    expect(continuations).toHaveLength(999);
    expect(result.boxFragmentSourceLayouts[tall.id].visibleHeight
      + continuations.reduce((sum, fragment) => sum + fragment.height, 0)).toBe(1_000_000);
    expect(continuations.at(-1)?.height).toBeGreaterThan(100);
  });

  it("splits an over-tall problem-area block into continuation fragments", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 120);
    const problem = createProblem({
      solution: [paragraph("solution_large", "large solution")],
    });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "solution", "problem_1:solution"),
    ];
    const flow = fakeFlow({
      "problem_1:solution": {
        blocks: { solution_large: 180 },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.boxFragmentSourceLayouts.solution_large).toEqual({
      visibleHeight: 120,
      totalHeight: 180,
      origin: { x: metrics.margins.leftPx, y: metrics.margins.topPx, width: metrics.flow.columnWidthPx },
    });
    expect(result.boxBlockFragmentLayouts.solution_large).toEqual([
      expect.objectContaining({
        blockId: "solution_large",
        fragmentIndex: 1,
        height: 60,
        sourceOffsetY: 120,
        totalHeight: 180,
      }),
    ]);
  });

  it("flows problem-area blocks from one page column into the next", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const problem = createProblem({
      solution: [
        paragraph("solution_first", "first"),
        paragraph("solution_second", "second"),
      ],
    });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "solution", "problem_1:solution"),
    ];
    const flow = fakeFlow({
      "problem_1:solution": {
        blocks: {
          solution_first: 60,
          solution_second: 60,
        },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    expect(result.blockLayouts.solution_first).toEqual(roundedTextBlockLayout({
      x: 0,
      y: 0,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.blockLayouts.solution_second).toEqual(roundedTextBlockLayout({
      x: columnStep,
      y: 0,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.pageCount).toBe(1);
  });

  it("excludes the following block's trailing space from column keep-with-next fitting", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const heading = { ...paragraph("column_keep_heading", "heading"), pagination: { keepWithNext: true } };
    const body = { ...paragraph("column_keep_body", "body"), spaceAfterPx: 20 };
    const units: RenderUnit[] = [
      textUnit(paragraph("column_keep_filler", "filler"), "column_keep_filler"),
      textRunUnit([heading, body], heading.id),
    ];
    const flow = fakeFlow({
      column_keep_filler: 70,
      [heading.id]: { blocks: { [heading.id]: 20, [body.id]: 30 } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.blockLayouts[heading.id].x).toBe(0);
    expect(first.blockLayouts[heading.id].y).toBe(0);
    expect(first.blockLayouts[body.id].y).toBe(20);
    expect(second.blockLayouts).toEqual(first.blockLayouts);
  });

  it("counts every split problem-frame chrome piece against the area reservation", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const prompt = [
      paragraph("framed_reserved_first", "first"),
      { ...paragraph("framed_reserved_second", "second"), pagination: { break: true as const } },
    ];
    const problem = createProblem({
      prompt,
      frame: { enabled: true },
      areaLayout: { prompt: { minHeightMm: 100 / mmToPx(1) } },
    });
    const after = paragraph("after_framed_reservation", "after");
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "prompt", "problem_1:prompt"),
      textUnit(after, after.id),
    ];
    const flow = fakeFlow({
      "problem_1:prompt": { blocks: { framed_reserved_first: 20, framed_reserved_second: 20 } },
      [after.id]: 10,
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.frameFragmentLayouts["problem_1:prompt"]).toHaveLength(2);
    expect(first.layouts[after.id].x).toBeCloseTo(
      metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx,
      0,
    );
    expect(first.layouts[after.id].y).toBeCloseTo(metrics.margins.topPx + 56, 0);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.frameFragmentLayouts).toEqual(first.frameFragmentLayouts);
  });

  it("continues problem-area blocks onto the next page after the last column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const problem = createProblem({
      solution: [
        paragraph("solution_first", "first"),
        paragraph("solution_second", "second"),
        paragraph("solution_third", "third"),
      ],
    });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "solution", "problem_1:solution"),
    ];
    const flow = fakeFlow({
      "problem_1:solution": {
        blocks: {
          solution_first: 60,
          solution_second: 60,
          solution_third: 60,
        },
      },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.blockLayouts.solution_third).toEqual(roundedTextBlockLayout({
      x: 0,
      y: metrics.page.heightPx + PAGE_GAP_PX,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.pageCount).toBe(2);
  });

  it("keeps full-span areas atomic and gives framed prompts a block flow", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 240);
    const fullSpanProblem = createProblem({
      id: "problem_full",
      solution: [paragraph("full_solution", "full")],
      areaLayout: { solution: { columnSpan: "full" } },
    });
    const framedProblem = createProblem({
      id: "problem_framed",
      prompt: [paragraph("framed_prompt", "framed")],
      frame: { enabled: true },
    });
    const units: RenderUnit[] = [
      problemAreaUnit(fullSpanProblem, "solution", "problem_full:solution"),
      problemAreaUnit(framedProblem, "prompt", "problem_framed:prompt"),
    ];
    const flow = fakeFlow({
      "problem_full:solution": { blocks: { full_solution: 70 } },
      "problem_framed:prompt": { blocks: { framed_prompt: 80 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["problem_full:solution"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.content.widthPx,
    }));
    expect(result.layouts["problem_framed:prompt"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx + 70 + getProblemFrameChromePaddingPx(undefined).y,
      width: metrics.flow.columnWidthPx,
      height: 80,
    }));
    expect(result.blockLayouts.full_solution).toBeUndefined();
    expect(result.blockLayouts.framed_prompt).toEqual(roundedTextBlockLayout({ x: 0, y: 0, width: metrics.flow.columnWidthPx }));
  });

  it("splits a framed prompt area across a column when a manual break is placed inside it", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 240);
    const framedProblem = createProblem({
      id: "problem_framed",
      prompt: [
        paragraph("framed_prompt_1", "before"),
        { ...paragraph("framed_prompt_2", "after"), pagination: { break: true } },
      ],
      frame: { enabled: true },
    });
    const units: RenderUnit[] = [
      problemAreaUnit(framedProblem, "prompt", "problem_framed:prompt"),
    ];
    const flow = fakeFlow({
      "problem_framed:prompt": { blocks: { framed_prompt_1: 70, framed_prompt_2: 60 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    // The manual break makes the framed area flow (block-by-block) instead of
    // staying atomic: per-block layouts exist, and the break moved the second
    // block into the next column.
    expect(result.blockLayouts.framed_prompt_1).toEqual(roundedTextBlockLayout({
      x: 0,
      y: 8,
      width: metrics.flow.columnWidthPx,
    }));
    expect(result.markerLayouts.framed_prompt_2).toBeDefined();
    expect(result.blockLayouts.framed_prompt_2).toEqual(roundedTextBlockLayout({
      x: columnStep,
      y: 0,
      width: metrics.flow.columnWidthPx,
    }));
  });

  it("reserves the top chrome of a manually split frame after preceding content", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const before = paragraph("manual_frame_before", "before");
    const framedProblem = createProblem({
      id: "manual_frame_problem",
      prompt: [
        paragraph("manual_frame_first", "first"),
        { ...paragraph("manual_frame_second", "second"), pagination: { break: true } },
      ],
      frame: { enabled: true },
    });
    const units: RenderUnit[] = [
      textUnit(before, before.id),
      problemAreaUnit(framedProblem, "prompt", "manual_frame_problem:prompt"),
    ];
    const flow = fakeFlow({
      [before.id]: 40,
      "manual_frame_problem:prompt": { blocks: { manual_frame_first: 30, manual_frame_second: 30 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );
    const areaLayout = result.layouts["manual_frame_problem:prompt"];
    const firstPiece = result.frameFragmentLayouts["manual_frame_problem:prompt"][0];
    const firstPieceTop = areaLayout.y + firstPiece.y - 8;
    const beforeBottom = result.layouts[before.id].y + 40;

    expect(firstPieceTop).toBeGreaterThanOrEqual(beforeBottom);
    expect(firstPieceTop).toBeGreaterThanOrEqual(metrics.margins.topPx);
  });

  it("automatically flows a framed prompt taller than one column and keeps the following block after its frame", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const framedProblem = createProblem({
      id: "problem_framed_tall",
      prompt: [
        paragraph("framed_tall_1", "first"),
        paragraph("framed_tall_2", "second"),
      ],
      frame: { enabled: true },
    });
    const after = paragraph("after_framed_tall", "after");
    const units: RenderUnit[] = [
      problemAreaUnit(framedProblem, "prompt", "problem_framed_tall:prompt"),
      textUnit(after, after.id),
    ];
    const flow = fakeFlow({
      "problem_framed_tall:prompt": { blocks: { framed_tall_1: 70, framed_tall_2: 70 } },
      [after.id]: 20,
    });

    const run = () => computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );
    const first = run();
    const second = run();

    expect(first.frameFragmentLayouts["problem_framed_tall:prompt"]).toHaveLength(2);
    expect(first.blockLayouts.framed_tall_1.x).toBe(0);
    expect(first.blockLayouts.framed_tall_2.x).toBeGreaterThan(0);
    expect(first.layouts[after.id].x).toBe(first.layouts["problem_framed_tall:prompt"].x + first.blockLayouts.framed_tall_2.x);
    expect(first.layouts[after.id].y).toBeGreaterThan(
      first.layouts["problem_framed_tall:prompt"].y + first.blockLayouts.framed_tall_2.y + 70,
    );
    const framePieceBottoms = first.frameFragmentLayouts["problem_framed_tall:prompt"].map((fragment) => (
      first.layouts["problem_framed_tall:prompt"].y + fragment.y + fragment.height + 8
    ));
    for (const bottom of framePieceBottoms) {
      const pageIndex = Math.floor(Math.max(0, bottom - 1) / (metrics.page.heightPx + PAGE_GAP_PX));
      const contentBottom = pageIndex * (metrics.page.heightPx + PAGE_GAP_PX)
        + metrics.margins.topPx + metrics.content.heightPx;
      expect(bottom).toBeLessThanOrEqual(contentBottom);
    }
    expect(first.layouts[after.id].y).toBeGreaterThanOrEqual(framePieceBottoms.at(-1) ?? 0);
    expect(second).toEqual(first);
  });

  it("splits a full-span problem area across a page when a manual break is placed inside it", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 240);
    const fullSpanProblem = createProblem({
      id: "problem_full",
      solution: [
        paragraph("full_solution_1", "before"),
        { ...paragraph("full_solution_2", "after"), pagination: { break: true } },
      ],
      areaLayout: { solution: { columnSpan: "full" } },
    });
    const units: RenderUnit[] = [
      problemAreaUnit(fullSpanProblem, "solution", "problem_full:solution"),
    ];
    const flow = fakeFlow({
      "problem_full:solution": { blocks: { full_solution_1: 70, full_solution_2: 60 } },
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    // The manual break makes the full-span area flow instead of staying atomic:
    // per-block layouts exist, at full content width (not page-column width, since
    // a full-span area has no "next column" — only a next page), and the second
    // block landed on the next page.
    expect(result.blockLayouts.full_solution_1).toEqual(roundedTextBlockLayout({
      x: 0,
      y: 0,
      width: metrics.content.widthPx,
    }));
    expect(result.markerLayouts.full_solution_2).toBeDefined();
    expect(result.blockLayouts.full_solution_2).toEqual(roundedTextBlockLayout({
      x: 0,
      y: metrics.page.heightPx + PAGE_GAP_PX,
      width: metrics.content.widthPx,
    }));
    expect(result.pageCount).toBe(2);
  });

  it("automatically flows a full-span area taller than one page", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const problem = createProblem({
      id: "problem_full_tall",
      solution: [
        paragraph("full_tall_1", "first"),
        paragraph("full_tall_2", "second"),
      ],
      areaLayout: { solution: { columnSpan: "full" } },
    });
    const units: RenderUnit[] = [problemAreaUnit(problem, "solution", "problem_full_tall:solution")];
    const flow = fakeFlow({
      "problem_full_tall:solution": { blocks: { full_tall_1: 70, full_tall_2: 70 } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.blockLayouts.full_tall_1).toEqual(roundedTextBlockLayout({
      x: 0,
      y: 0,
      width: metrics.content.widthPx,
    }));
    expect(first.blockLayouts.full_tall_2.y).toBeCloseTo(metrics.page.heightPx + PAGE_GAP_PX, 0);
    expect(first.pageCount).toBe(2);
    expect(second).toEqual(first);
  });

  it("reserves a problem area's minimum height when it stays in one column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 240);
    const minHeightMm = 20;
    const problem = createProblem({
      solution: [paragraph("solution_short", "short")],
      areaLayout: { solution: { minHeightMm } },
    });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "solution", "problem_1:solution"),
      textUnit(paragraph("after_solution", "after"), "after_solution"),
    ];
    const flow = fakeFlow({
      "problem_1:solution": { blocks: { solution_short: 30 } },
      after_solution: 20,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["problem_1:solution"].height).toBe(Math.round(mmToPx(minHeightMm)));
    expect(result.layouts.after_solution).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx + mmToPx(minHeightMm),
      width: metrics.flow.columnWidthPx,
      height: 20,
    }));
  });

  it("continues a problem-area minimum-height reservation in the next page column", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const minHeightMm = 20;
    const problem = createProblem({
      solution: [paragraph("solution_short", "short")],
      areaLayout: { solution: { minHeightMm } },
    });
    const units: RenderUnit[] = [
      textUnit(paragraph("before_solution", "before"), "before_solution"),
      problemAreaUnit(problem, "solution", "problem_1:solution"),
      textUnit(paragraph("after_solution", "after"), "after_solution"),
    ];
    const flow = fakeFlow({
      before_solution: 80,
      "problem_1:solution": { blocks: { solution_short: 10 } },
      after_solution: 20,
    });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts.after_solution).toEqual(roundedLayout({
      x: metrics.margins.leftPx + metrics.flow.columnWidthPx + metrics.flow.columnGapPx,
      y: metrics.margins.topPx + mmToPx(minHeightMm) - 20,
      width: metrics.flow.columnWidthPx,
      height: 20,
    }));
    expect(result.pageCount).toBe(1);
  });

  it("keeps the remaining reservation after a flowed problem area and counts its trailing page", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 100);
    const minHeightMm = 250 / mmToPx(1);
    const problem = createProblem({
      solution: [
        paragraph("solution_first", "first"),
        paragraph("solution_second", "second"),
      ],
      areaLayout: { solution: { minHeightMm } },
    });
    const units: RenderUnit[] = [problemAreaUnit(problem, "solution", "problem_1:solution")];
    const flow = fakeFlow({
      "problem_1:solution": { blocks: { solution_first: 80, solution_second: 80 } },
    });

    const first = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);
    const second = computeColumnUnitLayouts(flow, units, metrics, metrics.page.heightPx, PAGE_GAP_PX, 1);

    expect(first.blockLayouts.solution_second.x).toBeGreaterThan(first.blockLayouts.solution_first.x);
    expect(first.pageCount).toBe(2);
    expect(second.layouts).toEqual(first.layouts);
    expect(second.blockLayouts).toEqual(first.blockLayouts);
    expect(second.pageCount).toBe(first.pageCount);
  });

  it("falls back to the measured problem-area element when the editable area has no blocks", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    })), 240);
    const problem = createProblem({ solution: [] });
    const units: RenderUnit[] = [
      problemAreaUnit(problem, "solution", "problem_1:solution"),
    ];
    const flow = fakeFlow({ "problem_1:solution": 34 });

    const result = computeColumnUnitLayouts(
      flow,
      units,
      metrics,
      metrics.page.heightPx,
      PAGE_GAP_PX,
      1,
    );

    expect(result.layouts["problem_1:solution"]).toEqual(roundedLayout({
      x: metrics.margins.leftPx,
      y: metrics.margins.topPx,
      width: metrics.flow.columnWidthPx,
    }));
  });
});

describe("visible page window", () => {
  it("returns the visible pages with overscan and clamps to the document", () => {
    const range = calculateVisiblePageRange({
      canvasRect: { top: -760 } as DOMRect,
      overscan: 2,
      pageCount: 10,
      pageGapPx: 40,
      pageHeightPx: 1000,
      viewportRect: { top: 0, bottom: 900 } as DOMRect,
      zoomScale: 1,
    });

    expect(range).toEqual({ start: 0, end: 3, overscan: 2 });
  });

  it("keeps pinned editing pages in the rendered page index list", () => {
    expect(getVisiblePageIndexes({ start: 2, end: 4, overscan: 2 }, 8, [1, 8])).toEqual([0, 2, 3, 4, 7]);
  });
});

describe("buildRenderUnits", () => {
  it("splits long top-level text runs into bounded textFlow units", () => {
    const units = buildRenderUnits(Array.from({ length: 95 }, (_, index) =>
      paragraph(`p_${index}`, `本文 ${index}`),
    ));

    expect(units).toHaveLength(3);
    expect(units.map((unit) => unit.id)).toEqual(["p_0", "p_40", "p_80"]);
    expect(units.map((unit) => unit.type === "textFlow" ? unit.blocks.length : 0)).toEqual([40, 40, 15]);
  });

  it("keeps manual page-break boundaries as separate textFlow units", () => {
    const units = buildRenderUnits([
      paragraph("p_0", "本文 0"),
      paragraph("p_1", "本文 1"),
      { ...paragraph("p_2", "改ページ後"), pagination: { break: true } },
      paragraph("p_3", "本文 3"),
    ]);

    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.id)).toEqual(["p_0", "p_2"]);
    expect(units.map((unit) => unit.type === "textFlow" ? unit.blocks.map((block) => block.id) : [])).toEqual([
      ["p_0", "p_1"],
      ["p_2", "p_3"],
    ]);
  });
});

function createProblem(overrides: Partial<ProblemNode>): ProblemNode {
  return {
    type: "problem",
    id: "problem_1",
    tags: [],
    lead: [],
    prompt: [],
    solution: [],
    hints: [],
    ...overrides,
  };
}

function paragraph(id: string, text: string): RichBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
  };
}

function measuredBlock(id: string, top: number) {
  return {
    id,
    top,
    left: 0,
    width: 100,
    height: 24,
    lines: [],
  };
}

function resolveContextMenuBreakTarget(
  blocks: SigmaBlock[],
  blockId: string,
  problemAreaColumnLayouts: Record<string, ProblemAreaColumnLayout> = {},
): string | null {
  return getColumnBreakBeforeBlockIdForContextMenu({
    blockId,
    blocks,
    units: buildRenderUnits(blocks),
    isColumnFlow: false,
    metrics: getPageMetrics(normalizePageLayout({
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    })),
    pageStridePx: 1123,
    paginationMarkerLayouts: {},
    textFlowBlockLayouts: {},
    unitLayouts: {},
    problemAreaColumnLayouts,
  });
}

function problemAreaUnit(problem: ProblemNode, area: "lead" | "prompt" | "solution", id: string): RenderUnit {
  return {
    type: "problemArea",
    id,
    problem,
    area,
    blocks: problem[area],
    problemNumber: 1,
    isFirstProblemArea: area === "lead" || (problem.lead.length === 0 && area === "prompt"),
    isLastProblemArea: area === "solution",
    isFirstProblemAreaUnit: true,
    problemAreaUnitCount: 1,
    isFirstProblemFrameArea: area === "prompt",
    isLastProblemFrameArea: area === "prompt",
  };
}

function textUnit(block: RichBlock, id: string): RenderUnit {
  return {
    type: "textFlow",
    id,
    blocks: [block],
  };
}

function textRunUnit(blocks: RichBlock[], id: string): RenderUnit {
  return {
    type: "textFlow",
    id,
    blocks,
  };
}

function rect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function rectangleShape(id: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: 80,
      h: 40,
      geo: "rectangle",
      fill: "solid",
      color: "#111111",
      fillColor: "#ffffff",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  };
}

function withContentHeight(metrics: PageMetrics, heightPx: number): PageMetrics {
  return {
    ...metrics,
    content: {
      ...metrics.content,
      heightPx,
    },
  };
}

function fakeFlow(heights: Record<string, number | { blocks: Record<string, number> }>): HTMLElement {
  const elements = Object.entries(heights).map(([id, config]) => {
    const blockHeights = typeof config === "number" ? null : config.blocks;
    const height = typeof config === "number"
      ? config
      : Object.values(config.blocks).reduce((sum, value) => sum + value, 0);
    return {
      getAttribute: (name: string) => name === "data-flow-unit-id" ? id : null,
      getBoundingClientRect: () => ({ height }) as DOMRect,
      querySelectorAll: () => blockHeights
          ? Object.entries(blockHeights).map(([blockId, blockHeight]) => ({
            getAttribute: (name: string) => name === "data-sigma-doc-id" ? blockId : null,
            getBoundingClientRect: () => ({ height: blockHeight, top: 0, bottom: blockHeight }) as DOMRect,
            querySelectorAll: () => [{
              getBoundingClientRect: () => ({ bottom: blockHeight }) as DOMRect,
            }],
          }))
        : [],
    };
  });

  return {
    querySelectorAll: () => elements,
  } as unknown as HTMLElement;
}

function roundedLayout(layout: { x: number; y: number; width: number; height?: number }): { x: number; y: number; width: number; height?: number } {
  return {
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
    ...(typeof layout.height === "number" ? { height: Math.round(layout.height) } : {}),
  };
}

function roundedTextBlockLayout(layout: { x: number; y: number; width: number }): { x: number; y: number; width: number } {
  return {
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
  };
}

describe("collectProblemAreaColumnInputs", () => {
  function unitElement(width: number, top: number): HTMLElement {
    const editor = {
      getBoundingClientRect: () => ({ width, top: top + 8, left: 12 }) as DOMRect,
      querySelectorAll: () => [],
    };
    return {
      getBoundingClientRect: () => ({ width, top, left: 12 }) as DOMRect,
      querySelector: (selector: string) => selector === ".text-flow-editor" ? editor : null,
    } as unknown as HTMLElement;
  }

  const twoColumnSection: RenderUnit = {
    type: "layoutSection",
    id: "section_unit:0",
    section: {
      type: "layoutSection",
      id: "section_1",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [
        { type: "paragraph", id: "inner_1", children: [] },
        { type: "paragraph", id: "inner_2", children: [] },
      ],
    },
    blocks: [
      { type: "paragraph", id: "inner_1", children: [] },
      { type: "paragraph", id: "inner_2", children: [] },
    ],
  } as unknown as RenderUnit;

  it("reads unit geometry from the prebuilt element index instead of querying the flow", () => {
    const unitElements = new Map([["section_unit:0", unitElement(600, 120)]]);
    const inputs = collectProblemAreaColumnInputs(
      unitElements,
      { top: 100, left: 0 } as DOMRect,
      [twoColumnSection],
      new Map([["inner_1", { height: 30 } as BlockExtent], ["inner_2", { height: 40 } as BlockExtent]]),
      1,
      24,
      10,
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0].unitId).toBe("section_unit:0");
    expect(inputs[0].sectionTop).toBe(20);
    expect(inputs[0].contentOffset).toBe(8);
    expect(inputs[0].columnCount).toBe(2);
    expect(inputs[0].blockHeights.map((block) => block.height)).toEqual([30, 40]);
  });

  it("carries keep hints into the shared nested-column input", () => {
    const hinted = structuredClone(twoColumnSection);
    if (hinted.type !== "layoutSection") throw new Error("layout section expected");
    hinted.blocks[0].pagination = { keepWithNext: true };
    hinted.blocks[1] = {
      type: "boxBlock",
      id: "inner_box",
      styleId: "fancybox",
      blocks: [paragraph("box_body", "box")],
      pagination: { keepTogether: true },
    };
    const inputs = collectProblemAreaColumnInputs(
      new Map([[hinted.id, unitElement(600, 120)]]),
      { top: 100, left: 0 } as DOMRect,
      [hinted],
      new Map([[hinted.blocks[0].id, { height: 30 } as BlockExtent], [hinted.blocks[1].id, { height: 40 } as BlockExtent]]),
      1,
      24,
      10,
    );

    expect(inputs[0].blockHeights[0].keepWithNext).toBe(true);
    expect(inputs[0].blockHeights[1].keepTogether).toBe(true);
  });

  it("skips a unit that is absent from the index", () => {
    expect(collectProblemAreaColumnInputs(
      new Map(),
      { top: 100, left: 0 } as DOMRect,
      [twoColumnSection],
      new Map(),
      1,
      24,
      10,
    )).toEqual([]);
  });
});

describe("computeProblemAreaColumnFlow", () => {
  const blocks10 = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, height: 100 }));

  it("stays in balance mode when the area fits in the remaining space", () => {
    const result = computeProblemAreaColumnFlow(blocks10, 2, 100, 10, 600, 1000, 1123);
    expect(result.mode).toBe("balance");
    expect(result.segments).toBe(1);
    expect(result.blockLayouts).toEqual({});
  });

  it("continues columns onto the next page when it does not fit", () => {
    const result = computeProblemAreaColumnFlow(blocks10, 2, 100, 10, 300, 1000, 1123);
    expect(result.mode).toBe("flow");
    expect(result.segments).toBe(2);

    // First segment fills column 0 then column 1 (each capped at availableFirst=300).
    expect(result.blockLayouts.b0).toEqual({ x: 0, y: 0, width: 100 });
    expect(result.blockLayouts.b2).toEqual({ x: 0, y: 200, width: 100 });
    expect(result.blockLayouts.b3).toEqual({ x: 110, y: 0, width: 100 });
    expect(result.blockLayouts.b5).toEqual({ x: 110, y: 200, width: 100 });

    // Segment 1 starts on the next page: availableFirst(300) + pageGap(1123-1000=123) = 423.
    expect(result.blockLayouts.b6).toEqual({ x: 0, y: 423, width: 100 });
    expect(result.blockLayouts.b9).toEqual({ x: 0, y: 723, width: 100 });
    expect(result.totalHeightPx).toBe(823);
  });

  it("moves a full-segment block out of the single-column editor's short first segment", () => {
    const run = () => computeProblemAreaColumnFlow([
      { id: "single_short_first", height: 30 },
      { id: "single_full_segment", height: 60 },
    ], 2, 100, 10, 40, 100, 120);

    const first = run();
    expect(first.blockLayouts.single_short_first).toEqual({ x: 0, y: 0, width: 100 });
    expect(first.blockLayouts.single_full_segment).toEqual({ x: 0, y: 60, width: 100 });
    expect(run()).toEqual(first);
  });

  it("honors manual breaks by moving the block to the next column", () => {
    const result = computeProblemAreaColumnFlow([
      { id: "before", height: 100 },
      { id: "after_break", height: 80, break: true },
    ], 2, 100, 10, 600, 1000, 1123);

    expect(result.mode).toBe("flow");
    expect(result.segments).toBe(1);
    expect(result.blockLayouts.before).toEqual({ x: 0, y: 0, width: 100 });
    expect(result.markerLayouts.after_break).toEqual({ x: 0, y: 100, width: 100 });
    expect(result.blockLayouts.after_break).toEqual({ x: 110, y: 0, width: 100 });
  });

  it("finds the following manual break in a box-local section without layout geometry", () => {
    const section = {
      type: "layoutSection" as const,
      id: "section_1",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [
        paragraph("before_a", "before a"),
        paragraph("before_b", "before b"),
        { ...paragraph("after_break", "after"), pagination: { break: true as const } },
        paragraph("after_break_tail", "tail"),
      ],
    };
    const box: SigmaBlock = {
      type: "boxBlock",
      id: "box_1",
      styleId: "fancybox",
      blocks: [section],
    };

    expect(resolveContextMenuBreakTarget([box], "before_a")).toBe("after_break");
    expect(resolveContextMenuBreakTarget([box], "before_b")).toBe("after_break");
    expect(resolveContextMenuBreakTarget([box], "after_break")).toBeNull();
    expect(resolveContextMenuBreakTarget([box], "after_break_tail")).toBeNull();
  });

  it("resolves each local column segment to its first following manual break", () => {
    const section: SigmaBlock = {
      type: "layoutSection",
      id: "three_segments",
      layout: { columnCount: 3, columnGapMm: 8 },
      children: [
        paragraph("segment_1_a", "1a"),
        paragraph("segment_1_b", "1b"),
        { ...paragraph("segment_2_a", "2a"), pagination: { break: true } },
        paragraph("segment_2_b", "2b"),
        { ...paragraph("segment_3_a", "3a"), pagination: { break: true } },
        paragraph("segment_3_b", "3b"),
      ],
    };

    expect(resolveContextMenuBreakTarget([section], "segment_1_a")).toBe("segment_2_a");
    expect(resolveContextMenuBreakTarget([section], "segment_1_b")).toBe("segment_2_a");
    expect(resolveContextMenuBreakTarget([section], "segment_2_a")).toBe("segment_3_a");
    expect(resolveContextMenuBreakTarget([section], "segment_2_b")).toBe("segment_3_a");
    expect(resolveContextMenuBreakTarget([section], "segment_3_a")).toBeNull();
    expect(resolveContextMenuBreakTarget([section], "segment_3_b")).toBeNull();

    const problem = createProblem({ solution: [structuredClone(section)] });
    expect(resolveContextMenuBreakTarget([problem], "segment_1_b")).toBe("segment_2_a");
    expect(resolveContextMenuBreakTarget([problem], "segment_2_b")).toBe("segment_3_a");
  });

  it("uses rendered columns when long segments advance naturally before manual breaks", () => {
    const section: SigmaBlock = {
      type: "layoutSection",
      id: "long_segments",
      layout: { columnCount: 4, columnGapMm: 8 },
      children: [
        paragraph("long_1", "1"),
        paragraph("long_2", "2"),
        paragraph("long_3", "3"),
        { ...paragraph("manual_1", "4"), pagination: { break: true } },
        paragraph("long_4", "5"),
        { ...paragraph("manual_2", "6"), pagination: { break: true } },
        paragraph("final", "7"),
      ],
    };
    const flow = computeProblemAreaColumnFlow([
      { id: "long_1", height: 60 },
      { id: "long_2", height: 60 },
      { id: "long_3", height: 60 },
      { id: "manual_1", height: 60, break: true },
      { id: "long_4", height: 30 },
      { id: "manual_2", height: 30, break: true },
      { id: "final", height: 30 },
    ], 4, 100, 10, 100, 100, 123);
    const layouts = {
      long_segments: {
        blockLayouts: flow.blockLayouts,
        markerLayouts: flow.markerLayouts,
        totalHeightPx: flow.totalHeightPx,
        columnWidthPx: 100,
        columnGapPx: 10,
      },
    };

    expect(flow.blockLayouts.long_1.x).toBe(0);
    expect(flow.blockLayouts.long_2.x).toBe(110);
    expect(flow.blockLayouts.long_3.x).toBe(220);
    expect(flow.markerLayouts.manual_1.x).toBe(220);
    expect(flow.blockLayouts.manual_1.x).toBe(330);
    expect(flow.markerLayouts.manual_2.x).toBe(330);

    expect(resolveContextMenuBreakTarget([section], "long_1", layouts)).toBeNull();
    expect(resolveContextMenuBreakTarget([section], "long_2", layouts)).toBeNull();
    expect(resolveContextMenuBreakTarget([section], "long_3", layouts)).toBe("manual_1");
    expect(resolveContextMenuBreakTarget([section], "manual_1", layouts)).toBe("manual_2");
    expect(resolveContextMenuBreakTarget([section], "long_4", layouts)).toBe("manual_2");
    expect(resolveContextMenuBreakTarget([section], "manual_2", layouts)).toBeNull();
    expect(resolveContextMenuBreakTarget([section], "final", layouts)).toBeNull();
  });

  it("does not use document order without geometry when a segment may span columns", () => {
    const section: SigmaBlock = {
      type: "layoutSection",
      id: "unverified_segments",
      layout: { columnCount: 4, columnGapMm: 8 },
      children: [
        paragraph("unverified_1", "1"),
        paragraph("unverified_2", "2"),
        { ...paragraph("unverified_break", "3"), pagination: { break: true } },
      ],
    };

    expect(resolveContextMenuBreakTarget([section], "unverified_1")).toBeNull();
    expect(resolveContextMenuBreakTarget([section], "unverified_2")).toBeNull();
  });

  it("keeps the clicked block's own break as the fallback outside local columns", () => {
    const block = {
      ...paragraph("plain_break", "plain break"),
      pagination: { break: true as const },
    };

    expect(resolveContextMenuBreakTarget([block], "plain_break")).toBe("plain_break");
  });

  it("never lets a block straddle a page boundary", () => {
    const result = computeProblemAreaColumnFlow(blocks10, 2, 100, 10, 250, 1000, 1123);
    const pageGap = 1123 - 1000;
    for (const layout of Object.values(result.blockLayouts)) {
      // A block at y in [0, 250) belongs to segment 0; one at y >= 250+pageGap to segment 1.
      // Nothing may sit inside the gap region [250, 250+pageGap).
      const inGap = layout.y >= 250 - 0.5 && layout.y < 250 + pageGap - 0.5;
      expect(inGap).toBe(false);
    }
  });

  it("approximates a balanced column height", () => {
    // 10 blocks of 100 over 2 columns balances to ~500.
    expect(simulateBalancedColumnHeightPx(blocks10.map((b) => b.height), 2)).toBeGreaterThanOrEqual(499);
    expect(simulateBalancedColumnHeightPx(blocks10.map((b) => b.height), 2)).toBeLessThanOrEqual(501);
  });
});

// The single-column (non-column-flow) body layout pass in PageCanvasEditor computes its
// per-block `forceBreakBefore` by looking up each flowed block id (which, per measureFlowBlocks,
// includes blocks nested inside a problem's prompt/hints/solution area — not just top-level
// content) in a block-id map. That pass itself is inline component logic and not exported, so
// this proves the actual lookup it relies on: `collectBlocksById` must resolve a manual
// pagination.break hint on a block nested inside a problem's solution area, which the old
// `new Map(pageDocument.content.map(...))` (top-level only) could never do.
describe("collectBlocksById (single-column break-before lookup)", () => {
  it("finds pagination.break on a paragraph nested in a problem's solution area", () => {
    const problem = createProblem({
      prompt: [paragraph("prompt_block", "問題文")],
      solution: [
        paragraph("solution_block", "解答その1"),
        { ...paragraph("solution_block_2", "解答その2"), pagination: { break: true } },
      ],
    });
    const pageDocument: SigmaDocument = {
      version: "2.0",
      docId: "doc_test",
      metadata: { title: "Test" },
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      content: [problem],
    };

    const blockById = collectBlocksById(pageDocument.content);

    // Mirrors PageCanvasEditor's `blockById.get(item.id)` lookup for a walkItems entry whose
    // id is a block nested inside the problem's solution area.
    const block = blockById.get("solution_block_2");
    expect(block?.type).toBe("paragraph");
    expect(block && block.type !== "listItem" ? block.pagination?.break : undefined).toBe(true);

    // The sibling without a manual break, and the top-level problem itself, are also reachable.
    const sibling = blockById.get("solution_block");
    expect(sibling && sibling.type !== "listItem" ? sibling.pagination?.break : undefined).toBeUndefined();
    expect(blockById.get("problem_1")?.type).toBe("problem");
  });
});

describe("createSingleColumnBoxFragments", () => {
  const metrics = withContentHeight(getPageMetrics(normalizePageLayout({
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  })), 400);
  const pageStride = metrics.page.heightPx + PAGE_GAP_PX;

  const fragmentsFor = () => createSingleColumnBoxFragments({
    blockId: "box_1",
    height: 120,
    metrics,
    pageHeightPx: metrics.page.heightPx,
    pageStride,
    sourceTop: metrics.margins.topPx,
    width: metrics.content.widthPx,
    x: metrics.margins.leftPx,
    breakOffsets: [40, 80],
  });

  it("keeps a box that fits the page whole when nothing forces a cut", () => {
    // breakOffsets alone are only preferred cut positions — they must not split a box
    // that has room to stay whole.
    expect(fragmentsFor()).toHaveLength(1);
  });

  it("uses only measured line bottoms when a box crosses pages", () => {
    const fragments = createSingleColumnBoxFragments({
      blockId: "box_1",
      height: 920,
      metrics,
      pageHeightPx: metrics.page.heightPx,
      pageStride,
      sourceTop: metrics.margins.topPx + 250,
      width: metrics.content.widthPx,
      x: metrics.margins.leftPx,
      breakOffsets: Array.from({ length: 46 }, (_, index) => (index + 1) * 20),
    });
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.slice(0, -1).every((fragment) => fragment.sourceOffsetY % 20 === 0 && fragment.height % 20 === 0)).toBe(true);
  });

  it("keeps split-frame chrome inside every page fragment", () => {
    const metrics = withContentHeight(getPageMetrics(normalizePageLayout()), 100);
    const fragments = createSingleColumnBoxFragments({
      blockId: "framed_tall_block",
      height: 180,
      metrics,
      pageHeightPx: 200,
      pageStride: 220,
      sourceTop: metrics.margins.topPx,
      width: 300,
      x: 20,
      fragmentEndSpacePx: 8,
    });

    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments.every((fragment) => fragment.height + 8 <= 100 + 0.5)).toBe(true);
  });

  it("bounds extreme single-column fragmentation and aggregates the remainder", () => {
    const fragments = createSingleColumnBoxFragments({
      blockId: "bounded_single_column_block",
      height: 1_000_000,
      metrics: withContentHeight(getPageMetrics(normalizePageLayout()), 100),
      pageHeightPx: 200,
      pageStride: 220,
      sourceTop: 20,
      width: 300,
      x: 20,
    });

    expect(fragments).toHaveLength(1_000);
    expect(fragments.reduce((sum, fragment) => sum + fragment.height, 0)).toBe(1_000_000);
    expect(fragments.at(-1)?.height).toBeGreaterThan(100);
  });

});

describe("isFlowBlockFragmentable", () => {
  it("routes every built-in box style through the shared fragmentation engine", () => {
    expect(BUILTIN_BOX_STYLES.map((style) => style.id)).toEqual([
      "fancybox",
      "titlebox",
      "bandbox",
      "itembox",
      "theorembox",
      "tabbox",
      "tcolorbox",
      "tcolorbox-note",
      "doublebox",
      "shadebox",
      "leftbar",
      "dashedbox",
      "ruledbox",
      "screenbox",
      "ovalbox",
      "cornerbox",
    ]);
    expect(BUILTIN_BOX_STYLES.every((style) =>
      isFlowBlockFragmentable(createBoxBlock(style.id, "", { id: `box_${style.id}` }), 20, 400),
    )).toBe(true);
  });

  it("uses measured text lines instead of notebook decoration intervals", () => {
    const block = createBoxBlock("tcolorbox-note", "", { id: "notebook_box" });
    const offsets = getBoxFragmentBreakOffsetsFromMeasuredBox(block, {
      id: block.id,
      top: 0,
      left: 0,
      width: 300,
      height: 100,
      lines: [
        { index: 0, top: 10, left: 10, width: 100, height: 10 },
        { index: 1, top: 30, left: 10, width: 100, height: 10 },
        { index: 2, top: 50, left: 10, width: 100, height: 10 },
      ],
    });
    expect(offsets).toEqual([25, 45, 60]);
  });
});
