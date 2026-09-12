import type { InlineNode } from "./model";
import type { ListItemContinuationNode, QuoteChildBlock } from "./model/blocks";
import type { OverlayTextBlock } from "./overlay-model";

/** Anything that can appear inside a shape's content, at any depth. */
type OverlayTextBlockLike = OverlayTextBlock | QuoteChildBlock | ListItemContinuationNode;

/**
 * Projects a shape's first prose block into canonical SigmaDoc inline nodes.
 *
 * A shape whose content starts with a list projects its first item — callers that ask for "the
 * inline content of this shape" (comment anchors, AI reference chips) want the first line the
 * reader sees, and returning nothing there would silently drop the anchor instead. A quote is the
 * same question one level down; a divider genuinely has no line and projects nothing.
 *
 * Strictly the *first* block, even when it is empty. Searching on for the first block that has
 * runs would re-point every existing anchor on a shape that starts with a blank line, and an
 * anchor that moves is worse than one that quotes nothing.
 */
export function overlayTextBlocksToInlineNodes(
  blocks: readonly OverlayTextBlock[],
): InlineNode[] {
  return firstLineOf(blocks[0]);
}

function firstLineOf(block: OverlayTextBlockLike | undefined): InlineNode[] {
  if (!block || block.type === "divider") {
    return [];
  }
  if (block.type === "list") {
    return block.items[0]?.children ?? [];
  }
  if (block.type === "quote") {
    for (const child of block.blocks) {
      const first = firstLineOf(child);
      if (first.length > 0) {
        return first;
      }
    }
    return [];
  }
  return block.children;
}

/**
 * Every run of prose one of a shape's blocks holds, in reading order.
 *
 * The three block types a shape gained answer "where is the text" differently: a quote holds
 * blocks rather than runs, a code block holds one run of its own, and a divider holds none at all.
 * Readers that used to reach straight for `block.children` need all three answers, and taking them
 * from one place is what stops the next block type from being seen by half the readers and missed
 * by the other half — which is how text becomes unsearchable, or a comment anchors to the wrong
 * thing, without anything ever throwing.
 */
export function overlayTextBlockInlineRuns(block: OverlayTextBlockLike | undefined): InlineNode[] {
  if (!block || block.type === "divider") {
    return [];
  }
  if (block.type === "list") {
    return block.items.flatMap((item) => [
      ...(item?.children ?? []),
      ...(item?.continuations ?? []).flatMap(overlayTextBlockInlineRuns),
      ...(item?.nested ?? []).flatMap(overlayTextBlockInlineRuns),
    ]);
  }
  if (block.type === "quote") {
    return block.blocks.flatMap(overlayTextBlockInlineRuns);
  }
  return block.children ?? [];
}

/** Compatibility helper for callers that already hold one semantic inline array. */
export function overlayRichTextInlinesToInlineNodes(
  nodes: readonly InlineNode[],
): InlineNode[] {
  return [...nodes];
}
