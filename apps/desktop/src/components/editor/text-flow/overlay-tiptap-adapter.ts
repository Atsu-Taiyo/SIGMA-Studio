import { createId } from "@/lib/id";
import { getTextFlowBlockChildren, type TextFlowBlock } from "@/features/text-editing";
import type { OverlayTextBlock } from "@/features/document";
import type { TiptapDoc } from "@/lib/tiptap-adapter";

import { textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";

/**
 * A shape's blocks, projected into the editor's JSON — through the body's own converter.
 *
 * The shape used to have a converter of its own that only understood paragraphs and headings: it
 * flattened a list into paragraphs on the way out and threw on the way back, so typing in a shape
 * that held a list destroyed it. There is nothing shape-specific about this projection, so there
 * is no second implementation any more; what the shape does differently is its schema (no page
 * furniture: no box, column band, problem or section) and its DOM (no block ids), not how a block
 * becomes a node.
 */
export function overlayTextBlocksToTiptapDoc(blocks: readonly OverlayTextBlock[]): TiptapDoc {
  return textFlowToTiptap([...blocks]);
}

/**
 * The editor's JSON back into a shape's blocks.
 *
 * `previousBlocks` is what keeps block identity across an edit: the body's converter reads the ids
 * back off the nodes and uses the previous blocks to tell a genuine re-edit from the tail of a
 * split, so typing inside a block does not rename it.
 */
export function tiptapDocToOverlayTextBlocks(
  doc: TiptapDoc,
  previousBlocks: readonly OverlayTextBlock[] = [],
): OverlayTextBlock[] {
  return tiptapToTextFlow(doc, [...previousBlocks]).map(toOverlayTextBlock);
}

/**
 * Narrows a body block to the ones a shape can hold.
 *
 * What is left out is page furniture — a box that paginates, a column band, a numbered problem, a
 * section — and the shape's schema cannot produce any of it, so this is a safety net rather than a
 * path that runs. It keeps the text either way: a block that somehow arrived as one of those comes
 * back as a paragraph holding its own runs, because dropping it would delete what the author typed.
 */
function toOverlayTextBlock(block: TextFlowBlock): OverlayTextBlock {
  if (
    block.type === "paragraph" ||
    block.type === "heading" ||
    block.type === "list" ||
    block.type === "quote" ||
    block.type === "codeBlock" ||
    block.type === "divider"
  ) {
    return block;
  }
  return {
    type: "paragraph",
    id: block.id || createId("p"),
    children: getTextFlowBlockChildren(block),
  };
}
