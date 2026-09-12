import type { TextFlowBlock } from "@/features/text-editing";

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
 * Composes one TextFlow boundary into editor ranges and content anchored
 * immediately after a block. Targets outside the supplied boundary are ignored.
 */
export function splitTextFlowBlocksByInlineContent<T>(
  blocks: TextFlowBlock[],
  contentByTargetId: ReadonlyMap<string, readonly T[]>,
): TextFlowInlineContentPart<T>[] {
  const parts: TextFlowInlineContentPart<T>[] = [];
  let currentBlocks: TextFlowBlock[] = [];

  const flushBlocks = () => {
    if (currentBlocks.length === 0) {
      return;
    }

    parts.push({
      type: "blocks",
      key: `blocks-${currentBlocks[0].id}-${currentBlocks[currentBlocks.length - 1].id}`,
      blocks: currentBlocks,
    });
    currentBlocks = [];
  };

  for (const block of blocks) {
    currentBlocks.push(block);
    const inlineContent = contentByTargetId.get(block.id);
    if (!inlineContent?.length) {
      continue;
    }

    flushBlocks();
    parts.push({
      type: "content",
      key: `extension-content-${block.id}`,
      items: inlineContent,
    });
  }

  flushBlocks();
  return parts.length > 0
    ? parts
    : [{ type: "blocks", key: "blocks-empty", blocks }];
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
