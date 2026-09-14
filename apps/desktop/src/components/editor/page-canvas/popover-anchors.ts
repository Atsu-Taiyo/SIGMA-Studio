import { getShapesSelectionBounds } from "@/features/drawing";
import { listItemContinuationInlineNodes } from "@/features/document";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { createTextCommentAnchor } from "@/lib/comments";
import type {
  BoxBlockChildBlock,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  ProblemAreaBlock,
  ProblemNode,
  RichBlock,
  SigmaBlock,
  SigmaCommentAnchor,
  SigmaDocument,
} from "@/features/document";
import { PROBLEM_AREA_ORDER } from "./block-ops";

export interface CommentAnchorPopoverState {
  anchor: SigmaCommentAnchor;
  position: SelectionActionPopoverPosition;
}

export interface SelectionActionPopoverPosition {
  left: number;
  top: number;
}

export interface OverlaySelectionPopoverMeasurement {
  key: string;
  position: SelectionActionPopoverPosition | null;
}

export interface SelectionActionPopoverPositionOptions {
  verticalClearance?: number;
  viewport?: {
    width: number;
    height: number;
  };
}

const SELECTION_ACTION_POPOVER_WIDTH = 112;
const SELECTION_ACTION_POPOVER_HEIGHT = 38;
const SELECTION_ACTION_POPOVER_GAP = 8;
const SELECTION_ACTION_POPOVER_MARGIN = 12;
const OVERLAY_ROTATE_HANDLE_CLEARANCE = 42;

export function viewportToCanvasAnchor(
  viewport: { left: number; top: number },
  canvas: HTMLElement,
): { left: number; top: number } {
  const canvasRect = canvas.getBoundingClientRect();
  const pageStack = canvas.closest<HTMLElement>(".page-stack");
  const zoomScale = pageStack
    ? Number.parseFloat(getComputedStyle(pageStack).zoom || "1") || 1
    : 1;
  return {
    left: (viewport.left - canvasRect.left) / zoomScale,
    top: (viewport.top - canvasRect.top) / zoomScale,
  };
}

export function getSelectionActionPopoverPosition(
  rect: DOMRect,
  options: SelectionActionPopoverPositionOptions = {},
): { left: number; top: number } {
  const viewportWidth = options.viewport?.width ?? window.innerWidth;
  const viewportHeight = options.viewport?.height ?? window.innerHeight;
  const verticalClearance = options.verticalClearance ?? SELECTION_ACTION_POPOVER_GAP;
  const maxLeft = Math.max(
    SELECTION_ACTION_POPOVER_MARGIN,
    viewportWidth - SELECTION_ACTION_POPOVER_WIDTH - SELECTION_ACTION_POPOVER_MARGIN,
  );
  const maxTop = Math.max(
    SELECTION_ACTION_POPOVER_MARGIN,
    viewportHeight - SELECTION_ACTION_POPOVER_HEIGHT - SELECTION_ACTION_POPOVER_MARGIN,
  );
  const preferredTop = rect.top - SELECTION_ACTION_POPOVER_HEIGHT - verticalClearance;
  const fallbackBelowTop = rect.bottom + SELECTION_ACTION_POPOVER_GAP;
  const shouldFallbackBelow =
    verticalClearance > SELECTION_ACTION_POPOVER_GAP &&
    preferredTop < SELECTION_ACTION_POPOVER_MARGIN &&
    fallbackBelowTop + SELECTION_ACTION_POPOVER_HEIGHT <= viewportHeight - SELECTION_ACTION_POPOVER_MARGIN;

  return {
    left: Math.min(
      maxLeft,
      Math.max(
        SELECTION_ACTION_POPOVER_MARGIN,
        rect.left + rect.width / 2 - SELECTION_ACTION_POPOVER_WIDTH / 2,
      ),
    ),
    top: shouldFallbackBelow
      ? fallbackBelowTop
      : Math.min(maxTop, Math.max(SELECTION_ACTION_POPOVER_MARGIN, preferredTop)),
  };
}

