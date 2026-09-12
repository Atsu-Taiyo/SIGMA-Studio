import { listItemContinuationInlineNodes } from "@/features/document";
import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  CodeBlockNode,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  ListNode,
  ProblemAreaBlock,
  QuoteBlockNode,
  RichBlock,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";

export interface DocumentTextMutationOptions {
  now?: () => string;
}

export function updateInlineMathTexInDocument(
  document: SigmaDocument,
  mathInlineId: string,
  tex: string,
  options: DocumentTextMutationOptions = {},
): SigmaDocument {
  let updated = false;
  const updateInlineNodes = (children: InlineNode[]): InlineNode[] => {
    let childrenUpdated = false;
    const nextChildren = children.map((child) => {
      if (child.type !== "mathInline" || child.id !== mathInlineId) {
        return child;
      }

      if (child.tex === tex) {
        return child;
      }

      childrenUpdated = true;
      updated = true;
      return { ...child, tex };
    });

    return childrenUpdated ? nextChildren : children;
  };
  const updateRichBlock = (block: RichBlock): RichBlock => {
    if (block.type === "list") {
      const items = updateListItems(block.items);
      return items === block.items ? block : { ...block, items };
    }

    const children = updateInlineNodes(block.children);
    return children === block.children ? block : { ...block, children };
  };
  const updateCodeBlock = (block: CodeBlockNode): CodeBlockNode => {
    const children = updateInlineNodes(block.children);
    return children === block.children ? block : { ...block, children };
  };
  const updateQuoteBlock = (block: QuoteBlockNode): QuoteBlockNode => {
    let blocksUpdated = false;
    const nextBlocks = block.blocks.map((child) => {
      const nextChild = child.type === "divider"
        ? child
        : child.type === "codeBlock"
          ? updateCodeBlock(child)
          : updateRichBlock(child);
      if (nextChild !== child) {
        blocksUpdated = true;
      }
      return nextChild as typeof child;
    });
    return blocksUpdated ? { ...block, blocks: nextBlocks } : block;
  };
  const updateListItems = (items: ListItemNode[]): ListItemNode[] => {
    let itemsUpdated = false;
    const nextItems = items.map((item) => {
      const children = updateInlineNodes(item.children);
      const nextContinuations = item.continuations?.map((continuation) => {
        const continuationChildren = updateInlineNodes(listItemContinuationInlineNodes(continuation));
        return continuationChildren === listItemContinuationInlineNodes(continuation)
          ? continuation
          : { ...continuation, children: continuationChildren };
      });
      const continuations = nextContinuations?.some((continuation, index) => continuation !== item.continuations?.[index])
        ? nextContinuations
        : item.continuations;
      const nested = item.nested ? updateListBlocks(item.nested) : undefined;
      if (children === item.children && continuations === item.continuations && nested === item.nested) {
        return item;
      }
      itemsUpdated = true;
      return { ...item, children, continuations, nested };
    });
    return itemsUpdated ? nextItems : items;
  };
  const updateListBlocks = (lists: ListNode[]): ListNode[] => {
    let listsUpdated = false;
    const nextLists = lists.map((list) => {
      const items = updateListItems(list.items);
      if (items === list.items) {
        return list;
      }
      listsUpdated = true;
      return { ...list, items };
    });
    return listsUpdated ? nextLists : lists;
  };
  const updateRichBlocks = <T extends ProblemAreaBlock>(blocks: T[]): T[] => {
    let blocksUpdated = false;
    const nextBlocks = blocks.map((block) => {
      const nextBlock = block.type === "layoutSection"
        ? (() => {
            const children = updateLayoutSectionChildren(block.children);
            return children === block.children ? block : { ...block, children };
          })() as T
        : block.type === "boxBlock"
          ? updateBoxBlock(block) as T
        : block.type === "divider"
          ? block
        : block.type === "quote"
          ? updateQuoteBlock(block) as T
        : block.type === "codeBlock"
          ? updateCodeBlock(block) as T
        : updateRichBlock(block) as T;
      if (nextBlock !== block) {
        blocksUpdated = true;
      }
      return nextBlock;
    });
    return blocksUpdated ? nextBlocks : blocks;
  };
  const updateLayoutSectionChild = (
    block: LayoutSectionChildBlock,
  ): LayoutSectionChildBlock => {
    if (block.type === "section" || block.type === "divider") {
      return block;
    }
    if (block.type === "boxBlock") {
      return updateBoxBlock(block);
    }
    if (block.type === "quote") {
      return updateQuoteBlock(block);
    }
    if (block.type === "codeBlock") {
      return updateCodeBlock(block);
    }
    return updateRichBlock(block);
  };
  const updateLayoutSectionChildren = (
    blocks: LayoutSectionChildBlock[],
  ): LayoutSectionChildBlock[] => {
    let blocksUpdated = false;
    const nextBlocks = blocks.map((block) => {
      const nextBlock = updateLayoutSectionChild(block);
      if (nextBlock !== block) {
        blocksUpdated = true;
      }
      return nextBlock;
    });
    return blocksUpdated ? nextBlocks : blocks;
  };
  const updateBoxBlockChild = (block: BoxBlockChildBlock): BoxBlockChildBlock => {
    if (block.type === "problem") return { ...block,
      lead: updateRichBlocks(block.lead),
      prompt: updateRichBlocks(block.prompt),
      hints: updateRichBlocks(block.hints),
      solution: updateRichBlocks(block.solution),
    };
    if (block.type === "layoutSection") {
      const children = updateLayoutSectionChildren(block.children);
      return children === block.children ? block : { ...block, children };
    }
    return updateLayoutSectionChild(block);
  };
  const updateBoxBlockChildren = (
    blocks: BoxBlockChildBlock[],
  ): BoxBlockChildBlock[] => {
    let blocksUpdated = false;
    const nextBlocks = blocks.map((block) => {
      const nextBlock = updateBoxBlockChild(block);
      if (nextBlock !== block) {
        blocksUpdated = true;
      }
      return nextBlock;
    });
    return blocksUpdated ? nextBlocks : blocks;
  };
  const updateBoxBlock = (block: BoxBlockNode): BoxBlockNode => {
    const title = block.title ? updateInlineNodes(block.title) : block.title;
    const blocks = updateBoxBlockChildren(block.blocks);
    return title === block.title && blocks === block.blocks ? block : { ...block, title, blocks };
  };

  const content = document.content.map((block): SigmaBlock => {
    if (block.type === "paragraph" || block.type === "heading" || block.type === "list") {
      return updateRichBlock(block) as SigmaBlock;
    }

    if (block.type === "problem") {
      const lead = updateRichBlocks(block.lead);
      const prompt = updateRichBlocks(block.prompt);
      const solution = updateRichBlocks(block.solution);
      const hints = updateRichBlocks(block.hints);
      return lead === block.lead
        && prompt === block.prompt
        && solution === block.solution
        && hints === block.hints
        ? block
        : { ...block, lead, prompt, solution, hints };
    }

    if (block.type === "boxBlock") {
      return updateBoxBlock(block);
    }

    if (block.type === "layoutSection") {
      let changed = false;
      const nextChildren = block.children.map((child) => {
        if (child.type === "section" || child.type === "divider") {
          return child;
        }
        const nextChild = child.type === "boxBlock"
          ? updateBoxBlock(child)
          : child.type === "quote"
            ? updateQuoteBlock(child)
          : child.type === "codeBlock"
            ? updateCodeBlock(child)
            : updateRichBlock(child);
        if (nextChild !== child) {
          changed = true;
        }
        return nextChild;
      });
      return changed ? { ...block, children: nextChildren } : block;
    }

    return block;
  });

  return updated
    ? {
        ...document,
        content,
        updatedAt: (options.now ?? defaultDocumentTextClock)(),
      }
    : document;
}

