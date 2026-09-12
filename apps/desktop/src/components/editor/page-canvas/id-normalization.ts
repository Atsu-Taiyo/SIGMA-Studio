import { createId } from "@/lib/id";
import type { TextFlowBlock } from "@/features/text-editing";
import type {
  BoxBlockChildBlock,
  LayoutSectionChildBlock,
  ListItemNode,
  ProblemAreaBlock,
  RichBlock,
} from "@/features/document";

/**
 * Normalizes the ids of blocks entering a layout section against ids that are
 * already owned elsewhere in the SigmaDoc document.
 */
export function uniqueLayoutSectionBlocks(
  blocks: TextFlowBlock[],
  reservedIds: Set<string>,
): LayoutSectionChildBlock[] {
  const usedIds = new Set(reservedIds);
  return blocks
    .filter(isLayoutSectionTextFlowBlock)
    .map((block) => uniqueLayoutSectionBlockIds(block, usedIds));
}

/**
 * Normalizes problem-area block ids, including ids nested inside layout
 * sections, box blocks, list items, and nested lists.
 */
export function uniqueProblemAreaBlocks(
  blocks: ProblemAreaBlock[],
  reservedIds: Set<string>,
): ProblemAreaBlock[] {
  const usedIds = new Set(reservedIds);

  return blocks.map((block) => uniqueProblemAreaBlockIds(block, usedIds));
}

function uniqueLayoutSectionBlockIds(
  block: LayoutSectionChildBlock,
  usedIds: Set<string>,
): LayoutSectionChildBlock {
  const id = claimUniqueId(block.id, idPrefixForTextFlowBlock(block), usedIds);
  if (block.type === "boxBlock") {
    return {
      ...block,
      id,
      blocks: uniqueBoxBlockChildren(block.blocks, usedIds),
    };
  }
  if (block.type === "list") {
    return {
      ...block,
      id,
      items: uniqueListItemIds(block.items, usedIds),
    };
  }

  return id === block.id ? block : { ...block, id };
}

function isLayoutSectionTextFlowBlock(
  block: TextFlowBlock,
): block is LayoutSectionChildBlock {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "boxBlock";
}

function uniqueProblemAreaBlockIds(
  block: ProblemAreaBlock,
  usedIds: Set<string>,
): ProblemAreaBlock {
  const id = claimUniqueId(block.id, idPrefixForRichBlock(block), usedIds);
  if (block.type === "layoutSection") {
    return {
      ...block,
      id,
      children: block.children.map((child) => uniqueLayoutSectionBlockIds(child, usedIds)),
    };
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      id,
      blocks: uniqueBoxBlockChildren(block.blocks, usedIds),
    };
  }
  if (block.type !== "list") {
    return id === block.id ? block : { ...block, id };
  }

  return {
    ...block,
    id,
    items: uniqueListItemIds(block.items, usedIds),
  };
}

function uniqueBoxBlockChildren(
  blocks: BoxBlockChildBlock[],
  usedIds: Set<string>,
): BoxBlockChildBlock[] {
  return blocks.map((block) => uniqueBoxBlockChildIds(block, usedIds));
}

function uniqueBoxBlockChildIds(
  block: BoxBlockChildBlock,
  usedIds: Set<string>,
): BoxBlockChildBlock {
  if (block.type === "problem") {
    return {
      ...block, id: claimUniqueId(block.id, "problem", usedIds),
      lead: block.lead.map((child) => uniqueProblemAreaBlockIds(child, usedIds)),
      prompt: block.prompt.map((child) => uniqueProblemAreaBlockIds(child, usedIds)),
      hints: block.hints.map((child) => uniqueProblemAreaBlockIds(child, usedIds)),
      solution: block.solution.map((child) => uniqueProblemAreaBlockIds(child, usedIds)),
    };
  }
  if (block.type === "layoutSection") {
    const id = claimUniqueId(block.id, "layout_section", usedIds);
    return {
      ...block,
      id,
      children: block.children.map((child) => uniqueLayoutSectionBlockIds(child, usedIds)),
    };
  }
  return uniqueLayoutSectionBlockIds(block, usedIds);
}

function uniqueListItemIds(
  items: ListItemNode[],
  usedIds: Set<string>,
): ListItemNode[] {
  return items.map((item) => ({
    ...item,
    id: claimUniqueId(item.id, "li", usedIds),
    continuations: item.continuations?.map((continuation) => uniqueProblemAreaBlockIds(continuation, usedIds) as typeof continuation),
    nested: item.nested?.map(
      (nested) => uniqueProblemAreaBlockIds(nested, usedIds) as Extract<RichBlock, { type: "list" }>,
    ),
  }));
}

function claimUniqueId(id: string, prefix: string, usedIds: Set<string>): string {
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

function idPrefixForRichBlock(block: ProblemAreaBlock): string {
  if (block.type === "heading") {
    return "heading";
  }
  if (block.type === "list") {
    return "list";
  }
  if (block.type === "layoutSection") {
    return "layout_section";
  }
  if (block.type === "boxBlock") {
    return "box";
  }
  return "p";
}

function idPrefixForTextFlowBlock(block: TextFlowBlock): string {
  if (block.type === "section") {
    return "section";
  }
  if (block.type === "boxBlock") {
    return "box";
  }
  if (block.type === "heading") {
    return "heading";
  }
  if (block.type === "list") {
    return "list";
  }
  return "p";
}
