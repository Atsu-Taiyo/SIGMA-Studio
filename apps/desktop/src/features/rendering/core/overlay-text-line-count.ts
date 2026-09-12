import type {
  InlineNode,
  ListItemContinuationNode,
  OverlayTextBlock,
  QuoteChildBlock,
} from "@/features/document";

/**
 * Lines a shape's blocks occupy: one per block (one per list *item*) plus one per `\n`.
 *
 * A count of the breaks the content carries with it, before any width is applied — so it is a
 * floor, not a layout: `getTextShapeEffectiveSize` uses it to keep a box from being shorter than
 * its own line breaks while the measured height is missing or stale. Wrapping is the renderer's
 * business and the DOM measurement's answer; nothing here tries to predict it.
 *
 * The rule is the renderer's: split on `\n`. This module used to sit beside a second line model
 * built for the DOM-free estimator, which also broke on a lone `\r` — that estimator is gone, and
 * with it the risk of the two rules drifting apart and silently moving every figure's stored
 * height. `features/document`'s normalization splits the same way.
 */
export function getOverlayTextBlocksLineCount(blocks: readonly OverlayTextBlock[]): number {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) {
    return 1;
  }
  return Math.max(1, list.reduce((sum, block) => sum + getBlockLineCount(block), 0));
}

function getBlockLineCount(
  block: OverlayTextBlock | QuoteChildBlock | ListItemContinuationNode | undefined,
): number {
  if (!block) {
    return 0;
  }
  if (block.type === "divider") {
    return 1;
  }
  if (block.type === "quote") {
    return (block.blocks ?? []).reduce((sum, child) => sum + getBlockLineCount(child), 0);
  }
  if (block.type === "list") {
    return (block.items ?? []).reduce((sum, item) => (
      sum +
      getInlineLineCount(item?.children ?? []) +
      (item?.continuations ?? []).reduce((inner, child) => inner + getBlockLineCount(child), 0) +
      (item?.nested ?? []).reduce((inner, nested) => inner + getBlockLineCount(nested), 0)
    ), 0);
  }
  return getInlineLineCount(block.children ?? []);
}

function getInlineLineCount(content: readonly InlineNode[]): number {
  return 1 + content.reduce((sum, inline) => (
    inline?.type === "text" ? sum + Math.max(0, (inline.text ?? "").split("\n").length - 1) : sum
  ), 0);
}