export function getOverlaySelectionActionPopoverPosition(
  canvas: HTMLElement | null,
  selection: OverlaySelectionSummary,
  zoom: number,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): SelectionActionPopoverPosition | null {
  if (!canvas || (selection.selectedShapes.length === 0 && !selection.region)) {
    return null;
  }

  const bounds = selection.region ?? getShapesSelectionBounds(selection.selectedShapes);
  if (!bounds) {
    return null;
  }

  const zoomScale = Math.max(0.01, zoom / 100);
  const canvasRect = canvas.getBoundingClientRect();
  return getSelectionActionPopoverPosition(new DOMRect(
    canvasRect.left + offset.x + bounds.x * zoomScale,
    canvasRect.top + offset.y + bounds.y * zoomScale,
    Math.max(1, bounds.w * zoomScale),
    Math.max(1, bounds.h * zoomScale),
  ), {
    verticalClearance: selection.region ? SELECTION_ACTION_POPOVER_GAP : OVERLAY_ROTATE_HANDLE_CLEARANCE,
  });
}

export function sameSelectionActionPopoverPosition(
  a: SelectionActionPopoverPosition | null,
  b: SelectionActionPopoverPosition | null,
): boolean {
  return a === b || Boolean(a && b && a.left === b.left && a.top === b.top);
}

export function createTextCommentAnchorFromRange(
  range: Range,
  root: HTMLElement,
  selectedText: string,
  mathTex: string[],
): SigmaCommentAnchor | null {
  const startBlock = getClosestBlockElement(getNodeElement(range.startContainer), root);
  const endBlock = getClosestBlockElement(getNodeElement(range.endContainer), root);
  const startBlockId = startBlock ? getBlockElementId(startBlock) : null;
  const endBlockId = endBlock ? getBlockElementId(endBlock) : null;
  if (!startBlock || !endBlock || !startBlockId || !endBlockId) {
    return null;
  }

  return createTextCommentAnchor({
    startBlockId,
    startOffset: getRangeOffsetWithinElement(startBlock, range.startContainer, range.startOffset),
    endBlockId,
    endOffset: getRangeOffsetWithinElement(endBlock, range.endContainer, range.endOffset),
    quote: selectedText,
    mathInlineIds: getMathInlineIdsFromRange(range),
    mathTex,
  });
}

export function createBlockCommentAnchor(document: SigmaDocument, blockId: string): SigmaCommentAnchor | null {
  const block = findBlockForComment(document.content, blockId);
  if (!block) {
    return null;
  }

  return {
    type: "block",
    blockId,
    quote: getBlockCommentQuote(block),
  };
}

export function getOverlaySelectionTargetBlockId(selection: OverlaySelectionSummary): string | null {
  if (selection.selectedShapes.length === 0) {
    return null;
  }

  const shapesById = new Map(selection.selectedShapes.map((shape) => [shape.id, shape]));
  for (const shape of selection.selectedShapes) {
    const blockId = getShapeAnchorBlockId(shape, shapesById, new Set());
    if (blockId) {
      return blockId;
    }
  }

  return null;
}

function getShapeAnchorBlockId(
  shape: OverlayShape,
  shapesById: Map<string, OverlayShape>,
  visited: Set<string>,
): string | null {
  if (visited.has(shape.id)) {
    return null;
  }
  visited.add(shape.id);

  const anchor = shape.anchor;
  if (!anchor) {
    return null;
  }
  if (anchor.type === "block") {
    return anchor.blockId;
  }
  if (anchor.type === "shape") {
    const parent = shapesById.get(anchor.shapeId);
    return parent ? getShapeAnchorBlockId(parent, shapesById, visited) : null;
  }

  return null;
}

