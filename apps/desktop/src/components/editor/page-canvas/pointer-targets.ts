"use client";

import  {
  blockSpaceAfterPx,
  PAGE_GAP_PX,
  rendersBlockSpaceAfter,
  type PageMetrics,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import { findBlock } from "@/lib/document-tree";
import type { OverlayPoint } from "../overlay-canvas/types";
import  {
  blockHitProbeColumnLeftPx,
  isContainerTopBand,
  resolveColumnLaneWidthPx,
  type BlockNeighborKind,
  type HoveredTopLevelBlock,
  type TopLevelBlockBox,
} from "./block-affordances";
import { resolveHoverDragUnitAt, resolveInnerAffordanceProbe, type DragIndex } from "./block-drag-dom";
import { visibleBlockClientRect } from "./visible-block-rect";
import { pickContiguousSelectedSiblingIds } from "./block-ops";
import  {
  getCanvasPointerPoint,
  getPageOverlayPoint,
  getPagePointerContext as getPagePointerContextFromRect,
  type PagePointerContext,
} from "./pointer-model";


/** Continuation content shares SigmaDoc identity with its source in the main flow. */
export const BLOCK_BOX_FRAGMENT_LAYER_SELECTOR = ".page-box-fragment-layer";

/** How far into the content column the margin-hover probe reaches to find the block. */
export const BLOCK_HIT_PROBE_INSET_PX = 8;

/** How far up and down the probe reaches when the pointer sits in the gap between blocks. */
export const BLOCK_HIT_GAP_PROBE_PX = 14;


export function getPagePointerContext({
  canvas,
  clientX,
  clientY,
  metrics,
  pageCount,
  pageHeightPx,
}: {
  canvas: HTMLDivElement | null;
  clientX: number;
  clientY: number;
  metrics: PageMetrics;
  pageCount: number;
  pageHeightPx: number;
}): PagePointerContext | null {
  if (!canvas) {
    return null;
  }

  return getPagePointerContextFromRect({
    canvasRect: canvas.getBoundingClientRect(),
    clientX,
    clientY,
    metrics,
    pageCount,
    pageGapPx: PAGE_GAP_PX,
    pageHeightPx,
  });
}


export function getClientOverlayPointOnPage({
  canvas,
  clientX,
  clientY,
  metrics,
  pageCount,
  pageHeightPx,
}: {
  canvas: HTMLDivElement | null;
  clientX: number;
  clientY: number;
  metrics: PageMetrics;
  pageCount: number;
  pageHeightPx: number;
}): OverlayPoint | null {
  if (!canvas) {
    return null;
  }

  return getPageOverlayPoint({
    canvasRect: canvas.getBoundingClientRect(),
    clientX,
    clientY,
    metrics,
    pageCount,
    pageGapPx: PAGE_GAP_PX,
    pageHeightPx,
  });
}


export function getClientOverlayPointOnCanvas({
  canvas,
  clientX,
  clientY,
  metrics,
}: {
  canvas: HTMLDivElement | null;
  clientX: number;
  clientY: number;
  metrics: PageMetrics;
}): OverlayPoint | null {
  if (!canvas) {
    return null;
  }

  return getCanvasPointerPoint({
    canvasRect: canvas.getBoundingClientRect(),
    clientX,
    clientY,
    metrics,
  });
}


/**
 * The top-level block under the pointer, measured on the spot.
 *
 * The pointer is usually over the text itself, but the handle also has to appear while the
 * pointer sits in the left margin, where the topmost element belongs to the whole text run
 * rather than to one block. A second probe inside the content column at the same height
 * recovers the block in that case.
 */
export function hitTestTopLevelBlock(
  canvas: HTMLElement,
  document: SigmaDocument,
  dragIndex: DragIndex,
  clientX: number,
  clientY: number,
  metrics: PageMetrics,
): HoveredTopLevelBlock | null {
  const content = document.content;
  // プローブは **ポインタが居る段** の中へ、レイアウト px で組んでから画面 px へ換算して打つ。
  // 常に 1 段目 (かつ換算なし) だと、2 段目のつまみへ近づいた途中の段間で 1 段目のブロックへ
  // 解決し直されて (ズーム≠100% では左ガターでも空振りして) つまみが消える。
  const canvasRect = canvas.getBoundingClientRect();
  const scale = canvasLayoutScale(canvas);
  const probeColumnLeftPx = blockHitProbeColumnLeftPx(
    {
      contentLeftPx: metrics.margins.leftPx,
      columnCount: metrics.flow.columnCount,
      columnWidthPx: metrics.flow.columnWidthPx,
      columnGapPx: metrics.flow.columnGapPx,
    },
    (clientX - canvasRect.left) / scale,
  );
  const columnProbeX = canvasRect.left + (probeColumnLeftPx + BLOCK_HIT_PROBE_INSET_PX) * scale;
  const gapProbePx = BLOCK_HIT_GAP_PROBE_PX * scale;
  const direct = resolveTopLevelBlockAtPoint(canvas, clientX, clientY)
    ?? resolveTopLevelBlockAtPoint(canvas, columnProbeX, clientY);

  // Flow units are separated by margins that are wider than the edge threshold, so the
  // pointer can sit between two blocks and touch neither. Reaching up first, then down,
  // names the block the gap belongs to and which of its edges the pointer is beside.
  const gapAbove = direct
    ? null
    : resolveTopLevelBlockAtPoint(canvas, columnProbeX, clientY - gapProbePx);
  const gapBelow = direct || gapAbove
    ? null
    : resolveTopLevelBlockAtPoint(canvas, columnProbeX, clientY + gapProbePx);
  const owner = direct ?? gapAbove ?? gapBelow;
  if (!owner) {
    return null;
  }

  const index = content.findIndex((block) => block.id === owner.id);
  if (index < 0) {
    return null;
  }

  // A problem spans several area elements, so it has to be re-collected; a body block is
  // exactly the element already under the pointer.
  const box = owner.isProblem && !owner.element.matches(".editor-box-fragment-viewport")
    ? measureTopLevelBlockBoxes(canvas, [content[index]])[0]
    : toCanvasBox(owner.id, [owner.element], canvas);
  if (!box) {
    return null;
  }

  // グリップは **掴む単位** (箱の中の段落・リストの項目) に出す。左ガターや段間では、
  // 全ブロックを測らず、現在の段の本文内へ 1 点だけプローブして同じ高さの行を拾う。
  // 入れ物の上端帯ではプローブも入れ物自身へ当たるため、そこだけ殻を掴める。
  const unitY = gapAbove ? clientY - gapProbePx : gapBelow ? clientY + gapProbePx : clientY;
  const directUnit = direct
    ? resolveHoverDragUnitAt(canvas, document, dragIndex, clientX, unitY)
    : null;
  const innerLane = resolveInnerAffordanceProbe(owner.element, clientX, unitY);
  const innerProbeX = innerLane?.probeX ?? columnProbeX;
  const probeUnit = resolveHoverDragUnitAt(canvas, document, dragIndex, innerProbeX, unitY);
  const directInnerUnit = directUnit?.id !== content[index].id && !directUnit?.resolvedFromContainer
    ? directUnit
    : null;
  // A hit on actual content is authoritative. The gutter probe only fills the otherwise empty
  // lane; it must never replace a valid hit with a same-height block from another nested grid.
  const resolvedUnit = directInnerUnit ?? (
    probeUnit && probeUnit.id !== content[index].id ? probeUnit : directUnit ?? probeUnit
  );
  const ownerCanOwnTopBand = content[index].type === "boxBlock"
    || content[index].type === "problem"
    || content[index].type === "layoutSection";
  const unitCanvasY = (unitY - canvasRect.top) / scale;
  const ownerOwnsTopBand = ownerCanOwnTopBand && !owner.element.matches(".editor-box-fragment-viewport") && isContainerTopBand(
    box.top,
    unitCanvasY,
    resolvedUnit?.id !== content[index].id ? resolvedUnit?.ownBox.top : undefined,
  );
  // 段の中の空白 (その高さに段の行が無い)。隣の段の行や入れ物のつまみを、この段のガターへ出さない。
  const laneEmpty = !ownerOwnsTopBand && resolvedUnit?.emptyLane === true;
  const hoveredUnit = ownerOwnsTopBand || laneEmpty ? null : resolvedUnit;
  const hoveredBlock = hoveredUnit ? findBlock(document, hoveredUnit.id) : null;
  const hoveredLeft = innerLane
    ? (innerLane.laneLeft - canvasRect.left) / scale
    : hoveredUnit?.ownBox.left ?? box.left;
  const useProblemGutterLane = hoveredUnit?.insideProblemArea === true
    && (innerLane?.firstColumn ?? true);
  // 2 段目以降のガターは段間 (列境界と共有)。段の本文に寄せ、段間の中央 (列境界) を空けた幅で出す。
  const columnLaneWidthPx = hoveredUnit && innerLane?.firstColumn === false
    ? resolveColumnLaneWidthPx(typeof innerLane.dividerGap === "number" ? innerLane.dividerGap / scale : null)
    : undefined;
  const spaceAfterTarget = hoveredUnit && hoveredUnit.hasVisibleEnd !== false && hoveredBlock && rendersBlockSpaceAfter(hoveredBlock.type)
    ? {
        blockId: hoveredUnit.id,
        bottom: hoveredUnit.ownBox.bottom,
        left: hoveredLeft,
        insideProblemArea: useProblemGutterLane,
        ...(columnLaneWidthPx ? { columnLaneWidthPx } : {}),
        spaceAfterPx: blockSpaceAfterPx(hoveredBlock),
      }
    : null;

  return {
    box,
    nextBlockId: content[index + 1]?.id ?? null,
    // A continuation boundary is not a document insertion boundary.
    isAtomic: !owner.element.matches(".editor-box-fragment-viewport") && isAtomicTopLevelBlock(content[index]),
    aboveKind: owner.element.matches(".editor-box-fragment-viewport") ? "body" : neighborKind(index > 0 ? content[index - 1] : null),
    belowKind: owner.element.matches(".editor-box-fragment-viewport") ? "body" : neighborKind(content[index + 1] ?? null),
    gapEdge: gapAbove ? "bottom" : gapBelow ? "top" : null,
    spaceAfterTarget,
    useOwnerAffordance: ownerOwnsTopBand || hoveredUnit?.id === content[index].id,
    ...(laneEmpty ? { laneEmpty: true } : {}),
    unit: hoveredUnit
      ? {
        id: hoveredUnit.id,
        top: hoveredUnit.ownBox.top,
        bottom: hoveredUnit.ownBox.bottom,
        left: hoveredLeft,
        insideProblemArea: useProblemGutterLane,
        ...(columnLaneWidthPx ? { columnLaneWidthPx } : {}),
      }
      : null,
  };
}


/**
 * 左ガター／段間から、ポインタが属する内側レーンへ打つプローブの x。
 *
 * DOM は列の殻だけを測るため、行数には比例しない。まず外側グリッドで段間を右列へ帰属させ、
 * その列の子グリッドだけへ順に降りる。幅だけで最内側を選ぶと、同じ高さにある別レーンの
 * 入れ子段組が選ばれるため、兄弟レーンを探索対象へ入れない。
 */
export function neighborKind(block: SigmaBlock | null): BlockNeighborKind {
  if (!block) {
    return "none";
  }
  return isAtomicTopLevelBlock(block) ? "atomic" : "body";
}


/** A block a caret cannot step out of, so the gaps around it need their own way in. */
export function isAtomicTopLevelBlock(block: SigmaBlock): boolean {
  return block.type === "problem" || block.type === "boxBlock";
}


/**
 * ポインタの下の本文ブロック。**紙面の chrome を透かして** 探す。
 *
 * `elementFromPoint` は最前面の 1 枚しか返さない。ところが紙面には本文の上に敷かれた
 * 当たり判定つきの層がある — 代表がヘッダー / フッター帯 (`.page-running-editor-band`:
 * ダブルタップで直接編集に入るので `pointer-events` を持つ)。帯はページ余白の側にあるので
 * 普段は本文と重ならないが、**ブロック下余白を伸ばして下端が余白域へ入る**と重なる。
 * そこで 1 枚しか見ないと「ここにブロックは居ない」に倒れ、左ガターのつまみ・グリップ・＋ が
 * まるごと消える ＝ 伸ばした余白を掴み直して縮められない。
 *
 * なので重なり順に走査して、**最初にブロックへ解決できた 1 枚**を採る。紙面の外の何か
 * (ダイアログ・ポップオーバー) が覆っているときはそこで打ち切る — そこは「本文が隠れている」
 * が正しい (`canvas` の祖先は覆っているわけではないので素通りする)。
 */
export function resolveTopLevelBlockAtPoint(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
): { id: string; element: HTMLElement; isProblem: boolean } | null {
  for (const target of canvas.ownerDocument.elementsFromPoint(clientX, clientY)) {
    if (!canvas.contains(target)) {
      if (target.contains(canvas)) {
        continue;
      }
      return null;
    }
    const owner = resolveBlockOwnerOf(canvas, target);
    if (owner) {
      return owner;
    }
  }
  return null;
}


/** Walks out to the outermost block element, so a nested paragraph reports its column or box. */
export function resolveBlockOwnerOf(
  canvas: HTMLElement,
  target: Element,
): { id: string; element: HTMLElement; isProblem: boolean } | null {
  const viewport = target.closest<HTMLElement>(".editor-box-fragment-viewport");
  if (viewport) {
    const sourceId = viewport.dataset.boxSourceId;
    const source = sourceId ? Array.from(canvas.querySelectorAll<HTMLElement>(
      `[data-sigma-doc-id="${CSS.escape(sourceId)}"]`,
    )).find((element) => !element.closest(BLOCK_BOX_FRAGMENT_LAYER_SELECTOR)) : null;
    const owner = source ? resolveBlockOwnerOf(canvas, source) : null;
    return owner ? { ...owner, element: viewport } : null;
  }
  const problemArea = target.closest<HTMLElement>("[data-problem-id]");
  const problemId = problemArea?.getAttribute("data-problem-id");
  if (problemArea && problemId) {
    return { id: problemId, element: problemArea, isProblem: true };
  }

  let outermost: HTMLElement | null = null;
  let node: HTMLElement | null = target.closest<HTMLElement>("[data-sigma-doc-id]");
  while (node && node !== canvas) {
    if (node.hasAttribute("data-sigma-doc-id")) {
      outermost = node;
    }
    node = node.parentElement;
  }

  const id = outermost?.getAttribute("data-sigma-doc-id");
  return outermost && id ? { id, element: outermost, isProblem: false } : null;
}


/**
 * Vertical extent of the given top-level blocks, in canvas pixels. A problem has no element
 * of its own — its areas carry `data-problem-id`, so its box is the union of those. Blocks
 * scrolled out of the virtualized window are simply absent.
 */
export function measureTopLevelBlockBoxes(
  canvas: HTMLElement,
  content: readonly SigmaBlock[],
): TopLevelBlockBox[] {
  const boxes: TopLevelBlockBox[] = [];

  for (const block of content) {
    const selector = block.type === "problem"
      ? `[data-problem-id="${CSS.escape(block.id)}"]`
      : `[data-sigma-doc-id="${CSS.escape(block.id)}"]`;
    const box = toCanvasBox(
      block.id,
      Array.from(canvas.querySelectorAll<HTMLElement>(selector)),
      canvas,
    );
    if (box) {
      boxes.push(box);
    }
  }

  return boxes;
}


/**
 * 画面 px → アフォーダンス層の座標 (= 紙面のレイアウト px) の換算率。
 *
 * `.page-block-affordance-layer` は紙面の中にあるので、`top`/`left` に渡すのは
 * **レイアウト px**。一方 `getBoundingClientRect` は画面 px を返す。ページモードの拡大は
 * `.page-stack` の `transform: scale()` なので `getComputedStyle(...).zoom` は 1 のままで、
 * それで割っても換算にならない (100% 以外でアフォーダンスが紙面からずれる)。
 * 実測の比なら transform でも zoom でも同じ 1 本で効く。
 */
export function canvasLayoutScale(canvas: HTMLElement): number {
  const width = canvas.getBoundingClientRect().width;
  return canvas.offsetWidth > 0 && width > 0 ? width / canvas.offsetWidth : 1;
}


/** Union of the given elements' rects, expressed in canvas pixels. */
export function toCanvasBox(
  id: string,
  elements: readonly HTMLElement[],
  canvas: HTMLElement,
): TopLevelBlockBox | null {
  const canvasRect = canvas.getBoundingClientRect();
  const zoomScale = canvasLayoutScale(canvas);

  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const rect = visibleBlockClientRect(element);
    if (!rect) {
      continue;
    }
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }

  if (top === Number.POSITIVE_INFINITY) {
    return null;
  }

  return {
    id,
    top: (top - canvasRect.top) / zoomScale,
    bottom: (bottom - canvasRect.top) / zoomScale,
    left: (left - canvasRect.left) / zoomScale,
    right: (right - canvasRect.left) / zoomScale,
  };
}


export function getSelectionScopedBlockIds(
  target: Element | null,
  canvas: HTMLElement,
  fallbackBlockId: string,
): string[] {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return [fallbackBlockId];
  }

  const selector = `[data-sigma-doc-id="${CSS.escape(fallbackBlockId)}"]`;
  const fallbackElement = canvas.querySelector<HTMLElement>(selector);
  const container = fallbackElement?.parentElement;
  if (!fallbackElement || !container || (target && !canvas.contains(target))) {
    return [fallbackBlockId];
  }

  const range = selection.getRangeAt(0);
  const siblingElements = Array.from(container.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && !!element.dataset.sigmaDocId,
  );
  const siblingIds = siblingElements.map((element) => element.dataset.sigmaDocId!);
  const selectedIds: string[] = [];
  siblingElements.forEach((element) => {
    if (selectionContainsElement(range, element)) {
      selectedIds.push(element.dataset.sigmaDocId!);
    }
  });

  return pickContiguousSelectedSiblingIds(siblingIds, selectedIds, fallbackBlockId);
}


export function selectionContainsElement(range: Range, element: HTMLElement): boolean {
  try {
    return range.intersectsNode(element);
  } catch {
    return false;
  }
}