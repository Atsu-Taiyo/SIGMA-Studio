import {
  ANCHOR_PAGE_STRIDE_PX,
  getShapeBounds,
} from "@/features/drawing";
import type {
  BlockExtent,
  MeasuredBlock,
  MeasuredLine,
} from "@/features/drawing";
import { A4_PAGE_PX } from "@/features/document";
import { emptyProblemAreaEditorBlockId } from "@/features/rendering/core";
import { isProblemAreaKind } from "@/features/text-editing";

import type { OverlayAnchor, OverlayPoint, OverlayShape } from "./types";
export {
  ANCHOR_PAGE_STRIDE_PX,
  anchorLineExistsInBlock,
  ensureShapeAnchorDx,
  pageIndexForY,
  resolveShapeAnchorPositions,
  resolveShapePosition,
  resolveShapesPosition,
  resolveShapesY,
  resolveShapeY,
} from "@/features/drawing";
export type {
  BlockExtent,
  MeasuredBlock,
  MeasuredLine,
  OverlayBlockGapMap,
} from "@/features/drawing";
import { countPerformanceEvent } from "@/lib/performance";

const LINE_GROUP_TOLERANCE_PX = 2;
const COLUMN_PROBE_TOLERANCE_PX = 0.5;
/** Every element that carries block geometry a figure can be anchored to. */
const MEASURABLE_BLOCK_SELECTOR = "[data-sigma-doc-id], [data-page-block]";
const ANCHOR_RULE_MIN_WIDTH_PX = 48;
const ANCHOR_RULE_FALLBACK_LEFT_PX = 24;
const ANCHOR_RULE_FALLBACK_WIDTH_PX = 120;

/**
 * A position the body-anchor rule can sit on. A figure hangs *below* the line
 * it is anchored to, so the boundary is the gap that follows that line — never
 * a position that cuts a paragraph in half.
 */
export interface AnchorBoundary {
  blockId: string;
  /** Body line the figure hangs from; absent for whole-block anchors. */
  lineIndex?: number;
  y: number;
  left: number;
  width: number;
}

interface AnchorColumn {
  index: number;
  left: number;
  right: number;
  center: number;
  blockIds: Set<string>;
}

interface AnchorBlockOrder {
  block: MeasuredBlock;
  index: number;
}

interface AnchorReadOrderKey {
  page: number;
  column: number;
  localY: number;
  top: number;
  index: number;
}

function blocksShareColumn(a: MeasuredBlock, b: MeasuredBlock): boolean {
  if (a.left === undefined || b.left === undefined) {
    return true;
  }
  const aWidth = a.width ?? 0;
  const bWidth = b.width ?? 0;
  const tolerance = Math.max(4, Math.min(aWidth || 0, bWidth || 0) * 0.08);
  return Math.abs(a.left - b.left) <= tolerance;
}

function pickAnchorLine(shapeTop: number, shapeY: number, block: MeasuredBlock): Extract<OverlayAnchor, { type: "block" }>["line"] {
  const lines = block.lines;
  if (!lines?.length) {
    return undefined;
  }

  const sorted = [...lines].sort((a, b) => a.top - b.top);
  let chosen = sorted[0];
  for (const line of sorted) {
    if (line.top <= shapeTop + 0.5) {
      chosen = line;
    } else {
      break;
    }
  }

  return {
    index: chosen.index,
    dy: shapeY - chosen.top,
  };
}

export function pickShapeAnchor(
  shape: Pick<OverlayShape, "x" | "y" | "anchor">,
  parent: OverlayShape,
): Extract<OverlayAnchor, { type: "shape" }> {
  const existingAnchor = shape.anchor?.type === "shape" && shape.anchor.shapeId === parent.id
    ? shape.anchor
    : null;
  const parentBounds = getShapeBounds(parent);
  const rx = existingAnchor?.rx;
  const ry = existingAnchor?.ry;
  const baseX = typeof rx === "number" ? parentBounds.x + parentBounds.w * rx : parent.x;
  const baseY = typeof ry === "number" ? parentBounds.y + parentBounds.h * ry : parent.y;

  return {
    type: "shape",
    shapeId: parent.id,
    dx: shape.x - baseX,
    dy: shape.y - baseY,
    ...(rx === undefined ? {} : { rx }),
    ...(ry === undefined ? {} : { ry }),
  };
}

/**
 * Choose the block directly above the shape's top edge. If the shape sits above
 * every block, it anchors to the topmost block. dy is stored against the
 * shape's own origin (`shapeY`) so resolution is a plain `blockTop + dy`.
 */