function getClosestBlockElement(element: Element | null | undefined, root: HTMLElement): HTMLElement | null {
  let current: Element | null | undefined = element;
  while (current && current !== root) {
    if (current instanceof HTMLElement && getBlockElementId(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function getBlockElementId(element: HTMLElement): string | null {
  const dataId = element.getAttribute("data-sigma-doc-id");
  if (dataId) {
    return dataId;
  }
  if ((element.classList.contains("editor-block") || element.hasAttribute("data-page-block")) && element.id) {
    return element.id;
  }
  return null;
}

function getRangeOffsetWithinElement(element: HTMLElement, container: Node, offset: number): number {
  const ownerDocument = element.ownerDocument;
  const offsetRange = ownerDocument.createRange();
  offsetRange.selectNodeContents(element);
  try {
    offsetRange.setEnd(container, offset);
  } catch {
    return 0;
  }

  return getCommentOffsetText(offsetRange).length;
}

function getCommentOffsetText(range: Range): string {
  const fragment = range.cloneContents();
  fragment.querySelectorAll<HTMLElement>("[data-sigma-doc-math-inline], .inline-math-node").forEach((element) => {
    const tex = element.getAttribute("data-tex") ?? "";
    element.textContent = tex ? `$${tex}$` : "";
  });
  return fragment.textContent ?? "";
}

function getMathInlineIdsFromRange(range: Range): string[] {
  const fragment = range.cloneContents();
  const ids = Array.from(fragment.querySelectorAll<HTMLElement>("[data-sigma-doc-math-inline], .inline-math-node"))
    .map((element) => element.getAttribute("data-id"))
    .filter((id): id is string => Boolean(id));
  return Array.from(new Set(ids));
}

function findBlockForComment(blocks: readonly SigmaBlock[], blockId: string): SigmaBlock | ProblemAreaBlock | ListItemNode | null {
  for (const block of blocks) {
    if (block.id === blockId) {
      return block;
    }
    if (block.type === "list") {
      const found = findListItemForComment(block, blockId);
      if (found) {
        return found;
      }
      continue;
    }
    if (block.type !== "problem") {
      continue;
    }
    for (const area of PROBLEM_AREA_ORDER) {
      const richBlock = block[area].find((item) => item.id === blockId);
      if (richBlock) {
        return richBlock;
      }
      for (const item of block[area]) {
        if (area === "solution" && item.type === "layoutSection") {
          const found = findLayoutSectionChildForComment(item.children, blockId);
          if (found) {
            return found;
          }
        }
        if (item.type === "list") {
          const found = findListItemForComment(item, blockId);
          if (found) {
            return found;
          }
        }
      }
    }
  }
  return null;
}

function findLayoutSectionChildForComment(blocks: readonly LayoutSectionChildBlock[], blockId: string): SigmaBlock | ListItemNode | null {
  for (const block of blocks) {
    if (block.id === blockId) {
      return block;
    }
    if (block.type === "boxBlock") {
      const found = findBoxBlockChildForComment(block.blocks, blockId);
      if (found) {
        return found;
      }
    }
    if (block.type === "list") {
      const found = findListItemForComment(block, blockId);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function findBoxBlockChildForComment(blocks: readonly BoxBlockChildBlock[], blockId: string): BoxBlockChildBlock | ListItemNode | null {
  for (const block of blocks) {
    if (block.id === blockId) {
      return block;
    }
    if (block.type === "layoutSection") {
      const found = findLayoutSectionChildForComment(block.children, blockId);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function findListItemForComment(
  list: Extract<RichBlock, { type: "list" }>,
  blockId: string,
): ListItemNode | Extract<ProblemAreaBlock, { type: "paragraph" | "heading" }> | null {
  for (const item of list.items) {
    if (item.id === blockId) {
      return item;
    }
    const continuation = item.continuations?.find((candidate) => candidate.id === blockId);
    // 区切り線には引用できる文章が無いので、コメントの対象にはしない。
    if (continuation && continuation.type !== "divider") {
      return continuation;
    }
    for (const nested of item.nested ?? []) {
      const found = findListItemForComment(nested, blockId);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function getBlockCommentQuote(block: SigmaBlock | ProblemAreaBlock | ListItemNode): string | undefined {
  const text = block.type === "section"
    ? block.title
    : block.type === "problem"
      ? getProblemCommentQuote(block)
      : block.type === "layoutSection"
        ? block.children.map((child) => child.type === "section"
          ? child.title
          : child.type === "boxBlock"
            ? getBlockCommentQuote(child) ?? ""
          : child.type === "list"
            ? getListCommentQuote(child)
          : child.type === "divider"
            ? ""
          : child.type === "quote"
            ? child.blocks.map(getLayoutSectionChildCommentQuote).join(" ")
            : inlineNodesToShortText(child.children)).join(" ")
      : block.type === "boxBlock"
        ? [
            inlineNodesToShortText(block.title ?? []),
            ...block.blocks.map(getBoxBlockChildCommentQuote),
          ].join(" ")
      : block.type === "list"
        ? getListCommentQuote(block)
      : block.type === "listItem"
        ? [
            inlineNodesToShortText(block.children),
            ...(block.continuations ?? []).map((continuation) => inlineNodesToShortText(listItemContinuationInlineNodes(continuation))),
          ].join(" ")
      : block.type === "divider"
        ? ""
      : block.type === "quote"
        ? block.blocks.map(getLayoutSectionChildCommentQuote).join(" ")
        : inlineNodesToShortText(block.children);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

function getBoxBlockChildCommentQuote(block: BoxBlockChildBlock): string {
  if (block.type === "problem") return getProblemCommentQuote(block);
  if (block.type === "layoutSection") {
    return block.children.map(getLayoutSectionChildCommentQuote).join(" ");
  }
  return getLayoutSectionChildCommentQuote(block);
}

function getLayoutSectionChildCommentQuote(block: LayoutSectionChildBlock): string {
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "boxBlock") {
    return getBlockCommentQuote(block) ?? "";
  }
  if (block.type === "list") {
    return getListCommentQuote(block);
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "quote") {
    return block.blocks.map(getLayoutSectionChildCommentQuote).join(" ");
  }
  return inlineNodesToShortText(block.children);
}

function getProblemCommentQuote(problem: ProblemNode): string {
  for (const area of PROBLEM_AREA_ORDER) {
    const text = problem[area].map((block) => getProblemAreaBlockCommentQuote(block)).join(" ").trim();
    if (text) {
      return text;
    }
  }
  return "問題";
}

function getProblemAreaBlockCommentQuote(block: ProblemAreaBlock): string {
  if (block.type === "layoutSection") {
    return block.children.map(getLayoutSectionChildCommentQuote).join(" ");
  }
  if (block.type === "boxBlock") {
    return getBlockCommentQuote(block) ?? "";
  }
  if (block.type === "list") {
    return getListCommentQuote(block);
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "quote") {
    return block.blocks.map(getLayoutSectionChildCommentQuote).join(" ");
  }
  return inlineNodesToShortText(block.children);
}

function getListCommentQuote(list: Extract<RichBlock, { type: "list" }>): string {
  return list.items.map((item) => {
    const text = inlineNodesToShortText(item.children);
    const continuations = (item.continuations ?? [])
      .map((continuation) => inlineNodesToShortText(listItemContinuationInlineNodes(continuation)))
      .join(" ");
    const nested = (item.nested ?? []).map(getListCommentQuote).join(" ");
    return [text, continuations, nested].filter(Boolean).join(" ");
  }).join(" ");
}

function inlineNodesToShortText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.text : `$${node.tex}$`).join("");
}

export function getContextMenuPosition(clientX: number, clientY: number): { left: number; top: number } {
  const dialogWidth = 320;
  const dialogHeight = 132;
  const margin = 12;
  const maxLeft = Math.max(margin, window.innerWidth - dialogWidth - margin);
  const maxTop = Math.max(margin, window.innerHeight - dialogHeight - margin);

  return {
    left: Math.min(maxLeft, Math.max(margin, clientX)),
    top: Math.min(maxTop, Math.max(margin, clientY)),
  };
}

export function getRangeScreenRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) {
    const rect = range.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function isRangeInsideElement(range: Range, root: HTMLElement): boolean {
  const element = getNodeElement(range.commonAncestorContainer);
  return !!element && root.contains(element);
}

export function getRangeTargetBlockId(range: Range, root: HTMLElement): string | null {
  return getClosestBlockId(getNodeElement(range.startContainer), root) ??
    getClosestBlockId(getNodeElement(range.commonAncestorContainer), root);
}

export function getClosestBlockId(element: Element | null | undefined, root: HTMLElement): string | null {
  let current: Element | null | undefined = element;
  while (current && current !== root) {
    if (current instanceof HTMLElement) {
      const dataId = current.getAttribute("data-sigma-doc-id");
      if (dataId) {
        return dataId;
      }

      if ((current.classList.contains("editor-block") || current.hasAttribute("data-page-block")) && current.id) {
        return current.id;
      }
    }
    current = current.parentElement;
  }

  return null;
}

function getNodeElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}
