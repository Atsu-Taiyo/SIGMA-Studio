import { PROBLEM_AREA_ORDER } from "@/features/document";
import type { TextFlowBlock } from "../model";

export interface PreserveManualBreakOptions {
  /** 範囲文字編集では、複数の区切りを同じ後続ブロックへ畳めないため空の所有ブロックを残す。 */
  retainDeletedOwners?: boolean;
}

/**
 * 文字編集の前後で消えた break-before を、元の位置以降で生き残った最初のブロックへ移す。
 * 明示的な解除コマンドはこの関数を通らない。通常の PM 書き戻しと span 置換だけが使う。
 */
export function preserveManualBreaksAfterTextEdit(
  previousBlocks: readonly TextFlowBlock[],
  nextBlocks: readonly TextFlowBlock[],
  options: PreserveManualBreakOptions = {},
): TextFlowBlock[] {
  const previousById = new Map(previousBlocks.map((block) => [block.id, block]));
  const result = nextBlocks.map((block) => {
    const previous = previousById.get(block.id);
    return previous ? preserveNestedManualBreaks(previous, block, options) : block;
  });
  const previousIndex = new Map(previousBlocks.map((block, index) => [block.id, index]));

  if (options.retainDeletedOwners) {
    for (const [ownerIndex, owner] of previousBlocks.entries()) {
      if (result.some((block) => block.id === owner.id)) {
        continue;
      }
      const retained = retainedNestedManualBreakStructure(owner);
      if (!retained) {
        continue;
      }
      result.splice(findTransferTargetIndex(result, previousIndex, ownerIndex), 0, retained);
    }
  }

  for (const [ownerIndex, owner] of previousBlocks.entries()) {
    if (owner.pagination?.break !== true) {
      continue;
    }
    const survivingOwnerIndex = result.findIndex((block) => block.id === owner.id);
    if (survivingOwnerIndex >= 0) {
      result[survivingOwnerIndex] = withManualBreak(result[survivingOwnerIndex]);
      continue;
    }

    // The replacement may consist entirely of fresh ids. Anchor the transfer after the
    // last surviving predecessor, rather than searching only for an old successor: this
    // makes a newly inserted replacement the first owner at the original boundary.
    const targetIndex = findTransferTargetIndex(result, previousIndex, ownerIndex);
    if (targetIndex < result.length && result[targetIndex].pagination?.break !== true) {
      result[targetIndex] = withManualBreak(result[targetIndex]);
      continue;
    }
    if (options.retainDeletedOwners) {
      const retained = emptyManualBreakOwner(owner);
      result.splice(targetIndex >= 0 ? targetIndex : result.length, 0, retained);
    }
  }
  return result;
}

function findTransferTargetIndex(
  blocks: readonly TextFlowBlock[],
  previousIndex: ReadonlyMap<string, number>,
  ownerIndex: number,
): number {
  let targetIndex = 0;
  for (const [index, block] of blocks.entries()) {
    const indexBeforeEdit = previousIndex.get(block.id);
    if (indexBeforeEdit !== undefined && indexBeforeEdit < ownerIndex) {
      targetIndex = index + 1;
    }
  }
  return Math.min(targetIndex, blocks.length);
}

function preserveNestedManualBreaks(
  previous: TextFlowBlock,
  next: TextFlowBlock,
  options: PreserveManualBreakOptions,
): TextFlowBlock {
  if (previous.type === "problem" && next.type === "problem") {
    return { ...next, ...Object.fromEntries(PROBLEM_AREA_ORDER.map((area) => [area,
      preserveManualBreaksAfterTextEdit(previous[area], next[area], options),
    ])) };
  }
  if (previous.type === "quote" && next.type === "quote") return { ...next, blocks: preserveManualBreaksAfterTextEdit(previous.blocks, next.blocks, options) as typeof next.blocks };
  if (previous.type === "boxBlock" && next.type === "boxBlock") {
    return {
      ...next,
      blocks: preserveManualBreaksAfterTextEdit(previous.blocks, next.blocks, options),
    };
  }
  if (previous.type === "layoutSection" && next.type === "layoutSection") {
    return {
      ...next,
      children: preserveManualBreaksAfterTextEdit(
        previous.children,
        next.children,
        options,
      ) as typeof next.children,
    };
  }
  return next;
}

/** Preserve only the ancestor chain and empty owners required by nested breaks. */
function retainedNestedManualBreakStructure(block: TextFlowBlock): TextFlowBlock | null {
  if (block.type === "problem") {
    const areas = PROBLEM_AREA_ORDER.map((area) => [area, block[area].flatMap((child) => {
      const retained = retainedManualBreakStructure(child);
      return retained ? [retained] : [];
    })] as const);
    return areas.some(([, blocks]) => blocks.length > 0) ? { ...block, ...Object.fromEntries(areas) } : null;
  }
  if (block.type === "boxBlock") {
    const blocks = block.blocks.flatMap((child) => {
      const retained = retainedManualBreakStructure(child);
      return retained ? [retained] : [];
    });
    return blocks.length > 0 ? { ...block, title: [], blocks } : null;
  }
  if (block.type === "layoutSection") {
    const retainedIndexes = new Set<number>();
    block.children.forEach((child, index) => {
      if (child.pagination?.break === true || retainedNestedManualBreakStructure(child)) {
        retainedIndexes.add(index);
        if (index > 0) retainedIndexes.add(0);
      }
    });
    if (retainedIndexes.size === 0) {
      return null;
    }
    return {
      ...block,
      children: block.children.flatMap((child, index) => {
        if (!retainedIndexes.has(index)) return [];
        return [retainedManualBreakStructure(child) ?? emptyManualBreakOwner(child)];
      }) as typeof block.children,
    };
  }
  return null;
}

function retainedManualBreakStructure(block: TextFlowBlock): TextFlowBlock | null {
  const nested = retainedNestedManualBreakStructure(block);
  if (nested) {
    return block.pagination?.break === true ? withManualBreak(nested) : nested;
  }
  return block.pagination?.break === true ? emptyManualBreakOwner(block) : null;
}

function withManualBreak<T extends TextFlowBlock>(block: T): T {
  return block.pagination?.break === true
    ? block
    : { ...block, pagination: { ...(block.pagination ?? {}), break: true } };
}

function emptyManualBreakOwner(block: TextFlowBlock): TextFlowBlock {
  if (block.type === "problem") return { ...block, lead: [], prompt: [], hints: [], solution: [] };
  if (block.type === "section") return { ...block, title: "" };
  if (block.type === "paragraph" || block.type === "heading" || block.type === "codeBlock") {
    return { ...block, children: [] };
  }
  if (block.type === "list") {
    const first = block.items[0];
    return {
      ...block,
      items: first ? [{ ...first, children: [], continuations: undefined, nested: undefined }] : [],
    };
  }
  if (block.type === "quote") {
    const first = block.blocks[0];
    return { ...block, blocks: first ? [emptyManualBreakOwner(first) as typeof first] : [] };
  }
  if (block.type === "boxBlock") {
    const first = block.blocks[0];
    return {
      ...block,
      title: [],
      blocks: first ? [emptyManualBreakOwner(first) as typeof first] : [],
    };
  }
  if (block.type === "layoutSection") {
    const first = block.children[0];
    return { ...block, children: first ? [emptyManualBreakOwner(first) as typeof first] : [] };
  }
  return block;
}
