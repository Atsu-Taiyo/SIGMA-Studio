import type { SigmaTextRangeCommentAnchor } from "@/features/document";

/**
 * Public host-to-editor event for projecting externally owned text ranges.
 * The value stays stable for desktop hosts that already dispatch it.
 */
export const EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT = "sigma-studio:ai-reference-text-range";

export function getTextRangeForBlock(
  anchor: SigmaTextRangeCommentAnchor,
  blockId: string,
  order: ReadonlyMap<string, number>,
  blockLength: number,
): { from: number; to: number } | null {
  const range = getOrderedTextRange(anchor, order);
  const blockIndex = order.get(blockId);
  if (!range || blockIndex === undefined || blockIndex < range.startIndex || blockIndex > range.endIndex) {
    return null;
  }

  if (range.startIndex === range.endIndex) {
    const from = Math.max(0, Math.min(blockLength, Math.min(range.startOffset, range.endOffset)));
    const to = Math.max(0, Math.min(blockLength, Math.max(range.startOffset, range.endOffset)));
    return to > from ? { from, to } : null;
  }
  if (blockIndex === range.startIndex) {
    const from = Math.max(0, Math.min(blockLength, range.startOffset));
    return from < blockLength ? { from, to: blockLength } : null;
  }
  if (blockIndex === range.endIndex) {
    const to = Math.max(0, Math.min(blockLength, range.endOffset));
    return to > 0 ? { from: 0, to } : null;
  }
  return blockLength > 0 ? { from: 0, to: blockLength } : null;
}

function getOrderedTextRange(
  anchor: SigmaTextRangeCommentAnchor,
  order: ReadonlyMap<string, number>,
): {
  endIndex: number;
  endOffset: number;
  startIndex: number;
  startOffset: number;
} | null {
  const startIndex = order.get(anchor.start.blockId);
  const endIndex = order.get(anchor.end.blockId);
  if (startIndex === undefined || endIndex === undefined) {
    return null;
  }
  if (startIndex < endIndex || (startIndex === endIndex && anchor.start.offset <= anchor.end.offset)) {
    return {
      endIndex,
      endOffset: anchor.end.offset,
      startIndex,
      startOffset: anchor.start.offset,
    };
  }
  return {
    endIndex: startIndex,
    endOffset: anchor.start.offset,
    startIndex: endIndex,
    startOffset: anchor.end.offset,
  };
}
