import { bodyTextFlowBlockContainsId, type TextFlowBlock } from "@/features/text-editing";

export type TextFlowInlineContentPart<T> =
  | {
      type: "blocks";
      key: string;
      blocks: TextFlowBlock[];
    }
  | {
      type: "content";
      key: string;
      items: readonly T[];
    };

/**
 * 先頭の編集範囲の key。中のブロックの id に依らない固定値にする: 差し込みが現れて範囲が
 * 分かれても、打鍵で先頭のブロックが入れ替わっても、同じ編集面 (取り消し履歴・選択・IME) を保つ。
 */
const LEADING_BLOCKS_KEY = "blocks-start";

/** 差し込みの後ろの編集範囲は、その差し込みの対象 (前の範囲の最後のブロック) で名前を付ける。 */
function blocksAfterKey(targetId: string): string {
  return `blocks-after-${targetId}`;
}

/**
 * フロー内の拡張ノードの id。差し込みの `key` から作り、本文のブロック id と同じ表 (変位・断片)
 * に並べても衝突しないように接頭辞を付ける。
 */
export function getFlowExtensionNodeId(key: string): string {
  return `extension:${key}`;
}

/**
 * この境界の最上位ブロックごとに、後ろに置く差し込み。入れ子の対象 (箱・引用・リストの中) は
 * それを含む最上位ブロックの後ろに置く (直接の対象の差し込みが先)。境界の外の対象は無視する。
 */
function resolveInlineContentByTopLevelId<T>(
  blocks: readonly TextFlowBlock[],
  contentByTargetId: ReadonlyMap<string, readonly T[]>,
): Map<string, readonly T[]> {
  const resolved = new Map<string, readonly T[]>();
  if (contentByTargetId.size === 0 || blocks.length === 0) {
    return resolved;
  }
  const topLevelIds = new Set(blocks.map((block) => block.id));
  for (const block of blocks) {
    const items = contentByTargetId.get(block.id);
    if (items?.length) {
      resolved.set(block.id, items);
    }
  }
  for (const [targetId, items] of contentByTargetId) {
    if (topLevelIds.has(targetId) || items.length === 0) {
      continue;
    }
    const owner = blocks.find((block) => bodyTextFlowBlockContainsId(block, targetId));
    if (owner) {
      resolved.set(owner.id, [...(resolved.get(owner.id) ?? []), ...items]);
    }
  }
  return resolved;
}

/**
 * Composes one TextFlow boundary into editor ranges and content anchored
 * immediately after a block. Targets outside the supplied boundary are ignored.
 */
export function splitTextFlowBlocksByInlineContent<T>(
  blocks: TextFlowBlock[],
  contentByTargetId: ReadonlyMap<string, readonly T[]>,
): TextFlowInlineContentPart<T>[] {
  const contentByBlockId = resolveInlineContentByTopLevelId(blocks, contentByTargetId);
  if (contentByBlockId.size === 0) {
    return [{ type: "blocks", key: LEADING_BLOCKS_KEY, blocks }];
  }

  const parts: TextFlowInlineContentPart<T>[] = [];
  let currentBlocks: TextFlowBlock[] = [];
  let currentKey = LEADING_BLOCKS_KEY;

  const flushBlocks = () => {
    if (currentBlocks.length === 0) {
      return;
    }

    parts.push({
      type: "blocks",
      key: currentKey,
      blocks: currentBlocks,
    });
    currentBlocks = [];
  };

  for (const block of blocks) {
    currentBlocks.push(block);
    const inlineContent = contentByBlockId.get(block.id);
    if (!inlineContent?.length) {
      continue;
    }

    flushBlocks();
    parts.push({
      type: "content",
      key: `extension-content-${block.id}`,
      items: inlineContent,
    });
    currentKey = blocksAfterKey(block.id);
  }

  flushBlocks();
  return parts;
}

/**
 * Problem-level content belongs after the final rendered problem area, rather
 * than inside any area's TextFlow boundary.
 */
export function getProblemAfterInlineContent<T>(
  problemId: string,
  isLastProblemArea: boolean,
  contentByTargetId: ReadonlyMap<string, readonly T[]>,
): readonly T[] {
  if (!isLastProblemArea) {
    return [];
  }

  return contentByTargetId.get(problemId) ?? [];
}