export function pickBlockAnchor(
  shapeTop: number,
  shapeY: number,
  measuredBlocks: MeasuredBlock[],
  shapeProbeX?: number,
  shapeX?: number,
): OverlayAnchor {
  if (measuredBlocks.length === 0) {
    return { type: "page" };
  }

  // An anchor is stored in the document, so it may only name a block the document has.
  // Editor-only placeholder blocks stay in the measurement (they paginate, and figures already
  // anchored to them still resolve) but are not offered as a target. Falling back to the full
  // set when that leaves nothing beats returning a page anchor: losing the block relationship
  // stops the figure following text reflow at all.
  const documentBlocks = measuredBlocks.filter((block) => !block.derived);
  const blocks = documentBlocks.length > 0 ? documentBlocks : measuredBlocks;

  const anchorColumns = getAnchorColumns(blocks);
  const shapeColumn = Number.isFinite(shapeProbeX)
    ? findColumnForProbeX(shapeProbeX!, anchorColumns)
    : undefined;
  const columnCandidates = shapeColumn
    ? blocks.filter((block) => shapeColumn.blockIds.has(block.id))
    : [];
  const candidates = columnCandidates.length > 0 ? columnCandidates : blocks;
  const chosen = pickBlockByReadOrder(shapeTop, candidates, anchorColumns, shapeColumn?.index);

  const dx = chosen.left === undefined || shapeX === undefined ? undefined : shapeX - chosen.left;
  const line = pickAnchorLine(shapeTop, shapeY, chosen);
  return {
    type: "block",
    blockId: chosen.id,
    dy: shapeY - chosen.top,
    ...(dx === undefined ? {} : { dx }),
    ...(line === undefined ? {} : { line }),
  };
}

/**
 * Every boundary a figure can hang from inside one block, in reading order.
 * Each entry is the gap *after* one body line, so the rule always lands in
 * whitespace; the last line reports the block's own bottom edge, which puts the
 * rule in the paragraph gap instead of tight under the glyphs.
 */
export function getBlockAnchorBoundaries(block: MeasuredBlock): AnchorBoundary[] {
  const left = getMeasuredBlockLeft(block);
  const width = getMeasuredBlockWidth(block);
  const blockBottom = block.top + (block.height ?? 0);
  const lines = [...(block.lines ?? [])].sort((a, b) => a.top - b.top);
  if (lines.length === 0) {
    return [{ blockId: block.id, y: blockBottom, left, width }];
  }

  return lines.map((line, index) => ({
    blockId: block.id,
    lineIndex: line.index,
    y: index === lines.length - 1
      ? Math.max(line.top + line.height, blockBottom)
      : line.top + line.height,
    left,
    width,
  }));
}

/** Where an existing block anchor's rule is drawn. */
export function getAnchorBoundaryForAnchor(
  anchor: Extract<OverlayAnchor, { type: "block" }>,
  block: MeasuredBlock,
): AnchorBoundary {
  const boundaries = getBlockAnchorBoundaries(block);
  if (!anchor.line) {
    // Whole-block anchors resolve against the block's top edge, so their
    // boundary is the gap before the block rather than after a line.
    return {
      blockId: block.id,
      y: block.top,
      left: getMeasuredBlockLeft(block),
      width: getMeasuredBlockWidth(block),
    };
  }

  return boundaries.find((boundary) => boundary.lineIndex === anchor.line?.index)
    ?? boundaries[boundaries.length - 1];
}

/**
 * The one boundary a figure at `shapeTop` would hang from inside `block`.
 * Mirrors the line {@link pickBlockAnchor} chooses, so a snapped drop survives
 * the re-anchor pass that runs after every overlay change.
 */
export function getShapeAnchorBoundaryInBlock(block: MeasuredBlock, shapeTop: number): AnchorBoundary {
  const boundaries = getBlockAnchorBoundaries(block);
  const lines = [...(block.lines ?? [])].sort((a, b) => a.top - b.top);
  if (lines.length === 0) {
    return boundaries[0];
  }

  let chosen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].top <= shapeTop + 0.5) {
      chosen = index;
    } else {
      break;
    }
  }
  return boundaries[chosen];
}

/**
 * Snap a dragged anchor rule to the nearest block in the pointer's column.
 * A drag picks the *block*; which line inside it the figure hangs from follows
 * from the figure's own position, so the rule can only land on one boundary per
 * block. That keeps the granularity users see identical to what is persisted.
 */
