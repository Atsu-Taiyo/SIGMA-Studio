import { describe, expect, it } from "vitest";

import {
  createPerfBodyDocument,
  PERF_BODY_BLOCK_ID_PREFIX,
  PERF_BODY_EMPTY_PARAGRAPH_COUNT,
  PERF_BODY_MATH_NODE_COUNT,
  PERF_BODY_MATH_PARAGRAPH_COUNT,
  PERF_BODY_PARAGRAPH_COUNT,
} from "./perf-body-document";
import {
  createPerfProblemDocument,
  PERF_PROBLEM_COUNT,
  PERF_PROBLEM_FRAMED_COUNT,
  PERF_PROBLEM_GEO_SHAPES,
  PERF_PROBLEM_GRAPH_SHAPES,
  PERF_PROBLEM_IMAGE_SHAPES,
  PERF_PROBLEM_OVERSIZED_PROBLEM_ID,
  PERF_PROBLEM_TABLE_SHAPES,
  PERF_PROBLEM_TOTAL_SHAPES,
} from "./perf-problem-document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { InlineNode, ProblemNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

/** A framed problem taller than this many single-line blocks cannot fit one A4 column. */
const A4_COLUMN_LINE_CAPACITY = 40;

function countMathNodes(document: SigmaDocument): number {
  let total = 0;
  walkBlocks(document.content, (block) => {
    total += countMathInChildren(blockChildren(block));
  });
  return total;
}

function countMathInChildren(children: readonly InlineNode[]): number {
  return children.filter((child) => child.type === "mathInline").length;
}

function blockChildren(block: SigmaBlock): readonly InlineNode[] {
  if (block.type === "paragraph" || block.type === "heading") {
    return block.children;
  }
  if (block.type === "list") {
    return block.items.flatMap((item) => item.children);
  }
  return [];
}

function walkBlocks(blocks: readonly SigmaBlock[], visit: (block: SigmaBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.type === "problem") {
      walkBlocks([...block.lead, ...block.prompt, ...block.hints, ...block.solution], visit);
    } else if (block.type === "layoutSection") {
      walkBlocks(block.children, visit);
    } else if (block.type === "boxBlock") {
      walkBlocks(block.blocks, visit);
    }
  }
}

function collectBlocks(document: SigmaDocument): SigmaBlock[] {
  const blocks: SigmaBlock[] = [];
  walkBlocks(document.content, (block) => blocks.push(block));
  return blocks;
}

function problemBlockCount(problem: ProblemNode): number {
  let total = 0;
  walkBlocks([...problem.lead, ...problem.prompt, ...problem.hints, ...problem.solution], () => {
    total += 1;
  });
  return total;
}

describe("createPerfBodyDocument", () => {
  it("produces byte-identical JSON on repeated calls", () => {
    expect(JSON.stringify(createPerfBodyDocument())).toBe(JSON.stringify(createPerfBodyDocument()));
  });

  it("emits the declared paragraph, empty-paragraph and math counts", () => {
    const document = createPerfBodyDocument();
    const paragraphs = document.content.filter((block) => block.type === "paragraph");
    expect(paragraphs).toHaveLength(PERF_BODY_PARAGRAPH_COUNT);
    expect(document.content).toHaveLength(PERF_BODY_PARAGRAPH_COUNT);
    expect(paragraphs.filter((block) => block.children.length === 0))
      .toHaveLength(PERF_BODY_EMPTY_PARAGRAPH_COUNT);
    expect(paragraphs.filter((block) => countMathInChildren(block.children) > 0))
      .toHaveLength(PERF_BODY_MATH_PARAGRAPH_COUNT);
    expect(countMathNodes(document)).toBe(PERF_BODY_MATH_NODE_COUNT);
  });

  it("gives every block a unique, prefixed id", () => {
    const ids = collectBlocks(createPerfBodyDocument()).map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(PERF_BODY_BLOCK_ID_PREFIX))).toBe(true);
  });

  it("is a single-column A4 document accepted by the SigmaDoc schema", () => {
    const document = createPerfBodyDocument();
    expect(document.pageLayout?.flow.columnCount).toBe(1);
    expect(() => parseSigmaDocument(document)).not.toThrow();
  });
});

