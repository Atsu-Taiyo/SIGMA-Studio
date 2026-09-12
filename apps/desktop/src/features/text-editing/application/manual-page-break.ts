import { PROBLEM_AREA_ORDER, type InlineNode, type SigmaBlock } from "@/features/document";

import {
  clampInteger,
  cloneInlineNode,
  createEmptyParagraphTextBlock,
  getInlineEditorLength,
  getTextFlowBlockChildren,
  getTextFlowBlockEditorLength,
  idPrefixForTextBlock,
  isNonEmptyInlineNode,
  withTextFlowBlockChildren,
  type ManualTextPageBreakResult,
  type ManualTextPageBreakSelection,
  type TextFlowBlock,
  type TextFlowIdFactory,
  type TextPageBreakRequestDetail,
} from "../model";
import { createTextFlowId } from "./text-flow-id";

export interface ResolveManualTextPageBreakOptions {
  createId?: TextFlowIdFactory;
}

/** Blank paragraphs at the start of a flow cannot create an empty page/column. */
export function canInsertManualPageBreakAfterBlock(blocks: readonly SigmaBlock[], blockId: string): boolean {
  const find = (siblings: readonly SigmaBlock[]): boolean | null => {
    let hasBody = false;
    for (const block of siblings) {
      if (block.pagination?.break) hasBody = false;
      const hasContent = block.type === "paragraph" || block.type === "heading"
        || block.type === "codeBlock" || block.type === "section"
        ? getTextFlowBlockEditorLength(block) > 0
        : true; // Figures, boxes and other structural blocks occupy body space.
      hasBody ||= hasContent;
      if (block.id === blockId) return hasBody;
      const groups = block.type === "problem"
        ? PROBLEM_AREA_ORDER.map(area => block[area])
        : block.type === "layoutSection" ? [block.children]
          : block.type === "boxBlock" || block.type === "quote" ? [block.blocks] : [];
      for (const group of groups) {
        const nested = find(group);
        if (nested !== null) return nested;
      }
    }
    return null;
  };
  return find(blocks) ?? false;
}

export function shouldUseDocumentNextBlockForPageBreak(
  blocks: TextFlowBlock[],
  detail: TextPageBreakRequestDetail,
  selection?: ManualTextPageBreakSelection | null,
): boolean {
  if (!detail.enabled || !detail.documentNextBlockId) {
    return false;
  }

  const blockIndex = blocks.findIndex((block) => block.id === detail.blockId);
  if (blockIndex < 0 || blockIndex < blocks.length - 1) {
    return false;
  }

  const block = blocks[blockIndex];
  const blockLength = getTextFlowBlockEditorLength(block);
  const offset = clampInteger(selection?.offset ?? blockLength, 0, blockLength);
  return offset <= 0 || offset >= blockLength;
}

export function resolveManualTextPageBreakBlocks(
  blocks: TextFlowBlock[],
  requestedBlockId: string,
  enabled: boolean,
  selection?: ManualTextPageBreakSelection | null,
  options: ResolveManualTextPageBreakOptions = {},
): ManualTextPageBreakResult | null {
  const createId = options.createId ?? createTextFlowId;

  if (!enabled) {
    const result = setTextFlowBlockBreakBeforeRecursively(blocks, requestedBlockId, false);
    return result.changed
      ? { blocks: result.blocks, focusBlockId: requestedBlockId, focusPosition: "start" }
      : null;
  }

  const selectedBlockId = selection?.blockId
    && blocks.some((block) => block.id === selection.blockId)
    ? selection.blockId
    : requestedBlockId;
  const blockIndex = blocks.findIndex((block) => block.id === selectedBlockId);
  if (blockIndex < 0) {
    for (const [index, parent] of blocks.entries()) {
      if (parent.type === "layoutSection" && (parent.layout.columnCount ?? 2) > 1) continue;
      const groups = parent.type === "problem" ? PROBLEM_AREA_ORDER.map((area) => ({ key: area, children: parent[area] }))
        : parent.type === "boxBlock" || parent.type === "quote" ? [{ key: "blocks", children: parent.blocks }]
          : parent.type === "layoutSection" ? [{ key: "children", children: parent.children }] : [];
      for (const { key, children } of groups) {
        const nested = resolveManualTextPageBreakBlocks(children, requestedBlockId, enabled, selection, options);
        if (nested) {
          const updated = { ...parent, [key]: nested.blocks } as TextFlowBlock;
          return {
            ...nested,
            blocks: blocks.map((block, position) => position === index ? updated : block),
          };
        }
      }
    }
    return null;
  }

  const block = blocks[blockIndex];
  const blockLength = getTextFlowBlockEditorLength(block);
  const offset = clampInteger(selection?.offset ?? blockLength, 0, blockLength);
  const nextBlock = blocks[blockIndex + 1];

  if (offset <= 0) {
    if (nextBlock) {
      const result = setTextFlowBlockBreakBefore(blocks, nextBlock.id, true);
      return {
        blocks: result.blocks,
        focusBlockId: nextBlock.id,
        focusPosition: "start",
      };
    }

    const appended = setTextFlowBlockBreakBeforeValue(
      createEmptyParagraphTextBlock(createId),
      true,
    );
    return {
      blocks: [...blocks, appended],
      focusBlockId: appended.id,
      focusPosition: "start",
    };
  }

  if (offset < blockLength) {
    const split = splitTextFlowBlockAtEditorOffset(block, offset, createId);
    const after = setTextFlowBlockBreakBeforeValue(split.after, true);
    return {
      blocks: [
        ...blocks.slice(0, blockIndex),
        split.before,
        after,
        ...blocks.slice(blockIndex + 1),
      ],
      focusBlockId: after.id,
      focusPosition: "start",
    };
  }

  if (nextBlock) {
    const result = setTextFlowBlockBreakBefore(blocks, nextBlock.id, true);
    return {
      blocks: result.blocks,
      focusBlockId: nextBlock.id,
      focusPosition: "start",
    };
  }

  const appended = setTextFlowBlockBreakBeforeValue(
    createEmptyParagraphTextBlock(createId),
    true,
  );
  return {
    blocks: [...blocks, appended],
    focusBlockId: appended.id,
    focusPosition: "start",
  };
}