export function pickAnchorBoundaryAtPoint(
  point: OverlayPoint,
  blocks: MeasuredBlock[],
  shapeTop: number,
): AnchorBoundary | undefined {
  if (blocks.length === 0) {
    return undefined;
  }

  const anchorColumns = getAnchorColumns(blocks);
  const column = Number.isFinite(point.x) ? findColumnForProbeX(point.x, anchorColumns) : undefined;
  const columnBlocks = column ? blocks.filter((block) => column.blockIds.has(block.id)) : [];
  const candidates = columnBlocks.length > 0 ? columnBlocks : blocks;

  let best: AnchorBoundary | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const block of candidates) {
    const boundary = getShapeAnchorBoundaryInBlock(block, shapeTop);
    const distance = Math.abs(boundary.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = boundary;
    }
  }

  return best;
}

/** Build the anchor a snapped boundary stands for. The shape itself never moves. */
export function buildBlockAnchorAtBoundary(
  boundary: AnchorBoundary,
  block: MeasuredBlock,
  shapeY: number,
  shapeX?: number,
): Extract<OverlayAnchor, { type: "block" }> {
  const line = boundary.lineIndex === undefined
    ? undefined
    : block.lines?.find((item) => item.index === boundary.lineIndex);
  const dx = block.left === undefined || shapeX === undefined ? undefined : shapeX - block.left;
  return {
    type: "block",
    blockId: block.id,
    dy: shapeY - block.top,
    ...(dx === undefined ? {} : { dx }),
    ...(line === undefined ? {} : { line: { index: line.index, dy: shapeY - line.top } }),
  };
}

function getMeasuredBlockLeft(block: MeasuredBlock): number {
  return typeof block.left === "number" ? block.left : ANCHOR_RULE_FALLBACK_LEFT_PX;
}

function getMeasuredBlockWidth(block: MeasuredBlock): number {
  return Math.max(ANCHOR_RULE_MIN_WIDTH_PX, block.width ?? ANCHOR_RULE_FALLBACK_WIDTH_PX);
}

function pickBlockByReadOrder(
  shapeTop: number,
  blocks: MeasuredBlock[],
  anchorColumns: AnchorColumn[],
  shapeColumnIndex?: number,
): MeasuredBlock {
  const ordered = sortBlocksForAnchorOrder(blocks, anchorColumns);
  if (ordered.length === 0) {
    return blocks[0];
  }

  if (anchorColumns.length <= 1) {
    let chosen = ordered[0];
    for (const block of ordered) {
      if (block.top <= shapeTop) {
        chosen = block;
      } else {
        break;
      }
    }
    return chosen;
  }

  const shapePage = pageKeyForY(shapeTop);
  const shapeKey: AnchorReadOrderKey = {
    page: shapePage.page,
    column: shapeColumnIndex ?? Number.MAX_SAFE_INTEGER,
    localY: shapePage.localY,
    top: shapeTop,
    index: Number.MAX_SAFE_INTEGER,
  };
  let chosen = ordered[0];
  for (let index = 0; index < ordered.length; index += 1) {
    const block = ordered[index];
    const blockKey = getBlockReadOrderKey(block, index, anchorColumns);
    if (compareReadOrderKeys(blockKey, shapeKey) <= 0) {
      chosen = block;
    } else {
      break;
    }
  }
  return chosen;
}

function sortBlocksForAnchorOrder(blocks: MeasuredBlock[], anchorColumns = getAnchorColumns(blocks)): MeasuredBlock[] {
  if (anchorColumns.length <= 1) {
    return [...blocks].sort((a, b) => a.top - b.top);
  }

  return blocks
    .map((block, index): AnchorBlockOrder => ({ block, index }))
    .sort((a, b) => compareReadOrderKeys(
      getBlockReadOrderKey(a.block, a.index, anchorColumns),
      getBlockReadOrderKey(b.block, b.index, anchorColumns),
    ))
    .map((item) => item.block);
}

function getBlockReadOrderKey(block: MeasuredBlock, index: number, anchorColumns: AnchorColumn[]): AnchorReadOrderKey {
  const page = pageKeyForY(block.top);
  return {
    page: page.page,
    column: getBlockColumnIndex(block, anchorColumns) ?? 0,
    localY: page.localY,
    top: block.top,
    index,
  };
}

