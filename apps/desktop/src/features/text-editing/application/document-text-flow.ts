import type {
  BoxBlockChildBlock,
  LayoutSectionChildBlock,
  ListItemNode,
  ListNode,
  RichBlock,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";

import {
  getTextFlowBlockEditorLength,
  idPrefixForTextBlock,
  isTextFlowBlock,
  type TextFlowBlock,
  type TextFlowIdFactory,
} from "../model";
import { createTextFlowId } from "./text-flow-id";

export type StandaloneTextFlowBlock = Exclude<TextFlowBlock, { type: "layoutSection" }>;

export interface InsertTopLevelTextFlowBlocksOptions {
  now?: () => string;
}

export interface ReplaceTopLevelTextFlowBlocksOptions {
  createId?: TextFlowIdFactory;
}

export function insertTopLevelTextFlowBlocks(
  document: SigmaDocument,
  afterBlockId: string | null,
  // 段組セクションも本文トップレベルの正当なブロックなので、貼り付けで入る。
  blocks: TextFlowBlock[],
  options: InsertTopLevelTextFlowBlocksOptions = {},
): SigmaDocument {
  const content = [...document.content];
  const targetIndex = afterBlockId
    ? content.findIndex((item) => item.id === afterBlockId)
    : -1;
  content.splice(targetIndex >= 0 ? targetIndex + 1 : content.length, 0, ...blocks);

  return {
    ...document,
    content,
    updatedAt: (options.now ?? defaultTextFlowClock)(),
  };
}

export function isClipboardTextFlowBlock(
  block: SigmaBlock,
): block is StandaloneTextFlowBlock {
  return isTextFlowBlock(block);
}

export function replaceTopLevelTextFlowBlocks(
  content: SigmaBlock[],
  previousIds: string[],
  nextBlocks: TextFlowBlock[],
  options: ReplaceTopLevelTextFlowBlocksOptions = {},
): SigmaBlock[] {
  if (previousIds.length === 0) {
    return content;
  }

  const previousIdSet = new Set(previousIds);
  const firstIndex = content.findIndex((block) => previousIdSet.has(block.id));
  if (firstIndex < 0) {
    return content;
  }

  const replacementIdSet = new Set([
    ...previousIds,
    ...nextBlocks.map((block) => block.id),
  ]);
  let deleteCount = 0;

  while (content[firstIndex + deleteCount]) {
    const block = content[firstIndex + deleteCount];
    if (!isClipboardTextFlowBlock(block) || !replacementIdSet.has(block.id)) {
      break;
    }
    deleteCount += 1;
  }

  const reservedIds = new Set(
    content
      .filter((_, index) => index < firstIndex || index >= firstIndex + deleteCount)
      .map((block) => block.id),
  );
  const previousBlocks = content
    .slice(firstIndex, firstIndex + deleteCount)
    .filter(isClipboardTextFlowBlock);
  const replacement = reuseUnchangedTextFlowBlockReferences(
    previousBlocks,
    uniqueTextFlowBlocks(
      nextBlocks,
      reservedIds,
      options.createId ?? createTextFlowId,
    ),
  );
  if (
    replacement.length === deleteCount
    && replacement.every((block, index) => block === content[firstIndex + index])
  ) {
    return content;
  }

  const next = [...content];
  next.splice(firstIndex, deleteCount, ...replacement);
  return removeLeadingEmptyPageBreaks(next);
}

/** Inspect the complete sibling flow, never an individual editor chunk. */
export function removeLeadingEmptyPageBreaks(content: SigmaBlock[]): SigmaBlock[] {
  let hasBody = false;
  let changed = false;
  const next = content.map((block) => {
    let result = block;
    if (!hasBody && block.pagination?.break) {
      const pagination = { ...block.pagination };
      delete pagination.break;
      result = { ...block, pagination: Object.keys(pagination).length ? pagination : undefined };
      changed = true;
    }
    hasBody ||= block.type === "paragraph" || block.type === "heading"
      || block.type === "codeBlock" || block.type === "section"
      ? getTextFlowBlockEditorLength(block) > 0
      : true;
    return result;
  });
  return changed ? next : content;
}

function reuseUnchangedTextFlowBlockReferences(
  previousBlocks: StandaloneTextFlowBlock[],
  replacement: TextFlowBlock[],
): TextFlowBlock[] {
  if (previousBlocks.length === 0 || replacement.length === 0) {
    return replacement;
  }

  const previousById = new Map(previousBlocks.map((block) => [block.id, block]));
  return replacement.map((block) => {
    const previous = previousById.get(block.id);
    return previous && sameSerializedValue(previous, block) ? previous : block;
  });
}

function uniqueTextFlowBlocks(
  blocks: TextFlowBlock[],
  reservedIds: Set<string>,
  createId: TextFlowIdFactory,
): TextFlowBlock[] {
  const usedIds = new Set(reservedIds);

  return blocks.map((block) => uniqueTextFlowBlockIds(block, usedIds, createId));
}

function sameSerializedValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function uniqueTextFlowBlockIds(
  block: TextFlowBlock,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): TextFlowBlock {
  const id = claimUniqueId(block.id, idPrefixForTextBlock(block), usedIds, createId);
  if (block.type === "problem") {
    return {
      ...block, id,
      lead: block.lead.map(child => uniqueTextFlowBlockIds(child, usedIds, createId) as typeof child),
      prompt: block.prompt.map(child => uniqueTextFlowBlockIds(child, usedIds, createId) as typeof child),
      hints: block.hints.map(child => uniqueTextFlowBlockIds(child, usedIds, createId) as typeof child),
      solution: block.solution.map(child => uniqueTextFlowBlockIds(child, usedIds, createId) as typeof child),
    };
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      id,
      blocks: block.blocks.map((child) => uniqueBoxBlockChildIds(child, usedIds, createId)),
    };
  }

  if (block.type === "layoutSection") {
    return {
      ...block,
      id,
      children: block.children.map((child) => uniqueLayoutSectionChildIds(child, usedIds, createId)),
    };
  }

  if (block.type !== "list") {
    return id === block.id ? block : { ...block, id };
  }

  return {
    ...block,
    id,
    items: block.items.map((item) => uniqueListItemIds(item, usedIds, createId)),
  };
}

