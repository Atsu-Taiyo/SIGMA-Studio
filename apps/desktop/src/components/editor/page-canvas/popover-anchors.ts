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
import { modelToDisplay } from "@/features/rendering/core";
import { PROBLEM_AREA_ORDER } from "./block-ops";
import { readCanvasPageArrangement } from "./page-arrangement-dom";

export interface CommentAnchorPopoverState {
  anchor: SigmaCommentAnchor;
  position: SelectionActionPopoverPosition;
}

export interface SelectionActionPopoverPosition {
  left: number;
  top: number;
  /**
   * 選択範囲の中心 (画面座標)。ポップオーバーの実寸が分かってから中央寄せするための値。
   * `left` は幅の見積りで決めた端の位置で、AI パネルなど他の配置も参照するため残す。
   */
  centerX?: number;
  /**
   * 本文の選択だけが持つ。帯から開く AI・コメントの入力欄を選んだところのすぐ下に開くのと、
   * 書式の帯が無いとき (カーソルだけ・数式だけ) に AI・コメントを右下のチップで出すのに使う。
   * 図形の選択は持たない (入力欄は帯の下に開く)。
   */
  trailing?: SelectionTrailingAnchor;
}

/** 選んだところの右下の角と、チップを収める範囲 (いずれも画面座標)。 */
export interface SelectionTrailingAnchor {
  /** 選択の最後の行の右端。 */
  right: number;
  /** 選択の最後の行の下端。 */
  bottom: number;
  /** 選択の上端。下に置けないときは、ここより上へ回す。 */
  top: number;
  /** 右端の限界。選択が載っている用紙の右端 (と画面の右端) を越えない。 */
  limitRight: number;
  /** 下端の限界。用紙の下端・本文の表示域の下端。 */
  limitBottom: number;
}

export interface SelectionTrailingPlacement {
  left: number;
  top: number;
  placement: "below" | "above";
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

const SELECTION_ACTION_POPOVER_WIDTH = 210;
const SELECTION_ACTION_POPOVER_HEIGHT = 38;
const SELECTION_ACTION_POPOVER_GAP = 8;
export const SELECTION_ACTION_POPOVER_MARGIN = 12;
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
): SelectionActionPopoverPosition {
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
    centerX: rect.left + rect.width / 2,
  };
}

/** 図形の選択のポップオーバーを添える範囲 (紙面の座標) と、その上に空ける間隔 (画面の px)。 */
function getOverlaySelectionPopoverAnchor(
  selection: OverlaySelectionSummary,
): { bounds: { x: number; y: number; w: number; h: number }; verticalClearance: number } | null {
  if (selection.selectedShapes.length === 0 && !selection.region) {
    return null;
  }
  const bounds = selection.region ?? getShapesSelectionBounds(selection.selectedShapes);
  if (!bounds) {
    return null;
  }
  // 図形を選んでいれば、選択枠の上の回転ハンドルを避ける。範囲の選択には回転ハンドルが無い。
  return {
    bounds,
    verticalClearance: selection.region ? SELECTION_ACTION_POPOVER_GAP : OVERLAY_ROTATE_HANDLE_CLEARANCE,
  };
}

export function getOverlaySelectionActionPopoverPosition(
  canvas: HTMLElement | null,
  selection: OverlaySelectionSummary,
  zoom: number,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): SelectionActionPopoverPosition | null {
  const anchor = getOverlaySelectionPopoverAnchor(selection);
  if (!canvas || !anchor) {
    return null;
  }

  const { verticalClearance } = anchor;
  // 2 ページ並びでは、選択はそのページのずらしで描かれている (`overlay-canvas/page-shift.tsx`)。
  const arrangement = readCanvasPageArrangement(canvas);
  const bounds = arrangement ? { ...anchor.bounds, ...modelToDisplay(arrangement, anchor.bounds) } : anchor.bounds;
  const zoomScale = Math.max(0.01, zoom / 100);
  const canvasRect = canvas.getBoundingClientRect();
  return getSelectionActionPopoverPosition(new DOMRect(
    canvasRect.left + offset.x + bounds.x * zoomScale,
    canvasRect.top + offset.y + bounds.y * zoomScale,
    Math.max(1, bounds.w * zoomScale),
    Math.max(1, bounds.h * zoomScale),
  ), { verticalClearance });
}