function compareReadOrderKeys(a: AnchorReadOrderKey, b: AnchorReadOrderKey): number {
  return a.page - b.page ||
    a.column - b.column ||
    a.localY - b.localY ||
    a.top - b.top ||
    a.index - b.index;
}

function pageKeyForY(y: number): { page: number; localY: number } {
  const page = Math.max(0, Math.floor((y + COLUMN_PROBE_TOLERANCE_PX) / ANCHOR_PAGE_STRIDE_PX));
  return {
    page,
    localY: y - page * ANCHOR_PAGE_STRIDE_PX,
  };
}

function getAnchorColumns(blocks: MeasuredBlock[]): AnchorColumn[] {
  const columns: Array<{ representative: MeasuredBlock; left: number; right: number; blockIds: Set<string> }> = [];

  for (const block of blocks) {
    if (typeof block.left !== "number" || typeof block.width !== "number") {
      continue;
    }

    const match = columns.find((column) => blocksShareColumn(column.representative, block));
    if (match) {
      match.left = Math.min(match.left, block.left);
      match.right = Math.max(match.right, block.left + block.width);
      match.blockIds.add(block.id);
      continue;
    }

    columns.push({
      representative: block,
      left: block.left,
      right: block.left + block.width,
      blockIds: new Set([block.id]),
    });
  }

  return columns
    .sort((a, b) => a.left - b.left)
    .map((column, index) => ({
      index,
      left: column.left,
      right: column.right,
      center: (column.left + column.right) / 2,
      blockIds: column.blockIds,
    }));
}

function findColumnForProbeX(probeX: number, columns: AnchorColumn[]): AnchorColumn | undefined {
  if (columns.length <= 1) {
    return undefined;
  }

  const containing = columns
    .filter((column) => probeX >= column.left - COLUMN_PROBE_TOLERANCE_PX && probeX <= column.right + COLUMN_PROBE_TOLERANCE_PX)
    .sort((a, b) => Math.abs(a.center - probeX) - Math.abs(b.center - probeX));
  if (containing[0]) {
    return containing[0];
  }

  return [...columns].sort((a, b) => Math.abs(a.center - probeX) - Math.abs(b.center - probeX))[0];
}

function getBlockColumnIndex(block: MeasuredBlock, columns: AnchorColumn[]): number | undefined {
  return columns.find((column) => column.blockIds.has(block.id))?.index;
}

/**
 * Re-anchor figures whose anchor block was just deleted. Each affected shape
 * moves UP by the height of the deleted content at/above it (the mirror of how
 * inserting a newline pushes it down), then re-anchors to a surviving block at
 * the new position.
 *
 * `preMeasure` is block geometry (canvas coords) from BEFORE the deletion
 * (id -> { top, height }); `orderedPost` is the surviving blocks measured AFTER
 * the reflow. Page-anchored shapes, and shapes whose anchor block survived, are
 * returned unchanged. When the anchor block has no pre-deletion geometry the
 * shape is left as-is (safe no-op).
 */
export function reanchorAfterDeletion<T extends Pick<OverlayShape, "y" | "anchor"> & Partial<Pick<OverlayShape, "x">>>(
  shapes: T[],
  deletedIds: ReadonlySet<string>,
  preMeasure: Map<string, BlockExtent>,
  orderedPost: MeasuredBlock[],
): { shapes: T[]; changed: boolean } {
  let changed = false;

  const next = shapes.map((shape) => {
    const anchor = shape.anchor;
    if (!anchor || anchor.type !== "block" || !deletedIds.has(anchor.blockId)) {
      return shape;
    }

    const pre = preMeasure.get(anchor.blockId);
    if (!pre) {
      return shape;
    }

    const fOld = pre.top + anchor.dy;
    let hDeleted = 0;
    for (const id of deletedIds) {
      const measure = preMeasure.get(id);
      if (!measure) {
        continue;
      }
      // The anchor block always counts; other deleted blocks count only when
      // they sat above the figure (deletions below it must not move it up).
      if (id === anchor.blockId || measure.top < fOld) {
        hDeleted += measure.height;
      }
    }

    const fNew = fOld - hDeleted;
    const shapeX = typeof shape.x === "number" ? shape.x : undefined;
    changed = true;
    const nextAnchor = pickBlockAnchor(fNew, fNew, orderedPost, shapeX, shapeX);
    return {
      ...shape,
      y: fNew,
      anchor: nextAnchor.type === "block" && anchor.reserveSpace !== undefined
        ? { ...nextAnchor, reserveSpace: anchor.reserveSpace }
        : nextAnchor,
    };
  });

  return { shapes: changed ? next : shapes, changed };
}

