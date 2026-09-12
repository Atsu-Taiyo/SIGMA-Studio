import {
  PROBLEM_AREA_ORDER,
  inlineNodesToPlainText,
  listItemContinuationInlineNodes,
  type BoxBlockChildBlock,
  type InlineNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ListItemNode,
  type QuoteChildBlock,
  type SigmaBlock,
} from "@/features/document";

import type { TextFlowBlock, TextFlowIdFactory } from "./text-flow-types";

export function getTextFlowBlockChildren(block: TextFlowBlock): InlineNode[] {
  if (block.type === "problem") {
    return PROBLEM_AREA_ORDER.flatMap(area => block[area].flatMap(getTextFlowBlockChildren));
  }
  if (block.type === "section") {
    return block.title ? [{ type: "text", text: block.title }] : [];
  }
  if (block.type === "boxBlock") {
    return block.blocks.flatMap(getTextFlowBlockChildren);
  }
  if (block.type === "layoutSection") {
    return block.children.flatMap(getTextFlowBlockChildren);
  }
  if (block.type === "list") {
    return block.items.flatMap(listItemToInlineNodes);
  }
  if (block.type === "quote") {
    return block.blocks.flatMap(getTextFlowBlockChildren);
  }
  // 区切り線は文章を持たない。空配列を返すことで、検索・文字数・書式適用が
  // 「文章の無いブロック」として素通りする。
  if (block.type === "divider") {
    return [];
  }
  return block.children;
}

export function withTextFlowBlockChildren(
  block: TextFlowBlock,
  children: InlineNode[],
  createId: TextFlowIdFactory,
): TextFlowBlock {
  if (block.type === "problem") {
    const [first, ...rest] = block.prompt;
    return { ...block, prompt: first
      ? [withTextFlowBlockChildren(first, children, createId) as typeof first, ...rest]
      : [{ type: "paragraph", id: createId("p"), children }],
    };
  }
  if (block.type === "section") {
    return {
      ...block,
      title: inlineNodesToPlainText(children),
    };
  }
  if (block.type === "list") {
    const [firstItem, ...restItems] = block.items;
    return {
      ...block,
      items: firstItem
        ? [{ ...firstItem, children }, ...restItems]
        : [{ type: "listItem", id: createId("li"), children }],
    };
  }
  if (block.type === "boxBlock") {
    const [firstBlock, ...restBlocks] = block.blocks;
    return {
      ...block,
      blocks: firstBlock
        ? [
            withTextFlowBlockChildren(
              firstBlock,
              children,
              createId,
            ) as BoxBlockChildBlock,
            ...restBlocks,
          ]
        : [{ type: "paragraph", id: createId("p"), children }],
    };
  }
  if (block.type === "layoutSection") {
    const [firstBlock, ...restBlocks] = block.children;
    return {
      ...block,
      children: firstBlock
        ? [
            withTextFlowBlockChildren(
              firstBlock,
              children,
              createId,
            ) as LayoutSectionChildBlock,
            ...restBlocks,
          ]
        : [{ type: "paragraph", id: createId("p"), children }],
    };
  }
  if (block.type === "quote") {
    const [firstBlock, ...restBlocks] = block.blocks;
    return {
      ...block,
      blocks: firstBlock
        ? [
            withTextFlowBlockChildren(firstBlock, children, createId) as QuoteChildBlock,
            ...restBlocks,
          ]
        : [{ type: "paragraph", id: createId("p"), children }],
    };
  }
  // 区切り線には文章を書き戻せない。呼び出し側は「変わっていない」を identity で見るので、
  // 同じオブジェクトを返す。
  if (block.type === "divider") {
    return block;
  }
  return {
    ...block,
    children,
  };
}

export function createEmptyParagraphTextBlock(
  createId: TextFlowIdFactory,
): TextFlowBlock {
  return {
    type: "paragraph",
    id: createId("p"),
    children: [],
  };
}

export function getTextFlowBlockEditorLength(block: TextFlowBlock): number {
  return getInlineNodesEditorLength(getTextFlowBlockChildren(block));
}