/**
 * 図形の選択の操作が選択範囲の上に取る帯 (紙面の座標): ポップオーバーと、その下の回転ハンドルの間隔。
 * 紙面に浮かべる部品 (拡張の `floatingContent`) がこれを覆わないための障害物。ポップオーバーは画面の px で
 * 置くので、紙面の座標ではズームで割る。幅は中身で変わるので、描いた後は実寸 (`popoverWidthPx`) を
 * 使う (それまでは見積もり)。選んだ範囲そのもの (グループ・複数選択の中) は含めない。
 */
export function getOverlaySelectionControlsCanvasRect(
  selection: OverlaySelectionSummary,
  zoom: number,
  popoverWidthPx: number = SELECTION_ACTION_POPOVER_WIDTH,
): { x: number; y: number; w: number; h: number } | null {
  const anchor = getOverlaySelectionPopoverAnchor(selection);
  if (!anchor) {
    return null;
  }
  const zoomScale = Math.max(0.01, zoom / 100);
  const height = (SELECTION_ACTION_POPOVER_HEIGHT + anchor.verticalClearance) / zoomScale;
  const width = popoverWidthPx / zoomScale;
  return {
    x: anchor.bounds.x + anchor.bounds.w / 2 - width / 2,
    y: anchor.bounds.y - height,
    w: width,
    h: height,
  };
}

export function sameSelectionActionPopoverPosition(
  a: SelectionActionPopoverPosition | null,
  b: SelectionActionPopoverPosition | null,
): boolean {
  return a === b || Boolean(
    a && b && a.left === b.left && a.top === b.top && a.centerX === b.centerX
      && sameSelectionTrailingAnchor(a.trailing, b.trailing),
  );
}

function sameSelectionTrailingAnchor(a: SelectionTrailingAnchor | undefined, b: SelectionTrailingAnchor | undefined): boolean {
  return a === b || Boolean(
    a && b && a.right === b.right && a.bottom === b.bottom && a.top === b.top
      && a.limitRight === b.limitRight && a.limitBottom === b.limitBottom,
  );
}

/** 用紙の右端からチップを離す量 (画面の px)。用紙の縁にぴったり付けると、縁の影と重なって読みにくい。 */
const TRAILING_PAGE_EDGE_INSET = 8;
/** 選択とチップの間隔 (画面の px)。 */
const TRAILING_GAP = 6;
/** 同じ行の続きとみなす、行の切れ端どうしの隙間 (画面の px)。段の間はこれより広い。 */
const LINE_PIECE_GAP = 8;

/**
 * 選んだところの右下の角を求める。`lines` は選択の行ごとの矩形 (範囲なら `getClientRects`、
 * ブロックや数式ならその矩形 1 つ)。`end` は選択の終わりの位置 (範囲の終わりに置いたカーソルの矩形)。
 *
 * 右端は選択が終わった位置で、全体の外接矩形の右端ではない — 複数行の選択で、選択が終わった
 * 位置から離れた段の右端にチップが飛ばないようにする。いちばん下の矩形も最後の行とは限らない
 * (2 段組で 1 段目の下から 2 段目の上まで選ぶと、いちばん下は 1 段目) ので、終わりの位置が
 * 分かれば、その位置の行だけを使う。終わりの位置が測れないときは、いちばん下の行を使う。
 */
export function getSelectionTrailingAnchor(
  lines: readonly DOMRect[],
  canvas: HTMLElement | null,
  end: DOMRect | null = null,
): SelectionTrailingAnchor | null {
  const rects = lines.filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length === 0) {
    return null;
  }
  const endLine = end ? findLineAtSelectionEnd(rects, end) : null;
  const lastLine = endLine ?? findLowestLine(rects);
  const right = endLine && end ? end.left : Math.max(...lastLine.map((rect) => rect.right));
  const bottom = Math.max(...lastLine.map((rect) => rect.bottom));
  const lineTop = Math.min(...lastLine.map((rect) => rect.top));
  const top = Math.min(...rects.map((rect) => rect.top));
  const scrollerRect = canvas?.closest<HTMLElement>(".editor-canvas")?.getBoundingClientRect() ?? null;
  const viewportRight = Math.min(window.innerWidth, scrollerRect?.right ?? Number.POSITIVE_INFINITY);
  const viewportBottom = Math.min(window.innerHeight, scrollerRect?.bottom ?? Number.POSITIVE_INFINITY);
  const page = findPageSheetRect(canvas, (lineTop + bottom) / 2, right);
  return {
    right,
    bottom,
    top,
    limitRight: Math.min(viewportRight - SELECTION_ACTION_POPOVER_MARGIN, page ? page.right - TRAILING_PAGE_EDGE_INSET : Number.POSITIVE_INFINITY),
    limitBottom: Math.min(viewportBottom - SELECTION_ACTION_POPOVER_MARGIN, page ? page.bottom : Number.POSITIVE_INFINITY),
  };
}

