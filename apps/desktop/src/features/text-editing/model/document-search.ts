import { listItemContinuationInlineNodes } from "@/features/document";
import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  InlineNode,
  LayoutSectionChildBlock,
  ListNode,
  ProblemAreaBlock,
  SigmaBlock,
} from "@/features/document";

export function findFirstBlockWithText(
  blocks: SigmaBlock[],
  query: string,
  selectedId: string | null,
  direction: "next" | "previous",
): { id: string } | null {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return null;
  }

  const flat = flattenSearchableBlocks(blocks);
  const selectedIndex = flat.findIndex((item) => item.id === selectedId);
  const startIndex =
    direction === "next"
      ? Math.max(0, selectedIndex + 1)
      : selectedIndex > 0
        ? selectedIndex - 1
        : flat.length - 1;
  const ordered =
    direction === "next"
      ? [...flat.slice(startIndex), ...flat.slice(0, startIndex)]
      : [...flat.slice(0, startIndex + 1).reverse(), ...flat.slice(startIndex + 1).reverse()];
  return ordered.find((item) => item.text.includes(normalizedQuery)) ?? null;
}

export function countTextMatches(blocks: SigmaBlock[], query: string): number {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return 0;
  }

  return flattenSearchableBlocks(blocks)
    .reduce((count, item) => count + item.text.split(normalizedQuery).length - 1, 0);
}

function flattenSearchableBlocks(blocks: SigmaBlock[]): Array<{ id: string; text: string }> {
  const result: Array<{ id: string; text: string }> = [];
  const addRichBlock = (block: ProblemAreaBlock) => {
    if (block.type === "layoutSection") {
      for (const child of block.children) {
        if (child.type === "section") {
          result.push({ id: child.id, text: child.title });
        } else if (child.type === "heading" || child.type === "paragraph") {
          result.push({ id: child.id, text: inlineNodesToSearchText(child.children) });
        } else if (child.type === "boxBlock") {
          addBoxBlock(child);
        } else if (child.type === "list") {
          addListBlock(child);
        }
      }
      return;
    }
    if (block.type === "list") {
      addListBlock(block);
      return;
    }
    if (block.type === "boxBlock") {
      addBoxBlock(block);
      return;
    }

    if (block.type === "paragraph" || block.type === "heading") {
      result.push({ id: block.id, text: inlineNodesToSearchText(block.children) });
    }
  };
  const addListBlock = (list: ListNode) => {
    for (const item of list.items) {
      result.push({ id: item.id, text: inlineNodesToSearchText(item.children) });
      for (const continuation of item.continuations ?? []) {
        result.push({ id: continuation.id, text: inlineNodesToSearchText(listItemContinuationInlineNodes(continuation)) });
      }
      item.nested?.forEach(addListBlock);
    }
  };
  const addBoxBlock = (box: BoxBlockNode) => {
    const titleText = inlineNodesToSearchText(box.title ?? []);
    if (titleText) {
      result.push({ id: box.id, text: titleText });
    }
    box.blocks.forEach(addBoxBlockChild);
  };
  const addLayoutSectionChild = (block: LayoutSectionChildBlock) => {
    if (block.type === "section") {
      result.push({ id: block.id, text: block.title });
    } else if (block.type === "boxBlock") {
      addBoxBlock(block);
    } else if (block.type !== "divider") {
      // 区切り線は検索対象になる文字を持たない。
      addRichBlock(block);
    }
  };
  const addBoxBlockChild = (block: BoxBlockChildBlock) => {
    if (block.type === "problem") {
      [...block.lead, ...block.prompt, ...block.hints, ...block.solution].forEach(addRichBlock);
      return;
    }
    if (block.type === "layoutSection") {
      block.children.forEach(addLayoutSectionChild);
      return;
    }
    addLayoutSectionChild(block);
  };

  for (const block of blocks) {
    if (block.type === "section") {
      result.push({ id: block.id, text: block.title });
    } else if (block.type === "heading" || block.type === "paragraph") {
      result.push({ id: block.id, text: inlineNodesToSearchText(block.children) });
    } else if (block.type === "list") {
      addListBlock(block);
    } else if (block.type === "layoutSection") {
      for (const child of block.children) {
        if (child.type === "section") {
          result.push({ id: child.id, text: child.title });
        } else if (child.type === "heading" || child.type === "paragraph") {
          result.push({ id: child.id, text: inlineNodesToSearchText(child.children) });
        } else if (child.type === "boxBlock") {
          addBoxBlock(child);
        } else if (child.type === "list") {
          addListBlock(child);
        }
      }
    } else if (block.type === "problem") {
      block.lead.forEach(addRichBlock);
      block.prompt.forEach(addRichBlock);
      block.solution.forEach(addRichBlock);
      block.hints.forEach(addRichBlock);
    } else if (block.type === "boxBlock") {
      addBoxBlock(block);
    }
  }

  return result;
}

function inlineNodesToSearchText(children: InlineNode[]): string {
  return children
    .map((child) => {
      if (child.type === "text") {
        return child.text;
      }
      return child.tex;
    })
    .join("");
}
