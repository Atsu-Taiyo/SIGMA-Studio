import { describe, expect, it } from "vitest";

import { deriveAiEditPreviewOverlayShapes, hasOverlayAiEditChanges, type AiEditPreviewState } from "@/components/editor/ai-edit-preview-types";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import { canInsertManualColumnBreak } from "@/components/editor/page-canvas/block-ops";
import { measureBoxLayoutSectionSideNotes } from "@/components/editor/page-canvas/layout-measure";
import { getSelectionActionPopoverPosition, viewportToCanvasAnchor } from "@/components/editor/page-canvas/popover-anchors";
import  {
  buildProblemAreaOwnerByBlockId,
  buildRenderUnits,
  getLayoutSectionColumnGapPx,
  getPageColumnSideNoteOffsetPx,
} from "@/components/editor/page-canvas/render-units";
import type { RenderUnit } from "@/components/editor/page-canvas/types";
import { calculateVisiblePageRange, getVisiblePageIndexes } from "@/components/editor/page-canvas/virtualization";
import { groupAiEditPreviewEntries } from "@/features/ai-edit";
import { isFlowBlockFragmentable } from "@/features/rendering/core";
import { BUILTIN_BOX_STYLES, createBoxBlock } from "@/lib/box-blocks";
import { collectBlocksById } from "@/lib/document-tree";
import  {
  getPageMetrics,
  mmToPx,
  normalizePageLayout,
} from "@/lib/page-layout";
import type { ProblemNode, RichBlock, SigmaDocument } from "@/types/sigma-doc";

describe("local layout section columns", () => {
  it("resolves an empty problem-area editor placeholder to its owning unit", () => {
    const problem = createProblem({ id: "empty_lead_problem" });
    const leadUnit = problemAreaUnit(problem, "lead", "empty_lead_unit");

    expect(buildProblemAreaOwnerByBlockId([leadUnit]).get("empty_lead_problem_lead_empty")).toBe(leadUnit);
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

});