export function getInlineEditorLength(child: InlineNode): number {
  return child.type === "text" ? child.text.length : 1;
}

export function getInlineNodesEditorLength(children: readonly InlineNode[]): number {
  return children.reduce((length, child) => length + getInlineEditorLength(child), 0);
}

/**
 * Chromium's font shaper (Fontations) dies on a single unbreakable run of
 * megabytes — Oilpan "Large allocation. Ran out of reservation". Pasting a
 * SigmaDoc JSON export (base64 images as paragraph text) is the observed case.
 *
 * 16,384 characters is far above any teaching-material paragraph and small
 * enough that `overflow-wrap: anywhere` can still layout it.
 */
export const MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS = 16_384;

export function isOversizedLeafTextFlowBlock(block: TextFlowBlock): boolean {
  return (block.type === "paragraph" || block.type === "heading" || block.type === "codeBlock" || block.type === "section")
    && getTextFlowBlockEditorLength(block) > MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS;
}

export function capInlineNodesForEditorLayout(
  children: readonly InlineNode[],
  placeholderText: string,
): { children: readonly InlineNode[]; originalLength: number; capped: boolean } {
  const originalLength = getInlineNodesEditorLength(children);
  if (originalLength <= MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS) {
    return { children, originalLength, capped: false };
  }
  return {
    children: [{ type: "text", text: placeholderText }],
    originalLength,
    capped: true,
  };
}

export function indexTextFlowBlocksById(
  blocks: readonly TextFlowBlock[],
  into: Map<string, TextFlowBlock> = new Map(),
): Map<string, TextFlowBlock> {
  for (const block of blocks) {
    into.set(block.id, block);
    if (block.type === "problem") {
      for (const area of PROBLEM_AREA_ORDER) indexTextFlowBlocksById(block[area], into);
    } else if (block.type === "quote") {
      indexTextFlowBlocksById(block.blocks, into);
    } else if (block.type === "boxBlock") {
      indexTextFlowBlocksById(block.blocks, into);
    } else if (block.type === "layoutSection") {
      indexTextFlowBlocksById(block.children, into);
    } else if (block.type === "list") {
      for (const item of block.items) {
        if (item.continuations) {
          indexTextFlowBlocksById(item.continuations, into);
        }
        if (item.nested) {
          indexTextFlowBlocksById(item.nested, into);
        }
      }
    }
  }
  return into;
}

export function cloneInlineNode(child: InlineNode): InlineNode {
  if (child.type === "text") {
    return {
      ...child,
      marks: child.marks ? [...child.marks] : undefined,
    };
  }
  return {
    ...child,
    marks: child.marks ? [...child.marks] : undefined,
  };
}

function listItemToInlineNodes(item: ListItemNode): InlineNode[] {
  const continuationText = (item.continuations ?? []).flatMap((continuation) => listItemContinuationInlineNodes(continuation));
  const nestedText = (item.nested ?? [])
    .flatMap((list) => list.items.flatMap(listItemToInlineNodes));
  return [...item.children, ...continuationText, ...nestedText];
}

export function isNonEmptyInlineNode(child: InlineNode): boolean {
  return child.type === "mathInline" || child.text.length > 0;
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function idPrefixForTextBlock(block: TextFlowBlock): string {
  if (block.type === "problem") return "problem";
  if (block.type === "section") {
    return "section";
  }
  if (block.type === "list") {
    return "list";
  }
  if (block.type === "boxBlock") {
    return "box";
  }
  if (block.type === "layoutSection") {
    return "layout_section";
  }
  if (block.type === "quote") {
    return "quote";
  }
  if (block.type === "codeBlock") {
    return "code";
  }
  if (block.type === "divider") {
    return "divider";
  }
  return block.type === "heading" ? "heading" : "p";
}

export function isTextFlowBlock(
  block: SigmaBlock,
): block is Exclude<TextFlowBlock, LayoutSectionNode | { type: "problem" }> {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "quote"
    || block.type === "codeBlock"
    || block.type === "divider"
    || block.type === "boxBlock";
}