/**
 * Measure block tops in overlay coordinates. `pageRectEl` is an element whose
 * bounding rect spans the overlay coordinate space (the overlay canvas / preview
 * layer), `scope` is the node to query for `[data-sigma-doc-id]` blocks, and
 * `coordHeight` is the unzoomed height that `pageRectEl` represents (one A4 page
 * for a single page, or the full document height for the continuous canvas).
 */
export function measureBlockTops(
  pageRectEl: Element,
  scope: ParentNode,
  coordHeight: number = A4_PAGE_PX.height,
  coordWidth: number = A4_PAGE_PX.width,
): { tops: Map<string, number>; rects: Map<string, MeasuredBlock>; ordered: MeasuredBlock[] } {
  // 本文を全件歩く計測。page canvas 側の実測を使えている間はここに来ない。
  countPerformanceEvent("Overlay.measureBlockTops");
  const tops = new Map<string, number>();
  const rects = new Map<string, MeasuredBlock>();
  const ordered: MeasuredBlock[] = [];

  const pageRect = pageRectEl.getBoundingClientRect();
  if (pageRect.height <= 0) {
    return { tops, rects, ordered };
  }

  const scaleY = coordHeight / pageRect.height;
  const scaleX = coordWidth / pageRect.width;
  const seen = new Set<string>();
  scope.querySelectorAll(MEASURABLE_BLOCK_SELECTOR).forEach((el) => {
    const id = el.getAttribute("data-sigma-doc-id") ?? el.id;
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    const rect = el.getBoundingClientRect();
    const top = (rect.top - pageRect.top) * scaleY;
    const left = (rect.left - pageRect.left) * scaleX;
    const containerId = findMeasurableContainerId(el, id);
    const measured = {
      id,
      top,
      left,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
      lines: measureElementLineBoxes(el, pageRect, scaleX, scaleY),
      ...(containerId ? { containerId } : {}),
      ...(isEditorOnlyBlockElement(el, id) ? { derived: true } : {}),
    };
    tops.set(id, top);
    rects.set(id, measured);
    ordered.push(measured);
  });

  ordered.sort((a, b) => a.top - b.top);
  return { tops, rects, ordered };
}

/**
 * Whether this block exists only because the editor needs something to type into.
 *
 * An empty problem area renders one placeholder paragraph whose id is derived from the problem
 * and the area rather than stored (`emptyProblemAreaEditorBlockId`). It is a real block for
 * layout, but naming it in a persisted overlay anchor points at an id no SigmaDoc contains — every
 * consumer that rebuilds the body from the document (the print/PDF path included) then finds
 * nothing to hang the figure on and drops it.
 *
 * Derived through the same id builder rather than by matching the id's shape, so a real block that
 * happens to be named `…_lead_empty` is not mistaken for one.
 */
export function isEditorOnlyBlockElement(element: Element, id: string): boolean {
  const areaElement = element.closest("[data-problem-area][data-problem-id]");
  const problemId = areaElement?.getAttribute("data-problem-id");
  const area = areaElement?.getAttribute("data-problem-area") ?? null;
  return Boolean(
    problemId && isProblemAreaKind(area) && emptyProblemAreaEditorBlockId(problemId, area) === id,
  );
}

/**
 * The id of the nearest measured block enclosing `element` (a list for its
 * items, a box block for its children, a problem area for its blocks), or
 * undefined at the top level. A `[data-page-block]` wrapper and the block it
 * wraps share one id, so same-id ancestors are skipped: a block is never its
 * own container.
 */
export function findMeasurableContainerId(element: Element, id: string): string | undefined {
  let ancestor = element.parentElement?.closest(MEASURABLE_BLOCK_SELECTOR) ?? null;
  while (ancestor) {
    const ancestorId = ancestor.getAttribute("data-sigma-doc-id") ?? ancestor.id;
    if (ancestorId && ancestorId !== id) {
      return ancestorId;
    }
    ancestor = ancestor.parentElement?.closest(MEASURABLE_BLOCK_SELECTOR) ?? null;
  }
  return undefined;
}

export function measureElementLineBoxes(
  element: Element,
  referenceRect: Pick<DOMRect, "top" | "left">,
  scaleX: number,
  scaleY: number,
): MeasuredLine[] {
  const rects = getElementContentRects(element);
  const lineGroups = groupLineRects(rects.length > 0 ? rects : [element.getBoundingClientRect()]);

  return lineGroups.map((line, index) => ({
    index,
    top: (line.top - referenceRect.top) * scaleY,
    left: (line.left - referenceRect.left) * scaleX,
    width: Math.max(0, (line.right - line.left) * scaleX),
    height: Math.max(0, (line.bottom - line.top) * scaleY),
  }));
}