function uniqueRichBlockIds(
  block: RichBlock,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): RichBlock {
  if (block.type === "list") {
    return uniqueListNodeIds(block, usedIds, createId);
  }
  const id = claimUniqueId(
    block.id,
    block.type === "heading" ? "heading" : "p",
    usedIds,
    createId,
  );
  return id === block.id ? block : { ...block, id };
}

function uniqueBoxBlockChildIds(
  block: BoxBlockChildBlock,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): BoxBlockChildBlock {
  if (block.type === "layoutSection") {
    const id = claimUniqueId(block.id, "layout_section", usedIds, createId);
    return {
      ...block,
      id,
      children: block.children.map((child) => uniqueLayoutSectionChildIds(child, usedIds, createId)),
    };
  }
  return uniqueTextFlowBlockIds(block, usedIds, createId);
}

function uniqueLayoutSectionChildIds(
  block: LayoutSectionChildBlock,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): LayoutSectionChildBlock {
  if (block.type === "boxBlock") {
    const id = claimUniqueId(block.id, "box", usedIds, createId);
    return {
      ...block,
      id,
      blocks: block.blocks.map((child) => uniqueBoxBlockChildIds(child, usedIds, createId)),
    };
  }
  if (block.type === "section") {
    const id = claimUniqueId(block.id, "section", usedIds, createId);
    return id === block.id ? block : { ...block, id };
  }
  if (block.type === "divider") {
    const id = claimUniqueId(block.id, "divider", usedIds, createId);
    return id === block.id ? block : { ...block, id };
  }
  if (block.type === "codeBlock") {
    const id = claimUniqueId(block.id, "code", usedIds, createId);
    return id === block.id ? block : { ...block, id };
  }
  if (block.type === "quote") {
    return {
      ...block,
      id: claimUniqueId(block.id, "quote", usedIds, createId),
      blocks: block.blocks.map((child) => uniqueLayoutSectionChildIds(child, usedIds, createId) as typeof child),
    };
  }
  return uniqueRichBlockIds(block, usedIds, createId);
}

function uniqueListItemIds(
  item: ListItemNode,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): ListItemNode {
  return {
    ...item,
    id: claimUniqueId(item.id, "li", usedIds, createId),
    continuations: item.continuations?.map((continuation) => (
      continuation.type === "divider"
        ? { ...continuation, id: claimUniqueId(continuation.id, "divider", usedIds, createId) }
        : uniqueRichBlockIds(continuation, usedIds, createId) as typeof continuation
    )),
    nested: item.nested?.map((list) => uniqueListNodeIds(list, usedIds, createId)),
  };
}

function uniqueListNodeIds(
  list: ListNode,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): ListNode {
  return {
    ...list,
    id: claimUniqueId(list.id, "list", usedIds, createId),
    items: list.items.map((item) => uniqueListItemIds(item, usedIds, createId)),
  };
}

function claimUniqueId(
  id: string,
  prefix: string,
  usedIds: Set<string>,
  createId: TextFlowIdFactory,
): string {
  if (id && !usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }

  let nextId = "";
  do {
    nextId = createId(prefix);
  } while (usedIds.has(nextId));
  usedIds.add(nextId);
  return nextId;
}

function defaultTextFlowClock(): string {
  return new Date().toISOString();
}
