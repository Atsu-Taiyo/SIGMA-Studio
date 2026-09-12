import { listItemContinuationInlineNodes } from "@/features/document";
import type {
  SigmaBlock,
  SigmaCommentAnchor,
  SigmaCommentThread,
  SigmaDocument,
  InlineNode,
  LayoutSectionChildBlock,
  ProblemNode,
  RichBlock,
} from "@/features/document";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";

export const DEFAULT_COMMENT_COLOR = "#f2b705";

export function visibleCommentThreads(
  threads: readonly SigmaCommentThread[] | undefined,
  options: { activeThreadId?: string | null; showResolved?: boolean } = {},
): SigmaCommentThread[] {
  return (threads ?? []).filter((thread) => (
    !thread.resolved ||
    options.showResolved === true ||
    thread.id === options.activeThreadId
  ));
}

export function isInlineBodyEmpty(children: readonly InlineNode[]): boolean {
  return children.every((child) => {
    if (child.type === "text") {
      return child.text.trim().length === 0;
    }
    return child.tex.trim().length === 0;
  });
}

export function inlineNodesToCommentText(children: readonly InlineNode[]): string {
  return children
    .map((child) => child.type === "text" ? child.text : `$${child.tex}$`)
    .join("")
    .trim();
}

export function getCommentAnchorQuote(anchor: SigmaCommentAnchor): string {
  if (anchor.type === "textRange") {
    return anchor.quote;
  }
  if (anchor.type === "inlineMath" || anchor.type === "overlayMath") {
    return anchor.quote || anchor.tex || "";
  }
  return anchor.quote ?? "";
}

/**
 * コメントが何に付いているかの表示名。
 *
 * `t` は任意。省略時は日本語で解決する — 既存の呼び出しとテストを無傷にするため
 * (表示する側は必ず `useT("editor")` の `t` を渡すこと)。
 */
export function getCommentAnchorLabel(
  anchor: SigmaCommentAnchor,
  document?: SigmaDocument,
  t: Translate<"editor"> = createTranslator(DEFAULT_LOCALE, "editor"),
): string {
  if (document && isCommentAnchorOrphan(document, anchor)) {
    return t("comment.anchor.orphan");
  }

  if (anchor.type === "textRange") {
    return t("comment.anchor.textRange");
  }
  if (anchor.type === "inlineMath") {
    return t("comment.anchor.inlineMath");
  }
  if (anchor.type === "overlayMath") {
    return t("comment.anchor.overlayMath");
  }
  if (anchor.type === "overlayShape") {
    return anchor.shapeIds.length > 1
      ? t("comment.anchor.shapes", { shapes: anchor.shapeIds.length })
      : t("comment.anchor.shape");
  }
  return t("comment.anchor.block");
}

export function getCommentThreadsForBlock(
  threads: readonly SigmaCommentThread[],
  blockId: string,
): SigmaCommentThread[] {
  return threads.filter((thread) => {
    const anchor = thread.anchor;
    if (anchor.type === "block") {
      return anchor.blockId === blockId;
    }
    if (anchor.type === "inlineMath") {
      return anchor.blockId === blockId;
    }
    if (anchor.type === "textRange") {
      return anchor.start.blockId === blockId || anchor.end.blockId === blockId;
    }
    return false;
  });
}

export function getCommentThreadsForInlineMath(
  threads: readonly SigmaCommentThread[],
  mathInlineId: string,
): SigmaCommentThread[] {
  return threads.filter((thread) => thread.anchor.type === "inlineMath" && thread.anchor.mathInlineId === mathInlineId);
}

export function getCommentThreadsForOverlayShape(
  threads: readonly SigmaCommentThread[],
  shapeId: string,
): SigmaCommentThread[] {
  return threads.filter((thread) => (
    (thread.anchor.type === "overlayShape" && thread.anchor.shapeIds.includes(shapeId)) ||
    (thread.anchor.type === "overlayMath" && thread.anchor.shapeId === shapeId)
  ));
}

export function isCommentAnchorOrphan(document: SigmaDocument, anchor: SigmaCommentAnchor): boolean {
  if (anchor.type === "block") {
    return !hasBlock(document, anchor.blockId);
  }
  if (anchor.type === "textRange") {
    return !hasBlock(document, anchor.start.blockId) || !hasBlock(document, anchor.end.blockId);
  }
  if (anchor.type === "inlineMath") {
    return !hasInlineMath(document, anchor.blockId, anchor.mathInlineId);
  }
  if (anchor.type === "overlayMath") {
    return anchor.shapeId ? !hasOverlayShape(document, anchor.shapeId) : false;
  }
  return !anchor.shapeIds.some((shapeId) => hasOverlayShape(document, shapeId));
}