/** いちばん下の矩形と同じ高さに載っている矩形 (背の高い数式も同じ行に数える)。 */
function findLowestLine(rects: readonly DOMRect[]): DOMRect[] {
  const lowest = rects.reduce((current, rect) => (rect.bottom > current.bottom ? rect : current));
  return rects.filter((rect) => {
    const middle = rect.top + rect.height / 2;
    return middle >= lowest.top && middle <= lowest.bottom;
  });
}

/**
 * 選択の終わりの位置がある行の矩形。終わりの位置を含む切れ端から、隙間なく左へ続く切れ端までを
 * その行とする (同じ高さでも、段の間をあけた別の段の行は含めない)。見つからなければ null。
 */
function findLineAtSelectionEnd(rects: readonly DOMRect[], end: DOMRect): DOMRect[] | null {
  const middle = end.top + end.height / 2;
  const x = end.left;
  const band = rects.filter((rect) => rect.top <= middle && middle <= rect.bottom);
  const last = band.find((rect) => rect.left - 1 <= x && x <= rect.right + 1);
  if (!last) {
    return null;
  }
  const line = [last];
  let lineLeft = last.left;
  for (const rect of [...band].sort((a, b) => b.right - a.right)) {
    if (rect !== last && rect.left < lineLeft && rect.right >= lineLeft - LINE_PIECE_GAP) {
      line.push(rect);
      lineLeft = rect.left;
    }
  }
  return line;
}

/**
 * 選択の行が載っている用紙の矩形。用紙の無い面 (ホワイトボード) や用紙の間では null。
 * 2 ページ並びでは同じ高さに 2 枚あるので、横の位置 (`x`) も含む用紙を選ぶ。
 */
function findPageSheetRect(canvas: HTMLElement | null, y: number, x: number): DOMRect | null {
  if (!canvas) {
    return null;
  }
  let sameRow: DOMRect | null = null;
  for (const sheet of Array.from(canvas.querySelectorAll<HTMLElement>(".page-backdrop > .a4-page-sheet"))) {
    const rect = sheet.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      if (x >= rect.left && x <= rect.right) {
        return rect;
      }
      sameRow ??= rect;
    }
  }
  return sameRow;
}

/**
 * 本文の選択の帯から開く AI・コメントの入力欄の錨 (画面座標)。入力欄は「押した部品の下」に開く
 * 約束なので、帯がそのまま渡ると、選択の上の帯の真下 = 選んだ文の上に開いて隠す。選んだところの
 * 右下に帯の高さの部品があるとみなした位置を返し、入力欄を選択のすぐ下に開かせる。
 */
export function getSelectionFollowUpAnchor(anchor: SelectionTrailingAnchor): { left: number; top: number } {
  const { left, top } = placeSelectionTrailingActions(anchor, { width: SELECTION_ACTION_POPOVER_WIDTH, height: 0 });
  return { left, top: top - SELECTION_ACTION_POPOVER_HEIGHT };
}

/**
 * チップの置き場所。左上の角を選んだところの右下の角に合わせ、用紙 (画面) の右端を越えるなら
 * 右端に揃えて左へ寄せる。下に収まらない (用紙の下端・画面の下端を越える) ときだけ選択の上へ回す。
 */
export function placeSelectionTrailingActions(
  anchor: SelectionTrailingAnchor,
  size: { width: number; height: number },
): SelectionTrailingPlacement {
  const left = Math.max(SELECTION_ACTION_POPOVER_MARGIN, Math.min(anchor.right, anchor.limitRight - size.width));
  const below = anchor.bottom + TRAILING_GAP;
  if (below + size.height <= anchor.limitBottom) {
    return { left, top: below, placement: "below" };
  }
  return {
    left,
    top: Math.max(SELECTION_ACTION_POPOVER_MARGIN, anchor.top - TRAILING_GAP - size.height),
    placement: "above",
  };
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

export function getCommentOffsetText(range: Range): string {
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
