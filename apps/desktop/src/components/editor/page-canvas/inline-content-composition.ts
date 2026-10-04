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

interface ProblemAfterContentUnit {
  type: string;
  id: string;
  problem?: { id: string };
  isLastProblemArea?: boolean;
}

/**
 * 問題そのものを対象にした差し込みを描くユニット (問題ごとに 1 つ): 最後のエリアの最後の本文
 * ユニット。最後のエリアが「本文 → 部分段組み → 本文」と分かれても 1 か所だけに描く — 同じ拡張
 * ノードが 2 つあると、計測と配置が同じ id で上書きし合い、片方が他方の位置に描かれる。最後の
 * エリアに本文のユニットが無ければ、その問題の最後の本文ユニット。
 */
export function getProblemAfterContentUnitIds(units: readonly ProblemAfterContentUnit[]): ReadonlySet<string> {
  const lastAreaUnitByProblem = new Map<string, string>();
  const lastUnitByProblem = new Map<string, string>();
  for (const unit of units) {
    if (unit.type !== "problemArea" || !unit.problem) continue;
    lastUnitByProblem.set(unit.problem.id, unit.id);
    if (unit.isLastProblemArea) lastAreaUnitByProblem.set(unit.problem.id, unit.id);
  }
  return new Set([...lastUnitByProblem].map(([problemId, unitId]) => lastAreaUnitByProblem.get(problemId) ?? unitId));
}

/**
 * Problem-level content belongs after the problem's final body unit
 * (`getProblemAfterContentUnitIds`), rather than inside any area's TextFlow boundary.
 */
export function getProblemAfterInlineContent<T>(
  problemId: string,
  hostsProblemAfterContent: boolean,
  contentByTargetId: ReadonlyMap<string, readonly T[]>,
): readonly T[] {
  if (!hostsProblemAfterContent) {
    return [];
  }

  return contentByTargetId.get(problemId) ?? [];
}
