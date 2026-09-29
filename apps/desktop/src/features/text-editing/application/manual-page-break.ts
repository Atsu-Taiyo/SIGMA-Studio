import { PROBLEM_AREA_ORDER, type InlineNode, type SigmaBlock } from "@/features/document";

import {
  clampInteger,
  cloneInlineNode,
  createEmptyParagraphTextBlock,
  getInlineEditorLength,
  getTextFlowBlockChildren,
  getTextFlowBlockEditorLength,
  idPrefixForTextBlock,
  indexTextFlowBlocksById,
  isNonEmptyInlineNode,
  withTextFlowBlockChildren,
  type ManualTextPageBreakResult,
  type ManualTextPageBreakSelection,
  type TextFlowBlock,
  type TextFlowIdFactory,
  type TextPageBreakRequestDetail,
} from "../model";
import { isManualBreakAllowedAtBlock, resolveManualBreakHoistTarget } from "./manual-break-rules";
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

/**
 * このエディタの最後のブロックの末尾で区切るとき、区切りを持つのは**次のユニットの先頭**
 * (このエディタの外) なので、文書を持つホストに任せる。先頭で区切る場合はこのブロック自身の
 * 前に入るので任せない。
 */
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
  return offset > 0 && offset >= blockLength;
}

/**
 * キャレットの位置に手動改ページ (改段) を入れる。TeX の `\newpage` と同じく、キャレットより
 * 後ろの内容が次のページ (段) へ移り、キャレットもそこへ移る。
 *
 * - 文字の途中: ブロックを分け、後ろの半分の前で区切る
 * - 先頭 (空のブロックを含む): このブロックの前で区切る。引用・箱・1段組の先頭の子なら入れ物の前
 * - 末尾: 次のブロックの前で区切る。次が無ければ空の段落を足してその前で区切る
 */
export function resolveManualTextPageBreakBlocks(
  blocks: TextFlowBlock[],
  requestedBlockId: string,
  enabled: boolean,
  selection?: ManualTextPageBreakSelection | null,
  options: ResolveManualTextPageBreakOptions = {},
): ManualTextPageBreakResult | null {
  if (!enabled) {
    const result = setTextFlowBlockBreakBeforeRecursively(blocks, requestedBlockId, false);
    return result.changed
      ? { blocks: result.blocks, focusBlockId: requestedBlockId, focusPosition: "start" }
      : null;
  }

  const targetBlockId = selection?.blockId ?? requestedBlockId;
  const targetBlock = indexTextFlowBlocksById(blocks).get(targetBlockId);
  if (!targetBlock || !isManualBreakAllowedAtBlock(blocks, targetBlockId)) {
    return null;
  }
  const targetLength = getTextFlowBlockEditorLength(targetBlock);
  const targetOffset = clampInteger(selection?.offset ?? targetLength, 0, targetLength);
  if (targetOffset <= 0) {
    const ownerId = resolveManualBreakHoistTarget(blocks, targetBlockId);
    const result = setTextFlowBlockBreakBeforeRecursively(blocks, ownerId, true);
    return result.changed
      ? { blocks: result.blocks, focusBlockId: targetBlockId, focusPosition: "start" }
      : null;
  }

  return insertManualTextPageBreakAfterCaret(
    blocks,
    { blockId: targetBlockId, offset: targetOffset },
    options.createId ?? createTextFlowId,
  );
}

function insertManualTextPageBreakAfterCaret(
  blocks: TextFlowBlock[],
  selection: ManualTextPageBreakSelection,
  createId: TextFlowIdFactory,
): ManualTextPageBreakResult | null {
  const blockIndex = blocks.findIndex((block) => block.id === selection.blockId);
  if (blockIndex < 0) {
    for (const [index, parent] of blocks.entries()) {
      const groups = parent.type === "problem" ? PROBLEM_AREA_ORDER.map((area) => ({ key: area, children: parent[area] }))
        : parent.type === "boxBlock" || parent.type === "quote" ? [{ key: "blocks", children: parent.blocks }]
          : parent.type === "layoutSection" ? [{ key: "children", children: parent.children }] : [];
      for (const { key, children } of groups) {
        const nested = insertManualTextPageBreakAfterCaret(children, selection, createId);
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
  const offset = clampInteger(selection.offset, 0, blockLength);
  const nextBlock = blocks[blockIndex + 1];

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