export function replaceInDocument(
  document: SigmaDocument,
  query: string,
  replacement: string,
  replaceAll: boolean,
  options: DocumentTextMutationOptions = {},
): SigmaDocument {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return document;
  }

  let replaced = false;
  const shouldReplace = () => replaceAll || !replaced;

  const replaceInlineNodes = (children: InlineNode[]): InlineNode[] =>
    children.map((child) => {
      if (child.type !== "text" || !shouldReplace() || !child.text.includes(normalizedQuery)) {
        return child;
      }

      replaced = true;
      return {
        ...child,
        text: replaceAll
          ? child.text.split(normalizedQuery).join(replacement)
          : child.text.replace(normalizedQuery, replacement),
      };
    });

  const replaceRichBlock = <T extends ProblemAreaBlock>(block: T): T => {
    if (block.type === "layoutSection") {
      return {
        ...block,
        children: block.children.map(replaceLayoutSectionChild),
      } as T;
    }
    if (block.type === "list" && shouldReplace()) {
      return {
        ...block,
        items: block.items.map(replaceListItem),
      } as T;
    }

    if ((block.type === "paragraph" || block.type === "heading") && shouldReplace()) {
      return { ...block, children: replaceInlineNodes(block.children) } as T;
    }

    return block;
  };
  const replaceListItem = (item: ListItemNode): ListItemNode => {
    if (!shouldReplace()) {
      return item;
    }

    return {
      ...item,
      children: replaceInlineNodes(item.children),
      continuations: item.continuations?.map((continuation) => ({
        ...continuation,
        children: replaceInlineNodes(listItemContinuationInlineNodes(continuation)),
      })),
      nested: shouldReplace() ? item.nested?.map(replaceListBlock) : item.nested,
    };
  };
  const replaceListBlock = (list: ListNode): ListNode => ({
    ...list,
    items: list.items.map(replaceListItem),
  });
  const replaceLayoutSectionChild = (
    block: LayoutSectionChildBlock,
  ): LayoutSectionChildBlock => {
    if (block.type === "section") {
      if (!shouldReplace() || !block.title.includes(normalizedQuery)) {
        return block;
      }
      replaced = true;
      return {
        ...block,
        title: replaceAll
          ? block.title.split(normalizedQuery).join(replacement)
          : block.title.replace(normalizedQuery, replacement),
      };
    }
    if (block.type === "divider") {
      return block;
    }
    if (block.type === "boxBlock") {
      return replaceBoxBlock(block);
    }
    return replaceRichBlock(block);
  };
  const replaceBoxBlockChild = (block: BoxBlockChildBlock): BoxBlockChildBlock => {
    if (block.type === "problem") return { ...block,
      lead: block.lead.map(replaceRichBlock),
      prompt: block.prompt.map(replaceRichBlock),
      hints: block.hints.map(replaceRichBlock),
      solution: block.solution.map(replaceRichBlock),
    };
    if (block.type === "layoutSection") {
      return {
        ...block,
        children: block.children.map(replaceLayoutSectionChild),
      };
    }
    return replaceLayoutSectionChild(block);
  };
  const replaceBoxBlock = (box: BoxBlockNode): BoxBlockNode => ({
    ...box,
    title: shouldReplace() && box.title ? replaceInlineNodes(box.title) : box.title,
    blocks: shouldReplace() ? box.blocks.map(replaceBoxBlockChild) : box.blocks,
  });

  const content = document.content.map((block): SigmaBlock => {
    if (block.type === "section" && shouldReplace() && block.title.includes(normalizedQuery)) {
      replaced = true;
      return {
        ...block,
        title: replaceAll
          ? block.title.split(normalizedQuery).join(replacement)
          : block.title.replace(normalizedQuery, replacement),
      };
    }

    if ((block.type === "heading" || block.type === "paragraph") && shouldReplace()) {
      return { ...block, children: replaceInlineNodes(block.children) };
    }

    if (block.type === "list" && shouldReplace()) {
      return replaceListBlock(block);
    }

    if (block.type === "problem" && shouldReplace()) {
      return {
        ...block,
        lead: block.lead.map(replaceRichBlock),
        prompt: block.prompt.map(replaceRichBlock),
        solution: block.solution.map(replaceRichBlock),
        hints: block.hints.map(replaceRichBlock),
      };
    }

    if (block.type === "boxBlock" && shouldReplace()) {
      return replaceBoxBlock(block);
    }

    if (block.type === "layoutSection" && shouldReplace()) {
      return {
        ...block,
        children: block.children.map((child) => {
          if (child.type === "section" && shouldReplace() && child.title.includes(normalizedQuery)) {
            replaced = true;
            return {
              ...child,
              title: replaceAll
                ? child.title.split(normalizedQuery).join(replacement)
                : child.title.replace(normalizedQuery, replacement),
            };
          }
          if (child.type === "section" || child.type === "divider") {
            return child;
          }
          return child.type === "boxBlock" ? replaceBoxBlock(child) : replaceRichBlock(child);
        }),
      };
    }

    return block;
  });

  return replaced
    ? {
        ...document,
        content,
        updatedAt: (options.now ?? defaultDocumentTextClock)(),
      }
    : document;
}

function defaultDocumentTextClock(): string {
  return new Date().toISOString();
}
