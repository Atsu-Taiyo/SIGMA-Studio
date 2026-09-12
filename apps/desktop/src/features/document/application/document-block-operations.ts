import type {
  ListNode,
  ProblemAreaBlock,
  SigmaBlock,
  SigmaDocument,
} from "../model";

export type DocumentBlockIdPrefix =
  | "section"
  | "heading"
  | "p"
  | "list"
  | "problem"
  | "box";

export interface DocumentBlockClock {
  now(): string;
}

export interface DocumentBlockIdFactory {
  createId(prefix: DocumentBlockIdPrefix): string;
}

/** Top-level content ids present in `previous` but gone in `next`. */
export function diffDeletedContentIds(
  previous: SigmaDocument,
  next: SigmaDocument,
): string[] {
  const nextIds = new Set(next.content.map((block) => block.id));
  return previous.content
    .map((block) => block.id)
    .filter((id) => !nextIds.has(id));
}

export function insertTopLevelDocumentBlocks(
  document: SigmaDocument,
  afterBlockId: string | null,
  blocks: readonly SigmaBlock[],
  clock: DocumentBlockClock,
): SigmaDocument {
  const content = [...document.content];
  const targetIndex = getTopLevelInsertIndex(content, afterBlockId);
  content.splice(
    targetIndex >= 0 ? targetIndex + 1 : content.length,
    0,
    ...blocks,
  );

  return {
    ...document,
    content,
    updatedAt: clock.now(),
  };
}

export function insertTopLevelDocumentBlocksBefore(
  document: SigmaDocument,
  beforeBlockId: string | null,
  blocks: readonly SigmaBlock[],
  clock: DocumentBlockClock,
): SigmaDocument {
  const content = [...document.content];
  const targetIndex = getTopLevelInsertIndex(content, beforeBlockId);
  content.splice(
    targetIndex >= 0 ? targetIndex : content.length,
    0,
    ...blocks,
  );

  return {
    ...document,
    content,
    updatedAt: clock.now(),
  };
}

export function repairDuplicateTopLevelIds(
  document: SigmaDocument,
  idFactory: DocumentBlockIdFactory,
): SigmaDocument {
  const usedIds = new Set<string>();
  let changed = false;

  const content = document.content.map((block): SigmaBlock => {
    if (block.id && !usedIds.has(block.id)) {
      usedIds.add(block.id);
      return block;
    }

    let nextId = "";
    do {
      nextId = idFactory.createId(idPrefixForSigmaBlock(block));
    } while (usedIds.has(nextId));

    usedIds.add(nextId);
    changed = true;
    return { ...block, id: nextId };
  });

  return changed ? { ...document, content } : document;
}

function getTopLevelInsertIndex(
  content: readonly SigmaBlock[],
  blockId: string | null,
): number {
  if (!blockId) {
    return -1;
  }

  const directIndex = content.findIndex((item) => item.id === blockId);
  if (directIndex >= 0) {
    return directIndex;
  }

  return content.findIndex((item) => (
    item.type === "problem" &&
    (
      item.lead.some((block) => problemAreaBlockContainsId(block, blockId)) ||
      item.prompt.some((block) => problemAreaBlockContainsId(block, blockId)) ||
      item.hints.some((block) => problemAreaBlockContainsId(block, blockId)) ||
      item.solution.some((block) => problemAreaBlockContainsId(block, blockId))
    )
  ));
}

function problemAreaBlockContainsId(
  block: ProblemAreaBlock,
  blockId: string,
): boolean {
  return block.id === blockId ||
    (
      block.type === "layoutSection" &&
      block.children.some((child) => layoutSectionChildContainsId(child, blockId))
    ) ||
    (
      block.type === "boxBlock" &&
      block.blocks.some((child) => child.type === "layoutSection"
        ? child.children.some((nested) => layoutSectionChildContainsId(nested, blockId))
        : layoutSectionChildContainsId(child, blockId))
    ) ||
    (block.type === "list" && listContainsId(block, blockId));
}

function layoutSectionChildContainsId(
  block: SigmaBlock,
  blockId: string,
): boolean {
  if (block.type === "problem") return block.id === blockId || [...block.lead, ...block.prompt, ...block.hints, ...block.solution].some((child) => problemAreaBlockContainsId(child, blockId));
  return block.id === blockId ||
    (
      block.type === "boxBlock" &&
      block.blocks.some((child) => child.type === "layoutSection"
        ? child.children.some((nested) => (
            layoutSectionChildContainsId(nested, blockId)
          ))
        : layoutSectionChildContainsId(child, blockId))
    ) ||
    (block.type === "list" && listContainsId(block, blockId));
}

function listContainsId(list: ListNode, blockId: string): boolean {
  return list.items.some((item) => (
    item.id === blockId ||
    (item.nested ?? []).some((nested) => (
      nested.id === blockId || listContainsId(nested, blockId)
    ))
  ));
}

function idPrefixForSigmaBlock(block: SigmaBlock): DocumentBlockIdPrefix {
  if (block.type === "section") {
    return "section";
  }
  if (block.type === "heading") {
    return "heading";
  }
  if (block.type === "paragraph") {
    return "p";
  }
  if (block.type === "list") {
    return "list";
  }
  if (block.type === "boxBlock") {
    return "box";
  }
  return "problem";
}
