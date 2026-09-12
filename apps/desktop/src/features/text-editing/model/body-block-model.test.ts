import { describe, expect, it } from "vitest";

import type {
  BoxBlockNode,
  LayoutSectionNode,
  ParagraphNode,
  ProblemNode,
  SigmaBlock,
} from "@/features/document";

import {
  bodyTextFlowBlockContainsId,
  collectBoxBlocksById,
  DEFAULT_PROBLEM_NUMBER_FONT_SIZE,
  findTopLevelBlock,
  getNextTopLevelTextFlowBlockId,
  getNestedPageBreakBeforeKinds,
  getLayoutSectionColumns,
  getPageBreakBeforeIds,
  getProblemNumberFontSize,
  isBodyContextMenuBlock,
  isColumnWrapTargetBlock,
  isProblemAreaKind,
  setBlockBreakBefore,
  setBlockSpaceAfter,
  setLayoutSectionColumnCount,
} from "./body-block-model";

function paragraph(id: string): ParagraphNode {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text: id }],
  };
}

function box(id: string, blocks: BoxBlockNode["blocks"] = []): BoxBlockNode {
  return {
    type: "boxBlock",
    id,
    styleId: "fancybox",
    blocks,
  };
}

function layoutSection(
  id: string,
  children: LayoutSectionNode["children"],
  columnCount = 2,
): LayoutSectionNode {
  return {
    type: "layoutSection",
    id,
    layout: { columnCount, columnGapMm: 8 },
    children,
  };
}

function problem(id: string): ProblemNode {
  return {
    type: "problem",
    id,
    tags: [],
    lead: [],
    prompt: [paragraph(`${id}-prompt`)],
    solution: [],
    hints: [],
  };
}

