import { PROBLEM_AREA_ORDER } from "@/features/document";
import { listItemContinuationInlineNodes } from "@/features/document";
import type {
  BoxBlockChildBlock,
  InlineNode,
  LayoutSectionChildBlock,
  ProblemNode,
  QuoteChildBlock,
  RichBlock,
  SigmaBlock,
} from "@/features/document";
import {
  emptyProblemAreaEditorBlockId,
  shouldShowProblemArea,
} from "@/features/rendering/core";

import type { TextFlowBlock } from "../model";

export interface TextFlowBoundaryDeleteInput {
  direction: "backward" | "forward";
  blockId: string;
  emptyBlock: boolean;
}

export interface TextFlowBoundaryDeleteResult {
  previousIds: string[];
  nextBlocks: TextFlowBlock[];
  focusBlockId: string;
  focusPosition: "start" | "end";
  activeIds: string[];
}

/**
 * Resolves a boundary Backspace/Delete without reading or mutating editor state.
 *
 * The host editor owns the eventual document update and focus scheduling; this
 * function only describes the equivalent SigmaDoc block transition.
 */
export function resolveTextFlowBoundaryDelete(
  content: SigmaBlock[],
  request: TextFlowBoundaryDeleteInput,
): TextFlowBoundaryDeleteResult | null {
  const index = content.findIndex((block) => block.id === request.blockId && isTopLevelTextFlowBlock(block));
  if (index < 0) {
    return null;
  }

  const currentBlock = content[index];
  if (!isTopLevelTextFlowBlock(currentBlock)) {
    return null;
  }
  const current: TextFlowBlock = currentBlock;

  const previousBlock = index > 0 ? content[index - 1] : null;
  const nextBlock = index < content.length - 1 ? content[index + 1] : null;
  const previous: TextFlowBlock | null = previousBlock && isTopLevelTextFlowBlock(previousBlock)
    ? previousBlock
    : null;
  const next: TextFlowBlock | null = nextBlock && isTopLevelTextFlowBlock(nextBlock)
    ? nextBlock
    : null;
  const currentIsEmpty = request.emptyBlock || isEmptyTextFlowBlock(current);

  if (request.direction === "backward" && hasManualBreakBefore(current)) {
    return previous
      ? boundaryNavigationOnly(previous, "end")
      : boundaryNavigationOnly(current, "start");
  }

  if (request.direction === "forward" && next && hasManualBreakBefore(next)) {
    return boundaryNavigationOnly(next, "start");
  }

  if (currentIsEmpty) {
    const focusTarget = request.direction === "backward"
      ? previous ?? next
      : next ?? previous;
    if (focusTarget) {
      return {
        previousIds: [current.id],
        nextBlocks: [],
        focusBlockId: focusTarget.id,
        focusPosition: focusTarget === previous ? "end" : "start",
        activeIds: [focusTarget.id],
      };
    }

    // No body sibling in this run. A problem block is not part of the run, so without
    // this branch an empty paragraph wedged between problems (or against the start or
    // end of the document) would have nothing to merge into and stay undeletable.
    const problemEdge = request.direction === "backward"
      ? resolveProblemEdge(previousBlock, "end") ?? resolveProblemEdge(nextBlock, "start")
      : resolveProblemEdge(nextBlock, "start") ?? resolveProblemEdge(previousBlock, "end");
    if (!problemEdge) {
      return null;
    }

    return {
      previousIds: [current.id],
      nextBlocks: [],
      focusBlockId: problemEdge.blockId,
      focusPosition: problemEdge.position,
      activeIds: [problemEdge.blockId],
    };
  }

  // A block with content never merges across a problem: the caret moves to the problem's
  // edge instead, matching how ArrowUp/ArrowDown already travel between the two editors.
  const adjacentProblemEdge = request.direction === "backward"
    ? (previous ? null : resolveProblemEdge(previousBlock, "end"))
    : (next ? null : resolveProblemEdge(nextBlock, "start"));
  if (adjacentProblemEdge) {
    return navigationOnly(adjacentProblemEdge.blockId, adjacentProblemEdge.position);
  }

  if (request.direction === "backward" && previous) {
    const merged = mergeTextFlowBlocks(previous, current);
    if (!merged) {
      return null;
    }

    return {
      previousIds: [previous.id, current.id],
      nextBlocks: [merged],
      focusBlockId: previous.id,
      focusPosition: "end",
      activeIds: [previous.id],
    };
  }

  if (request.direction === "forward" && next) {
    const merged = mergeTextFlowBlocks(current, next);
    if (!merged) {
      return null;
    }

    return {
      previousIds: [current.id, next.id],
      nextBlocks: [merged],
      focusBlockId: current.id,
      focusPosition: "end",
      activeIds: [current.id],
    };
  }

  return null;
}

interface ProblemEdgeFocus {
  blockId: string;
  position: "start" | "end";
}

/**
 * The block the caret should land on when it leaves the body flow into an adjacent problem:
 * the first block of the problem's first rendered area, or the last block of its last one.
 * A rendered-but-empty area contributes its derived placeholder block, which is what the
 * editor actually mounts there.
 */
