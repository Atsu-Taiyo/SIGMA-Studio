import { createId } from "@/lib/id";
import type { TextFlowBlock } from "@/features/text-editing";
import type {
  LayoutSectionChildBlock,
  ProblemAreaBlock,
} from "@/features/document";

import {
  cloneLayoutSectionChild,
  cloneListBlock,
} from "./block-ops";
import {
  uniqueLayoutSectionBlocks,
  uniqueProblemAreaBlocks,
} from "./id-normalization";

/**
 * Reconciles one edited TextFlow range back into a problem area's persisted
 * blocks while preserving references for blocks whose serialized value is
 * unchanged.
 */
export function replaceProblemAreaRichBlocks(
  blocks: ProblemAreaBlock[],
  previousIds: string[],
  nextBlocks: TextFlowBlock[],
  reservedIds: Set<string>,
): ProblemAreaBlock[] {
  const replacement = uniqueProblemAreaBlocks(
    nextBlocks.map(textFlowBlockToProblemAreaBlock),
    reservedIds,
  );
  if (blocks.length === 0) {
    return replacement;
  }

  const previousIdSet = new Set(previousIds);
  const firstIndex = blocks.findIndex((block) => previousIdSet.has(block.id));
  if (firstIndex < 0) {
    return blocks;
  }

  const replacementIdSet = new Set([
    ...previousIds,
    ...replacement.map((block) => block.id),
  ]);
  let deleteCount = 0;
  while (
    blocks[firstIndex + deleteCount]
    && replacementIdSet.has(blocks[firstIndex + deleteCount].id)
  ) {
    deleteCount += 1;
  }

  const replacementWithReferences = reuseUnchangedBlockReferences(
    blocks.slice(firstIndex, firstIndex + deleteCount),
    replacement,
  );
  if (
    replacementWithReferences.length === deleteCount
    && replacementWithReferences.every(
      (block, index) => block === blocks[firstIndex + index],
    )
  ) {
    return blocks;
  }

  const next = [...blocks];
  next.splice(firstIndex, deleteCount, ...replacementWithReferences);
  return next;
}

/**
 * Reconciles one edited TextFlow range back into a layout section. Layout
 * sections always retain at least one paragraph child.
 */
export function replaceLayoutSectionChildren(
  blocks: LayoutSectionChildBlock[],
  previousIds: string[],
  nextBlocks: TextFlowBlock[],
  reservedIds: Set<string>,
): LayoutSectionChildBlock[] {
  const replacement = uniqueLayoutSectionBlocks(nextBlocks, reservedIds);
  if (blocks.length === 0) {
    return replacement.length > 0
      ? replacement
      : [createEmptyLayoutSectionParagraph()];
  }

  const previousIdSet = new Set(previousIds);
  const firstIndex = blocks.findIndex((block) => previousIdSet.has(block.id));
  if (firstIndex < 0) {
    return blocks;
  }

  const replacementIdSet = new Set([
    ...previousIds,
    ...replacement.map((block) => block.id),
  ]);
  let deleteCount = 0;
  while (
    blocks[firstIndex + deleteCount]
    && replacementIdSet.has(blocks[firstIndex + deleteCount].id)
  ) {
    deleteCount += 1;
  }

  const replacementWithReferences = reuseUnchangedBlockReferences(
    blocks.slice(firstIndex, firstIndex + deleteCount),
    replacement,
  );
  if (
    replacementWithReferences.length === deleteCount
    && replacementWithReferences.every(
      (block, index) => block === blocks[firstIndex + index],
    )
  ) {
    return blocks;
  }

  const next = [...blocks];
  next.splice(firstIndex, deleteCount, ...replacementWithReferences);
  return next.length > 0 ? next : [createEmptyLayoutSectionParagraph()];
}

function createEmptyLayoutSectionParagraph(): LayoutSectionChildBlock {
  return {
    type: "paragraph",
    id: createId("p"),
    children: [],
  };
}

function reuseUnchangedBlockReferences<T extends { id: string }>(
  previousBlocks: T[],
  replacement: T[],
): T[] {
  if (previousBlocks.length === 0 || replacement.length === 0) {
    return replacement;
  }

  const previousById = new Map(previousBlocks.map((block) => [block.id, block]));
  return replacement.map((block) => {
    const previous = previousById.get(block.id);
    return previous && sameSerializedValue(previous, block) ? previous : block;
  });
}

function sameSerializedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function textFlowBlockToProblemAreaBlock(
  block: TextFlowBlock,
): ProblemAreaBlock {
  if (block.type === "problem") {
    throw new Error("A problem must be wrapped in a box when inserted into another problem area.");
  }
  if (block.type === "section") {
    return {
      type: "heading",
      id: block.id,
      level: 1,
      children: block.title ? [{ type: "text", text: block.title }] : [],
      align: block.align,
      lineHeight: block.lineHeight,
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "heading") {
    return {
      type: "heading",
      id: block.id,
      level: block.level,
      children: block.children,
      align: block.align,
      lineHeight: block.lineHeight,
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "list") {
    return cloneListBlock(block);
  }

  if (block.type === "boxBlock") {
    return cloneLayoutSectionChild(block) as typeof block;
  }

  if (block.type === "layoutSection") {
    return {
      type: "layoutSection",
      id: block.id,
      layout: { ...block.layout },
      children: block.children.map(cloneLayoutSectionChild),
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "divider") {
    return { type: "divider", id: block.id, pagination: block.pagination, spaceAfterPx: block.spaceAfterPx };
  }

  if (block.type === "quote") {
    return {
      type: "quote",
      id: block.id,
      blocks: block.blocks,
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "codeBlock") {
    return {
      type: "codeBlock",
      id: block.id,
      language: block.language,
      theme: block.theme,
      children: block.children,
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  return {
    type: "paragraph",
    id: block.id,
    children: block.children,
    align: block.align,
    lineHeight: block.lineHeight,
    pagination: block.pagination,
    spaceAfterPx: block.spaceAfterPx,
  };
}