describe("body block model", () => {
  it("repairs a moved first-column start without inventing another column", () => {
    const section: LayoutSectionNode = {
      ...layoutSection("layout", [
        paragraph("split-head"),
        paragraph("left-start"),
        paragraph("left-tail"),
        paragraph("right-start"),
        paragraph("right-tail"),
      ]),
      layout: {
        columnCount: 2,
        columnGapMm: 8,
        columnStartIds: ["left-start", "right-start"],
        columnWidths: [6000, 4000],
      },
    };

    expect(getLayoutSectionColumns(section).map((column) => column.map((block) => block.id)))
      .toEqual([
        ["split-head", "left-start", "left-tail"],
        ["right-start", "right-tail"],
      ]);
  });

  it("keeps the requested column count without moving an unrelated survivor across a missing boundary", () => {
    const children = [paragraph("a"), paragraph("b"), paragraph("c"), paragraph("d")];
    const missing: LayoutSectionNode = {
      ...layoutSection("missing", children),
      layout: { columnCount: 2, columnGapMm: 8, columnStartIds: ["a", "gone"] },
    };
    const outOfOrder: LayoutSectionNode = {
      ...layoutSection("out-of-order", children),
      layout: { columnCount: 2, columnGapMm: 8, columnStartIds: ["c", "a"] },
    };

    for (const section of [missing, outOfOrder]) {
      const columns = getLayoutSectionColumns(section);
      expect(columns).toHaveLength(2);
      expect(columns.flat().map((block) => block.id)).toEqual(["a", "b", "c", "d"]);
      expect(columns.map((column) => column[0].id)).toEqual(["a", "d"]);
    }
  });

  it("keeps the surviving prefix in its original column when the next column start was deleted", () => {
    const section: LayoutSectionNode = {
      ...layoutSection("deleted-boundary", [paragraph("a"), paragraph("b"), paragraph("d")]),
      layout: { columnCount: 2, columnGapMm: 8, columnStartIds: ["a", "c"] },
    };

    expect(getLayoutSectionColumns(section).map((column) => column.map((block) => block.id)))
      .toEqual([["a", "b"], ["d"]]);
  });

  it("recognizes only canonical problem area names", () => {
    expect(["lead", "prompt", "hints", "solution"].filter(isProblemAreaKind))
      .toEqual(["lead", "prompt", "hints", "solution"]);
    expect(isProblemAreaKind(null)).toBe(false);
    expect(isProblemAreaKind("answer")).toBe(false);
  });

  it("uses a finite positive problem number font size or the canonical fallback", () => {
    expect(getProblemNumberFontSize({
      ...problem("problem"),
      numbering: { fontSize: 14 },
    })).toBe(14);

    for (const fontSize of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getProblemNumberFontSize({
        ...problem("problem"),
        numbering: { fontSize },
      })).toBe(DEFAULT_PROBLEM_NUMBER_FONT_SIZE);
    }
    expect(getProblemNumberFontSize(problem("problem"))).toBe(DEFAULT_PROBLEM_NUMBER_FONT_SIZE);
  });

  it("returns page-break ids in document order", () => {
    expect(getPageBreakBeforeIds([
      paragraph("first"),
      {
        ...paragraph("second"),
        pagination: { break: true, keepWithNext: true },
      },
      {
        ...paragraph("third"),
        pagination: { break: false },
      },
      {
        ...paragraph("fourth"),
        pagination: { break: true },
      },
    ])).toEqual(["second", "fourth"]);
  });

  it("labels box breaks with their surrounding page or local column flow", () => {
    const directBreak = {
      ...paragraph("box-direct-break"),
      pagination: { break: true as const },
    };
    const innerColumnBreak = {
      ...paragraph("box-column-break"),
      pagination: { break: true as const },
    };
    const innerPageBreak = {
      ...paragraph("box-one-column-break"),
      pagination: { break: true as const },
    };

    expect(getNestedPageBreakBeforeKinds([
      box("box", [
        paragraph("box-first"),
        directBreak,
        layoutSection("box-columns", [paragraph("box-column-first"), innerColumnBreak], 2),
        layoutSection("box-one-column", [paragraph("box-one-column-first"), innerPageBreak], 1),
      ]),
    ])).toEqual({
      "box-column-break": "columnBreak",
      "box-direct-break": "pageBreak",
      "box-one-column-break": "pageBreak",
    });
  });

  it("limits column wrapping to section, heading, paragraph, and list blocks", () => {
    expect(isColumnWrapTargetBlock({ type: "section", id: "section", title: "Section" })).toBe(true);
    expect(isColumnWrapTargetBlock({
      type: "heading",
      id: "heading",
      level: 2,
      children: [],
    })).toBe(true);
    expect(isColumnWrapTargetBlock(paragraph("paragraph"))).toBe(true);
    expect(isColumnWrapTargetBlock({
      type: "list",
      id: "list",
      listType: "bullet",
      items: [],
    })).toBe(true);
    expect(isColumnWrapTargetBlock(box("box"))).toBe(false);
    expect(isColumnWrapTargetBlock(layoutSection("layout", []))).toBe(false);
    expect(isColumnWrapTargetBlock({
      type: "listItem",
      id: "item",
      children: [],
    })).toBe(false);
    expect(isColumnWrapTargetBlock(problem("problem"))).toBe(false);
  });

  it("accepts document blocks but not list items as body context-menu blocks", () => {
    expect(isBodyContextMenuBlock(paragraph("paragraph"))).toBe(true);
    expect(isBodyContextMenuBlock(problem("problem"))).toBe(true);
    expect(isBodyContextMenuBlock(layoutSection("layout", []))).toBe(true);
    expect(isBodyContextMenuBlock({
      type: "listItem",
      id: "item",
      children: [],
    })).toBe(false);
  });

  it("finds selected ids recursively inside box, layout, and nested list blocks", () => {
    const tree = box("outer-box", [
      layoutSection("layout", [
        {
          type: "list",
          id: "list",
          listType: "bullet",
          items: [{
            type: "listItem",
            id: "list-item",
            children: [],
            nested: [{
              type: "list",
              id: "nested-list",
              listType: "bullet",
              items: [{
                type: "listItem",
                id: "nested-item",
                children: [],
              }],
            }],
          }],
        },
      ]),
    ]);

    for (const id of ["outer-box", "layout", "list", "list-item", "nested-list", "nested-item"]) {
      expect(bodyTextFlowBlockContainsId(tree, id)).toBe(true);
    }
    expect(bodyTextFlowBlockContainsId(tree, null)).toBe(false);
    expect(bodyTextFlowBlockContainsId(tree, "missing")).toBe(false);
  });

  it("clamps explicit layout columns and creates a block for every requested column", () => {
    const section = layoutSection("layout", [paragraph("body")]);
    let emptyIndex = 0;
    const empty = () => paragraph(`empty-${emptyIndex++}`);

    const aboveMaximum = setLayoutSectionColumnCount(section, 9.9, empty);
    const belowMinimum = setLayoutSectionColumnCount(section, -4);
    const fractional = setLayoutSectionColumnCount(section, 3.9, empty);

    expect(aboveMaximum.layout.columnCount).toBe(4);
    expect(aboveMaximum.children).toHaveLength(4);
    expect(aboveMaximum.layout.columnStartIds).toEqual(aboveMaximum.children.map((child) => child.id));
    expect(belowMinimum.layout.columnCount).toBe(1);
    expect(fractional.layout.columnCount).toBe(3);
    expect(section.layout.columnCount).toBe(2);

    const nonSection = paragraph("paragraph");
    expect(setLayoutSectionColumnCount(nonSection, 3)).toBe(nonSection);
  });

  it("removes legacy column breaks when rebuilding explicit columns", () => {
    const section = layoutSection("layout", [
      paragraph("first"),
      {
        ...paragraph("kept-break"),
        pagination: { break: true, keepWithNext: true },
      },
      {
        ...paragraph("pruned-break"),
        pagination: { break: true, keepTogether: true },
      },
      paragraph("last"),
    ], 3);

    const updated = setLayoutSectionColumnCount(section, 2);

    expect(updated.children.map((child) => child.id)).toEqual([
      "first",
      "kept-break",
      "pruned-break",
      "last",
    ]);
    expect(updated.children[1].pagination).toEqual({ keepWithNext: true });
    expect(updated.children[2].pagination).toEqual({ keepTogether: true });
    expect(updated.children.filter((child, index) => (
      index > 0 && child.pagination?.break === true
    ))).toHaveLength(0);
    expect(updated.layout.columnStartIds).toEqual(["first", "pruned-break"]);
  });

  it("uses structural ownership instead of retaining manual column breaks", () => {
    const firstBreak = {
      ...paragraph("first-break"),
      pagination: { break: true as const },
    };
    const secondBreak = {
      ...paragraph("second-break"),
      pagination: { break: true as const, keepWithNext: true },
    };
    const section = layoutSection("layout", [paragraph("first"), firstBreak, secondBreak], 2);

    const updated = setLayoutSectionColumnCount(section, 3);

    expect(updated.children[1]).not.toBe(firstBreak);
    expect(updated.children[2]).not.toBe(secondBreak);
    expect(updated.children.filter((child, index) => (
      index > 0 && child.pagination?.break === true
    ))).toHaveLength(0);
    expect(updated.layout.columnStartIds).toEqual(["first", "first-break", "second-break"]);
  });

  it("toggles the manual break while retaining unrelated pagination hints", () => {
    const block = {
      ...paragraph("paragraph"),
      pagination: { keepWithNext: true, keepTogether: true },
    };

    const enabled = setBlockBreakBefore(block, true);
    expect(enabled).toEqual({
      ...block,
      pagination: {
        keepWithNext: true,
        keepTogether: true,
        break: true,
      },
    });
    expect(block.pagination).toEqual({ keepWithNext: true, keepTogether: true });

    expect(setBlockBreakBefore(enabled, false)).toEqual(block);
    expect(setBlockBreakBefore(paragraph("empty-hints"), false)).toEqual(paragraph("empty-hints"));
  });

  it("finds only direct top-level blocks", () => {
    const nested = paragraph("nested");
    const content: SigmaBlock[] = [
      paragraph("first"),
      problem("problem"),
      layoutSection("layout", [nested]),
    ];

    expect(findTopLevelBlock(content, "problem")).toBe(content[1]);
    expect(findTopLevelBlock(content, "nested")).toBeNull();
    expect(findTopLevelBlock(content, "missing")).toBeNull();
  });

  it("collects boxes recursively across body, layout, and every problem area", () => {
    const deeplyNestedBox = box("deep");
    const topLevelBox = box("top", [
      layoutSection("box-layout", [
        deeplyNestedBox,
      ]),
    ]);
    const layoutBox = box("layout-box");
    const areaBoxes = {
      lead: box("lead-box"),
      prompt: box("prompt-box"),
      hints: box("hints-box"),
      solution: box("solution-box"),
    };
    const problemWithBoxes: ProblemNode = {
      ...problem("problem"),
      lead: [layoutSection("lead-layout", [areaBoxes.lead])],
      prompt: [layoutSection("prompt-layout", [areaBoxes.prompt])],
      hints: [layoutSection("hints-layout", [areaBoxes.hints])],
      solution: [layoutSection("solution-layout", [areaBoxes.solution])],
    };
    const content: SigmaBlock[] = [
      topLevelBox,
      layoutSection("top-layout", [layoutBox]),
      problemWithBoxes,
    ];

    const boxes = collectBoxBlocksById(content);

    expect([...boxes.keys()]).toEqual([
      "top",
      "deep",
      "layout-box",
      "lead-box",
      "prompt-box",
      "hints-box",
      "solution-box",
    ]);
    expect(boxes.get("deep")).toBe(deeplyNestedBox);
    expect(boxes.get("prompt-box")).toBe(areaBoxes.prompt);
  });

  it("returns only an immediately adjacent top-level text-flow block", () => {
    const first = paragraph("first");
    const second = box("second");
    const nonText = problem("problem");
    const afterProblem = paragraph("after-problem");
    const layout = layoutSection("layout", [paragraph("layout-child")]);
    const content: SigmaBlock[] = [first, second, nonText, afterProblem, layout];

    expect(getNextTopLevelTextFlowBlockId(content, "first")).toBe("second");
    expect(getNextTopLevelTextFlowBlockId(content, "second")).toBeNull();
    expect(getNextTopLevelTextFlowBlockId(content, "problem")).toBeNull();
    expect(getNextTopLevelTextFlowBlockId(content, "after-problem")).toBeNull();
    expect(getNextTopLevelTextFlowBlockId(content, "layout")).toBeNull();
    expect(getNextTopLevelTextFlowBlockId(content, "missing")).toBeNull();
  });
});