describe("createPerfProblemDocument", () => {
  it("produces byte-identical JSON on repeated calls", () => {
    expect(JSON.stringify(createPerfProblemDocument()))
      .toBe(JSON.stringify(createPerfProblemDocument()));
  });

  it("emits the declared problem count with framed problems among them", () => {
    const problems = collectBlocks(createPerfProblemDocument())
      .filter((block): block is ProblemNode => block.type === "problem");
    expect(problems).toHaveLength(PERF_PROBLEM_COUNT);
    expect(problems.filter((problem) => problem.frame?.enabled === true))
      .toHaveLength(PERF_PROBLEM_FRAMED_COUNT);
  });

  it("includes one framed problem too tall for a single A4 column", () => {
    const problems = collectBlocks(createPerfProblemDocument())
      .filter((block): block is ProblemNode => block.type === "problem");
    const oversized = problems.find((problem) => problem.id === PERF_PROBLEM_OVERSIZED_PROBLEM_ID);
    expect(oversized).toBeDefined();
    expect(oversized?.frame?.enabled).toBe(true);
    expect(problemBlockCount(oversized!)).toBeGreaterThan(A4_COLUMN_LINE_CAPACITY);
  });

  it("sets an explicit area layout on every problem except the page-overflowing one", () => {
    const problems = collectBlocks(createPerfProblemDocument())
      .filter((block): block is ProblemNode => block.type === "problem");
    const [oversized, sized] = [
      problems.filter((problem) => problem.id === PERF_PROBLEM_OVERSIZED_PROBLEM_ID),
      problems.filter((problem) => problem.id !== PERF_PROBLEM_OVERSIZED_PROBLEM_ID),
    ];
    expect(sized.every((problem) => typeof problem.areaLayout?.prompt?.minHeightMm === "number"))
      .toBe(true);
    // 非収束を再現していた実データの問題は areaLayout を持たず lead が空だった。
    expect(oversized[0]?.areaLayout).toBeUndefined();
    expect(oversized[0]?.lead).toEqual([]);
  });

  it("carries multi-column layout sections", () => {
    const layoutSections = collectBlocks(createPerfProblemDocument())
      .filter((block) => block.type === "layoutSection");
    expect(layoutSections.length).toBeGreaterThan(0);
    expect(layoutSections.every((block) => block.type === "layoutSection" && block.layout.columnCount > 1))
      .toBe(true);
  });

  it("emits the declared overlay shape mix", () => {
    const shapes = createPerfProblemDocument().pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const byType = (type: string) => shapes.filter((shape) => shape.type === type).length;
    expect(shapes).toHaveLength(PERF_PROBLEM_TOTAL_SHAPES);
    expect(byType("geo")).toBe(PERF_PROBLEM_GEO_SHAPES);
    expect(byType("image")).toBe(PERF_PROBLEM_IMAGE_SHAPES);
    expect(byType("graph2dShape")).toBe(PERF_PROBLEM_GRAPH_SHAPES);
    expect(byType("tableShape")).toBe(PERF_PROBLEM_TABLE_SHAPES);
  });

  it("anchors part of the overlay to real body blocks and resolves every image asset", () => {
    const document = createPerfProblemDocument();
    const snapshot = document.pageLayout?.overlay?.overlaySnapshot;
    const blockIds = new Set(collectBlocks(document).map((block) => block.id));
    const anchored = (snapshot?.shapes ?? []).filter((shape) => shape.anchor?.type === "block");
    expect(anchored.length).toBeGreaterThan(0);
    // 冒頭の数ブロックに全部ぶら下がると「本文に追従する図形」を計測したことにならない。
    const anchorTargets = new Set(
      anchored.map((shape) => (shape.anchor?.type === "block" ? shape.anchor.blockId : "")),
    );
    expect(anchorTargets.size).toBeGreaterThanOrEqual(PERF_PROBLEM_COUNT);
    for (const shape of anchored) {
      expect(blockIds.has(shape.anchor?.type === "block" ? shape.anchor.blockId : "")).toBe(true);
    }
    for (const shape of snapshot?.shapes ?? []) {
      if (shape.type === "image") {
        expect(snapshot?.assets[shape.props.assetId]).toBeDefined();
      }
    }
  });

  it("gives every block a unique id and is accepted by the SigmaDoc schema", () => {
    const document = createPerfProblemDocument();
    const ids = collectBlocks(document).map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => parseSigmaDocument(document)).not.toThrow();
  });
});