function resolveProblemEdge(
  block: SigmaBlock | null,
  edge: "start" | "end",
): ProblemEdgeFocus | null {
  if (!block || block.type !== "problem") {
    return null;
  }

  const problem: ProblemNode = block;
  const areas = PROBLEM_AREA_ORDER.filter((area) => shouldShowProblemArea(problem, area));
  const area = edge === "end" ? areas.at(-1) : areas[0];
  if (!area) {
    return null;
  }

  const blocks = problem[area];
  const target = edge === "end" ? blocks.at(-1) : blocks[0];

  return {
    blockId: target?.id ?? emptyProblemAreaEditorBlockId(problem.id, area),
    position: edge,
  };
}

function boundaryNavigationOnly(
  target: TextFlowBlock,
  focusPosition: "start" | "end",
): TextFlowBoundaryDeleteResult {
  return navigationOnly(target.id, focusPosition);
}

function navigationOnly(
  blockId: string,
  focusPosition: "start" | "end",
): TextFlowBoundaryDeleteResult {
  return {
    previousIds: [],
    nextBlocks: [],
    focusBlockId: blockId,
    focusPosition,
    activeIds: [blockId],
  };
}

function hasManualBreakBefore(block: TextFlowBlock): boolean {
  return block.pagination?.break === true;
}

function isTopLevelTextFlowBlock(block: SigmaBlock): block is Exclude<TextFlowBlock, { type: "layoutSection" }> {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "quote"
    || block.type === "codeBlock"
    || block.type === "divider"
    || block.type === "boxBlock";
}

function isEmptyTextFlowBlock(block: TextFlowBlock): boolean {
  if (block.type === "section") {
    return block.title.trim().length === 0;
  }

  if (block.type === "list") {
    return !block.items.some(listItemHasContent);
  }

  if (block.type === "boxBlock") {
    return areInlineNodesEmpty(block.title ?? []) && block.blocks.every(isEmptyBoxBlockChild);
  }

  if (block.type === "layoutSection") {
    return block.children.every(isEmptyLayoutSectionChild);
  }

  // 区切り線は文章を持たないが「空」ではない — 空と見なすと、境界の削除処理が
  // 何も無いブロックとして黙って消してしまう。
  if (block.type === "divider" || block.type === "problem") {
    return false;
  }

  if (block.type === "quote") {
    return block.blocks.every(isEmptyQuoteChild);
  }

  return areInlineNodesEmpty(block.children);
}

function isEmptyQuoteChild(block: QuoteChildBlock): boolean {
  if (block.type === "divider") {
    return false;
  }
  if (block.type === "list") {
    return !block.items.some(listItemHasContent);
  }
  return areInlineNodesEmpty(block.children);
}

function isEmptyBoxBlockChild(block: BoxBlockChildBlock): boolean {
  if (block.type === "layoutSection") {
    return block.children.every(isEmptyLayoutSectionChild);
  }
  return isEmptyTextFlowBlock(block);
}

function isEmptyLayoutSectionChild(block: LayoutSectionChildBlock): boolean {
  if (block.type === "section") {
    return block.title.trim().length === 0;
  }
  if (block.type === "boxBlock") {
    return areInlineNodesEmpty(block.title ?? []) && block.blocks.every(isEmptyBoxBlockChild);
  }
  if (block.type === "list") {
    return !block.items.some(listItemHasContent);
  }
  if (block.type === "divider") {
    return false;
  }
  if (block.type === "quote") {
    return block.blocks.every(isEmptyQuoteChild);
  }
  return areInlineNodesEmpty(block.children);
}

function listItemHasContent(item: Extract<RichBlock, { type: "list" }>["items"][number]): boolean {
  return !areInlineNodesEmpty(item.children) ||
    (item.continuations ?? []).some((continuation) => !areInlineNodesEmpty(listItemContinuationInlineNodes(continuation))) ||
    (item.nested ?? []).some((list) => list.items.some(listItemHasContent));
}

function areInlineNodesEmpty(children: InlineNode[]): boolean {
  return children.every((child) => {
    if (child.type === "mathInline") {
      return child.tex.trim().length === 0;
    }
    return child.text.trim().length === 0;
  });
}

function mergeTextFlowBlocks(target: TextFlowBlock, source: TextFlowBlock): TextFlowBlock | null {
  if (
    target.type === "problem" ||
    source.type === "problem" ||
    target.type === "section" ||
    source.type === "section" ||
    target.type === "list" ||
    source.type === "list" ||
    target.type === "layoutSection" ||
    source.type === "layoutSection" ||
    target.type === "boxBlock" ||
    source.type === "boxBlock" ||
    // 区切り線には文章が無いので、前後のブロックと併合できない。
    target.type === "divider" ||
    source.type === "divider" ||
    // 引用は入れ物なので、後ろのブロックを吸い込むと入れ物の中身が変わってしまう。
    // 種別が違う併合 (コード ⇄ 段落) も、どちらの見せ方を残すか決められない。
    target.type === "quote" ||
    source.type === "quote" ||
    target.type !== source.type
  ) {
    return null;
  }

  return {
    ...target,
    children: [...target.children, ...source.children],
  };
}