describe("setBlockSpaceAfter", () => {
  it("stores a whole-pixel space below the block", () => {
    expect(setBlockSpaceAfter(paragraph("p"), 12).spaceAfterPx).toBe(12);
  });

  it("rounds to whole CSS px", () => {
    expect(setBlockSpaceAfter(paragraph("p"), 12.6).spaceAfterPx).toBe(13);
  });

  it("clamps to the maximum", () => {
    expect(setBlockSpaceAfter(paragraph("p"), 10_000).spaceAfterPx).toBe(400);
  });

  it("never goes below 0", () => {
    expect("spaceAfterPx" in setBlockSpaceAfter(paragraph("p"), -30)).toBe(false);
  });

  it("removes the field on reset instead of storing 0", () => {
    const result = setBlockSpaceAfter({ ...paragraph("p"), spaceAfterPx: 24 }, 0);

    expect("spaceAfterPx" in result).toBe(false);
  });

  it("returns the same reference when nothing changes", () => {
    const block = { ...paragraph("p"), spaceAfterPx: 24 };

    expect(setBlockSpaceAfter(block, 24)).toBe(block);
  });

  it("returns the same reference when resetting an untouched block", () => {
    const block = paragraph("p");

    expect(setBlockSpaceAfter(block, 0)).toBe(block);
  });

  it("keeps the rest of the block intact", () => {
    const block: ParagraphNode = { ...paragraph("p"), align: "center", pagination: { break: true } };
    const result = setBlockSpaceAfter(block, 24);

    expect(result).toEqual({ ...block, spaceAfterPx: 24 });
  });
});
