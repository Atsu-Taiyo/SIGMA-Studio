import type { InlineNode } from "./model/rich-text";
import type { OverlayTextBlock } from "./overlay-model";

/**
 * Appends an inline node to the last block that can hold one, without weakening the schema.
 *
 * A list is entered through its last item, so appending to a shape whose content ends in a list
 * lands under that item's marker rather than silently starting a new paragraph beside it.
 */
export function appendOverlayTextInline(
  blocks: readonly OverlayTextBlock[],
  inline: InlineNode,
  createId: () => string,
): OverlayTextBlock[] {
  const lastIndex = blocks.length - 1;
  if (lastIndex < 0) {
    return [{ type: "paragraph", id: createId(), children: [inline] }];
  }

  const block = blocks[lastIndex];
  const next = blocks.slice(0, lastIndex);
  // A quote, a code block and a divider are not places a stray inline belongs: a formula appended
  // to a quote would join someone else's words, and a code block is one run of source. They get a
  // new paragraph after them instead, which is where the caret would be anyway.
  if (block.type === "quote" || block.type === "codeBlock" || block.type === "divider") {
    return [...blocks, { type: "paragraph", id: createId(), children: [inline] }];
  }
  if (block.type !== "list") {
    return [...next, { ...block, children: [...block.children, inline] }];
  }

  const itemIndex = block.items.length - 1;
  if (itemIndex < 0) {
    return [...next, block, { type: "paragraph", id: createId(), children: [inline] }];
  }
  const item = block.items[itemIndex];
  return [...next, {
    ...block,
    items: [
      ...block.items.slice(0, itemIndex),
      { ...item, children: [...item.children, inline] },
    ],
  }];
}