function setTextFlowBlockBreakBeforeRecursively(
  blocks: TextFlowBlock[],
  blockId: string,
  enabled: boolean,
): { blocks: TextFlowBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (block.id === blockId) {
      const nextBlock = setTextFlowBlockBreakBeforeValue(block, enabled);
      changed = changed || nextBlock !== block;
      return nextBlock;
    }
    if (block.type === "problem") {
      let next = block;
      for (const area of PROBLEM_AREA_ORDER) {
        const nested = setTextFlowBlockBreakBeforeRecursively(block[area], blockId, enabled);
        if (nested.changed) {
          changed = true;
          next = { ...next, [area]: nested.blocks };
        }
      }
      return next;
    }
    if (block.type === "boxBlock" || block.type === "quote") {
      const nested = setTextFlowBlockBreakBeforeRecursively(block.blocks, blockId, enabled);
      if (nested.changed) {
        changed = true;
        return { ...block, blocks: nested.blocks } as typeof block;
      }
    } else if (block.type === "layoutSection") {
      const nested = setTextFlowBlockBreakBeforeRecursively(block.children, blockId, enabled);
      if (nested.changed) {
        changed = true;
        return { ...block, children: nested.blocks as typeof block.children };
      }
    }
    return block;
  });
  return { blocks: changed ? nextBlocks : blocks, changed };
}

function setTextFlowBlockBreakBefore(
  blocks: TextFlowBlock[],
  blockId: string,
  enabled: boolean,
): { blocks: TextFlowBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (block.id !== blockId) {
      return block;
    }
    const nextBlock = setTextFlowBlockBreakBeforeValue(block, enabled);
    changed = changed || nextBlock !== block;
    return nextBlock;
  });
  return { blocks: changed ? nextBlocks : blocks, changed };
}

function setTextFlowBlockBreakBeforeValue<T extends TextFlowBlock>(
  block: T,
  enabled: boolean,
): T {
  const pagination = { ...(block.pagination ?? {}) };
  if (enabled) {
    pagination.break = true;
  } else {
    delete pagination.break;
  }

  const nextPageBreak = Object.keys(pagination).length > 0 ? pagination : undefined;
  if (
    block.pagination?.break === nextPageBreak?.break
    && block.pagination === nextPageBreak
  ) {
    return block;
  }
  return {
    ...block,
    ...(nextPageBreak ? { pagination: nextPageBreak } : { pagination: undefined }),
  };
}

function splitTextFlowBlockAtEditorOffset(
  block: TextFlowBlock,
  offset: number,
  createId: TextFlowIdFactory,
): { before: TextFlowBlock; after: TextFlowBlock } {
  const children = getTextFlowBlockChildren(block);
  const split = splitInlineNodesAtEditorOffset(children, offset);
  const before = withTextFlowBlockChildren(block, split.before, createId);
  const after = withTextFlowBlockChildren(
    block.type === "section"
      ? createEmptyParagraphTextBlock(createId)
      : {
          ...block,
          id: createId(idPrefixForTextBlock(block)),
          pagination: undefined,
        },
    split.after,
    createId,
  );
  return { before, after };
}

function splitInlineNodesAtEditorOffset(
  children: InlineNode[],
  offset: number,
): { before: InlineNode[]; after: InlineNode[] } {
  const before: InlineNode[] = [];
  const after: InlineNode[] = [];
  let remaining = Math.max(0, offset);

  for (const child of children) {
    const length = getInlineEditorLength(child);
    if (remaining <= 0) {
      after.push(cloneInlineNode(child));
      continue;
    }

    if (remaining >= length) {
      before.push(cloneInlineNode(child));
      remaining -= length;
      continue;
    }

    if (child.type === "text") {
      before.push({
        ...child,
        marks: child.marks ? [...child.marks] : undefined,
        text: child.text.slice(0, remaining),
      });
      after.push({
        ...child,
        marks: child.marks ? [...child.marks] : undefined,
        text: child.text.slice(remaining),
      });
    } else {
      after.push(cloneInlineNode(child));
    }
    remaining = 0;
  }

  return {
    before: before.filter(isNonEmptyInlineNode),
    after: after.filter(isNonEmptyInlineNode),
  };
}