/**
 * Convert glyph rectangles into safe visual-line boundaries. `Range#getClientRects`
 * reports ink/glyph boxes, not the CSS line box; clipping exactly at `top + height`
 * is therefore vulnerable to rounding and can expose half a glyph on the next page.
 * The whitespace midpoint before the following line is a stable cut position.
 */
export function getMeasuredLineBreakOffsets(
  lines: readonly Pick<MeasuredLine, "height" | "top">[],
  referenceTop = 0,
): number[] {
  const ordered = [...lines]
    .filter((line) => Number.isFinite(line.top) && Number.isFinite(line.height) && line.height > 0)
    .sort((left, right) => left.top - right.top || left.height - right.height);
  return ordered.map((line, index) => {
    const bottom = line.top + line.height;
    const nextTop = ordered[index + 1]?.top;
    const boundary = nextTop !== undefined && nextTop > bottom
      ? bottom + (nextTop - bottom) / 2
      : bottom;
    return boundary - referenceTop;
  });
}

function getElementContentRects(element: Element): DOMRect[] {
  // Selecting a whole quote/list also returns the rectangles of its paragraph
  // containers. A paragraph spanning many lines then overlaps every glyph and
  // collapses them into one enormous "line". Measure those children separately,
  // retaining inline math rectangles within each paragraph.
  if (Array.from(element.children).some((child) =>
    child.matches("p, h1, h2, h3, h4, h5, h6, ol, ul, li, blockquote, pre"),
  )) {
    return Array.from(element.childNodes).flatMap((child) => child.nodeType === 1
      ? getElementContentRects(child as Element)
      : getNodeContentRects(child));
  }
  return getNodeContentRects(element);
}

function getNodeContentRects(node: Node): DOMRect[] {
  const document = node.ownerDocument;
  if (!document) return [];
  const range = document.createRange();
  try {
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  } finally {
    range.detach();
  }
}

function groupLineRects(rects: DOMRect[]): Array<{ top: number; right: number; bottom: number; left: number }> {
  const groups: Array<{ top: number; right: number; bottom: number; left: number }> = [];
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  let firstActiveGroup = 0;

  for (const rect of sorted) {
    // `groups.find` で全既存行を毎回なめると、1 万行のコードで約 1 億回比較になる。
    // top 順に処理しているので、現在の rect より完全に上へ抜けた行は今後も一致しない。
    // 候補窓から一度だけ外し、現在付近の数行だけを比較する。
    while (
      firstActiveGroup < groups.length &&
      lineGroupIsBeforeRect(groups[firstActiveGroup], rect)
    ) {
      firstActiveGroup += 1;
    }
    const group = groups
      .slice(firstActiveGroup)
      .find((candidate) => rectMatchesLineGroup(rect, candidate));
    if (!group) {
      groups.push({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
      continue;
    }

    group.top = Math.min(group.top, rect.top);
    group.right = Math.max(group.right, rect.right);
    group.bottom = Math.max(group.bottom, rect.bottom);
    group.left = Math.min(group.left, rect.left);
  }

  return groups.sort((a, b) => a.top - b.top || a.left - b.left);
}

function lineGroupIsBeforeRect(
  group: { top: number; bottom: number },
  rect: Pick<DOMRect, "top" | "bottom" | "height">,
): boolean {
  const groupCenterY = (group.top + group.bottom) / 2;
  const rectCenterY = (rect.top + rect.bottom) / 2;
  return group.bottom < rect.top && rectCenterY - groupCenterY > LINE_GROUP_TOLERANCE_PX;
}

function rectMatchesLineGroup(
  rect: DOMRect,
  group: { top: number; bottom: number },
): boolean {
  const rectCenterY = (rect.top + rect.bottom) / 2;
  const groupCenterY = (group.top + group.bottom) / 2;
  if (Math.abs(rectCenterY - groupCenterY) <= LINE_GROUP_TOLERANCE_PX) {
    return true;
  }

  const overlap = Math.min(rect.bottom, group.bottom) - Math.max(rect.top, group.top);
  const minHeight = Math.min(rect.height, group.bottom - group.top);
  return overlap > Math.max(1, minHeight * 0.45);
}