export function createTextCommentAnchor(input: {
  endBlockId: string;
  endOffset: number;
  mathInlineIds?: string[];
  mathTex?: string[];
  quote: string;
  startBlockId: string;
  startOffset: number;
}): SigmaCommentAnchor {
  return {
    type: "textRange",
    start: {
      blockId: input.startBlockId,
      offset: Math.max(0, Math.floor(input.startOffset)),
    },
    end: {
      blockId: input.endBlockId,
      offset: Math.max(0, Math.floor(input.endOffset)),
    },
    quote: input.quote,
    mathInlineIds: uniqueNonEmpty(input.mathInlineIds),
    mathTex: uniqueNonEmpty(input.mathTex),
  };
}

function hasBlock(document: SigmaDocument, blockId: string): boolean {
  return Boolean(findBlockById(document.content, blockId));
}

function hasInlineMath(document: SigmaDocument, blockId: string, mathInlineId: string): boolean {
  const block = findBlockById(document.content, blockId);
  if (!block) {
    return false;
  }
  const richBlocks = blockToRichBlocks(block);
  return richBlocks.some((richBlock) => richBlockHasInlineMath(richBlock, mathInlineId));
}

function richBlockHasInlineMath(block: RichBlock, mathInlineId: string): boolean {
  if (block.type === "list") {
    return block.items.some((item) =>
      item.children.some((child) => child.type === "mathInline" && child.id === mathInlineId) ||
      (item.continuations ?? []).some((continuation) =>
        listItemContinuationInlineNodes(continuation).some((child) => child.type === "mathInline" && child.id === mathInlineId)
      ) ||
      (item.nested ?? []).some((nested) => richBlockHasInlineMath(nested, mathInlineId)),
    );
  }

  return block.children.some((child) => child.type === "mathInline" && child.id === mathInlineId);
}

function findBlockById(blocks: readonly SigmaBlock[], blockId: string): SigmaBlock | RichBlock | null {
  for (const block of blocks) {
    if (block.id === blockId) {
      return block;
    }
    if (block.type === "problem") {
      const found = problemRichBlocks(block).find((richBlock) => richBlock.id === blockId);
      if (found) {
        return found;
      }
    }
    if (block.type === "layoutSection") {
      const found = block.children.find((child) => child.id === blockId);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function blockToRichBlocks(block: SigmaBlock | RichBlock): RichBlock[] {
  if (block.type === "heading" || block.type === "paragraph" || block.type === "list") {
    return [block];
  }
  if (block.type === "problem") {
    return problemRichBlocks(block);
  }
  if (block.type === "layoutSection") {
    return block.children.flatMap(layoutSectionChildToRichBlocks);
  }
  return [];
}

function problemRichBlocks(problem: ProblemNode): RichBlock[] {
  return [...problem.lead, ...problem.prompt, ...problem.hints, ...problem.solution].flatMap((block) => (
    block.type === "layoutSection"
      ? block.children.flatMap(layoutSectionChildToRichBlocks)
      : block.type === "boxBlock" || block.type === "divider"
        ? []
        : layoutSectionChildToRichBlocks(block)
  ));
}

function layoutSectionChildToRichBlocks(block: LayoutSectionChildBlock): RichBlock[] {
  if (block.type === "section" || block.type === "boxBlock" || block.type === "divider") {
    return [];
  }
  // コードブロックはコメントの引用に使える文章を持つが `RichBlock` ではないので、
  // 段落として写す。引用は入れ物なので中身へ降りる。
  if (block.type === "codeBlock") {
    return [{ type: "paragraph", id: block.id, children: block.children }];
  }
  if (block.type === "quote") {
    return block.blocks.flatMap(layoutSectionChildToRichBlocks);
  }
  return [block];
}

function hasOverlayShape(document: SigmaDocument, shapeId: string): boolean {
  const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes;
  return Array.isArray(shapes) && shapes.some((shape) => shape && typeof shape === "object" && "id" in shape && shape.id === shapeId);
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] | undefined {
  const unique = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
  return unique.length ? unique : undefined;
}
