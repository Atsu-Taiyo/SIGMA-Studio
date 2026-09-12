import type { TextFlowBlock } from "@/features/text-editing";
import {
  emptyProblemAreaEditorBlockId,
  shouldShowProblemArea,
} from "@/features/rendering/core";
import { PROBLEM_AREA_ORDER } from "@/features/document";
import type {
  BoxBlockChildBlock,
  InlineNode,
  LayoutSectionNode,
  LayoutSectionChildBlock,
  ProblemAreaBlock,
  ProblemAreaKind,
  ProblemNode,
  QuoteChildBlock,
  RichBlock,
  SigmaBlock,
} from "@/features/document";

/**
 * 本文ユニット 1 つに載せるブロック数の**目安**。上限ではない。
 *
 * 境界はブロック id で覚える (`text-run-chunking.ts`) ので、既存ユニットはこの数を多少
 * 上回っても切り直さない — 切ると key が変わって下流のエディタが作り直される。実際の上限は
 * `DEFAULT_TEXT_RUN_CHUNK_LIMITS.max` (この 2 倍)。
 */
export const TEXT_FLOW_BLOCKS_PER_RENDER_UNIT_TARGET = 40;
export { PROBLEM_AREA_ORDER };

/**
 * 段組・削除など「連続する兄弟ブロックの範囲」を要求する操作向けに、
 * DOM選択が触れた兄弟IDのうち anchorId を含む連続runだけを取り出す。
 * 飛び石選択や anchor 非選択のときは anchor 単独に落とす（黙って別の範囲を包まないため）。
 */
export function pickContiguousSelectedSiblingIds(
  siblingIds: readonly string[],
  selectedIds: readonly string[],
  anchorId: string,
): string[] {
  const anchorIndex = siblingIds.indexOf(anchorId);
  const selectedIdSet = new Set(selectedIds);
  if (anchorIndex < 0 || !selectedIdSet.has(anchorId)) {
    return [anchorId];
  }

  let startIndex = anchorIndex;
  while (startIndex > 0 && selectedIdSet.has(siblingIds[startIndex - 1])) {
    startIndex -= 1;
  }

  let endIndex = anchorIndex;
  while (endIndex + 1 < siblingIds.length && selectedIdSet.has(siblingIds[endIndex + 1])) {
    endIndex += 1;
  }

  return siblingIds.slice(startIndex, endIndex + 1);
}

// Area visibility and the derived empty-area block id live in the rendering core so the
// boundary resolver in features/text-editing can share them without reaching into components.
export { emptyProblemAreaEditorBlockId, shouldShowProblemArea };

export function problemAreaBlocksForEditor(problem: ProblemNode, area: ProblemAreaKind): TextFlowBlock[] {
  const blocks = problem[area];
  if (blocks.length > 0) {
    return blocks.map(cloneTextFlowBlock);
  }

  return [{
    type: "paragraph",
    id: emptyProblemAreaEditorBlockId(problem.id, area),
    children: [],
  }];
}

export function isProblemFrameArea(area: ProblemAreaKind): boolean {
  return area === "prompt";
}

export function cloneTextFlowBlock(block: TextFlowBlock): TextFlowBlock {
  if (block.type === "problem") {
    return {
      ...structuredClone(block),
      lead: block.lead.map(child => cloneTextFlowBlock(child) as typeof child),
      prompt: block.prompt.map(child => cloneTextFlowBlock(child) as typeof child),
      hints: block.hints.map(child => cloneTextFlowBlock(child) as typeof child),
      solution: block.solution.map(child => cloneTextFlowBlock(child) as typeof child),
    };
  }
  if (block.type === "section") {
    return { ...block };
  }
  if (block.type === "list") {
    return cloneListBlock(block);
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      title: block.title?.map(cloneInlineNode),
      blocks: block.blocks.map(cloneBoxBlockChild),
    };
  }
  if (block.type === "layoutSection") {
    return {
      ...block,
      layout: { ...block.layout },
      children: block.children.map(cloneLayoutSectionChild),
    };
  }
  if (block.type === "divider") {
    return { ...block };
  }
  if (block.type === "quote") {
    return { ...block, blocks: block.blocks.map(cloneQuoteChild) };
  }
  return {
    ...block,
    children: block.children.map(cloneInlineNode),
  };
}

function cloneQuoteChild(block: QuoteChildBlock): QuoteChildBlock {
  if (block.type === "divider") {
    return { ...block };
  }
  if (block.type === "codeBlock") {
    return { ...block, children: block.children.map(cloneInlineNode) };
  }
  return cloneRichBlock(block);
}

export function problemAreaDraftKey(problemId: string, area: ProblemAreaKind): string {
  return `${problemId}:${area}`;
}

export function hasBreakBefore(block: SigmaBlock | ProblemAreaBlock): boolean {
  return block.pagination?.break === true;
}

export function canInsertManualColumnBreak(layoutSection: LayoutSectionNode): boolean {
  const columnCount = Math.max(1, Math.round(layoutSection.layout.columnCount));
  const manualBreakCount = layoutSection.children
    .slice(1)
    .filter(hasBreakBefore)
    .length;
  return manualBreakCount < columnCount - 1;
}

function cloneRichBlock(block: RichBlock): RichBlock {
  if (block.type === "list") {
    return cloneListBlock(block);
  }
  return {
    ...block,
    children: block.children.map(cloneInlineNode),
  };
}

function cloneBoxBlockChild(block: BoxBlockChildBlock): BoxBlockChildBlock {
  if (block.type === "layoutSection") {
    return {
      ...block,
      layout: { ...block.layout },
      children: block.children.map(cloneLayoutSectionChild),
    };
  }
  return cloneTextFlowBlock(block);
}

export function cloneLayoutSectionChild(block: LayoutSectionChildBlock): LayoutSectionChildBlock {
  if (block.type === "section") {
    return { ...block };
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      title: block.title?.map(cloneInlineNode),
      blocks: block.blocks.map(cloneBoxBlockChild),
    };
  }
  if (block.type === "divider") {
    return { ...block };
  }
  if (block.type === "codeBlock") {
    return { ...block, children: block.children.map(cloneInlineNode) };
  }
  if (block.type === "quote") {
    return { ...block, blocks: block.blocks.map(cloneQuoteChild) };
  }
  return cloneRichBlock(block);
}

export function cloneListBlock(block: Extract<RichBlock, { type: "list" }>): Extract<RichBlock, { type: "list" }> {
  return {
    ...block,
    items: block.items.map((item) => ({
      ...item,
      children: item.children.map(cloneInlineNode),
      nested: item.nested?.map(cloneListBlock),
    })),
  };
}

function cloneInlineNode(node: InlineNode): InlineNode {
  if (node.type === "mathInline") {
    return {
      ...node,
      marks: node.marks ? [...node.marks] : undefined,
    };
  }

  return {
    ...node,
    marks: node.marks ? [...node.marks] : undefined,
  };
}
