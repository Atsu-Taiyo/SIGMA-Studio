import type {
  OverlayAnchor,
  OverlayBounds,
  OverlayShape,
} from "@/features/document";

const COLUMN_PROBE_TOLERANCE_PX = 0.5;
const A4_PAGE_HEIGHT_PX = (297 * 96) / 25.4;
const CONTINUOUS_PAGE_GAP_PX = 36;

/**
 * Legacy/default continuous-canvas stride. Custom page layouts should pass
 * their own page height + gap to {@link pageIndexForY}.
 */
export const ANCHOR_PAGE_STRIDE_PX = A4_PAGE_HEIGHT_PX + CONTINUOUS_PAGE_GAP_PX;

export function pageIndexForY(
  y: number,
  pageStridePx: number = ANCHOR_PAGE_STRIDE_PX,
): { pageIndex: number; localY: number } {
  const pageIndex = Math.max(0, Math.floor(y / pageStridePx));
  return { pageIndex, localY: y - pageIndex * pageStridePx };
}

export interface MeasuredBlock {
  id: string;
  top: number;
  left?: number;
  width?: number;
  height?: number;
  lines?: MeasuredLine[];
  /**
   * Id of the block this one is nested in (list → items, box block → children,
   * problem area → blocks). Absent for top-level blocks. Line-overflow
   * resolution only follows siblings, so a container's line boxes are never
   * counted twice alongside its children's.
   */
  containerId?: string;
  /**
   * The block exists only in the editor: its id is derived at render time and is
   * absent from the SigmaDoc (the placeholder paragraph an empty problem area
   * needs to stay editable — `emptyProblemAreaEditorBlockId`).
   *
   * It still paginates and still resolves, but a *stored* anchor must never name
   * it: nothing in the document carries that id, so every consumer that rebuilds
   * the body from SigmaDoc — the print/PDF path included — drops the figure.
   */
  derived?: boolean;
}

export interface BlockExtent {
  top: number;
  height: number;
  left?: number;
  width?: number;
}

export interface MeasuredLine {
  index: number;
  top: number;
  height: number;
  left?: number;
  width?: number;
}

export type OverlayBlockGapMap = Readonly<Record<string, number>>;

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

/**
 * Continuous-canvas y for a shape. Block-anchored shapes derive y from the
 * measured block; page anchors and dangling block anchors keep their cached y.
 */
export function resolveShapeY(
  shape: Pick<OverlayShape, "y" | "anchor">,
  blockTops: Map<string, number>,
  blockGaps: OverlayBlockGapMap = {},
): number {
  if (shape.anchor?.type === "block") {
    const top = blockTops.get(shape.anchor.blockId);
    if (top !== undefined) {
      return top - getAnchorReserveGap(shape.anchor, blockGaps) + shape.anchor.dy;
    }
  }
  return shape.y;
}

export function resolveShapePosition<T extends Pick<OverlayShape, "x" | "y" | "anchor">>(
  shape: T,
  blockRects: ReadonlyMap<string, MeasuredBlock>,
  blockGaps: OverlayBlockGapMap = {},
): T {
  return resolveShapePositionWithOrder(
    shape,
    blockRects,
    sortBlocksForAnchorOrder(Array.from(blockRects.values())),
    blockGaps,
  );
}

export function resolveShapesPosition<T extends OverlayShape>(
  shapes: T[],
  blockRects: ReadonlyMap<string, MeasuredBlock>,
  blockGaps: OverlayBlockGapMap = {},
): T[] {
  const orderedBlocks = sortBlocksForAnchorOrder(Array.from(blockRects.values()));
  const blockResolved = shapes.map((shape) => (
    resolveShapePositionWithOrder(shape, blockRects, orderedBlocks, blockGaps)
  ));
  return resolveShapeAnchorPositions(blockResolved);
}

export function resolveShapesY<T extends Pick<OverlayShape, "y" | "anchor">>(
  shapes: T[],
  blockTops: Map<string, number>,
  blockGaps: OverlayBlockGapMap = {},
): T[] {
  return shapes.map((shape) => {
    const y = resolveShapeY(shape, blockTops, blockGaps);
    return y === shape.y ? shape : { ...shape, y };
  });
}

/**
 * Resolves shape-to-shape anchors without renderer or DOM state. SigmaDoc box
 * shapes expose their semantic bounds through x/y and props.w/props.h, which
 * keeps graph-owned labels and other anchored children usable in headless
 * preview and export paths.
 */
export function resolveShapeAnchorPositions<T extends OverlayShape>(shapes: T[]): T[] {
  const sourceById = new Map(shapes.map((shape) => [shape.id, shape]));
  const resolvedById = new Map<string, T>();
  const resolvingIds = new Set<string>();

  const resolveShape = (shape: T): T => {
    const cached = resolvedById.get(shape.id);
    if (cached) {
      return cached;
    }

    if (shape.anchor?.type !== "shape") {
      resolvedById.set(shape.id, shape);
      return shape;
    }

    const parent = sourceById.get(shape.anchor.shapeId);
    if (!parent || parent.id === shape.id || resolvingIds.has(shape.id)) {
      resolvedById.set(shape.id, shape);
      return shape;
    }

    resolvingIds.add(shape.id);
    const resolvedParent = resolveShape(parent);
    resolvingIds.delete(shape.id);

    const point = resolveShapeAnchorPoint(shape.anchor, resolvedParent);
    const next = point.x === shape.x && point.y === shape.y
      ? shape
      : { ...shape, x: point.x, y: point.y };
    resolvedById.set(shape.id, next as T);
    return next as T;
  };

  let changed = false;
  const next = shapes.map((shape) => {
    const resolved = resolveShape(shape);
    changed ||= resolved !== shape;
    return resolved;
  });
  return changed ? next : shapes;
}

export function anchorLineExistsInBlock(
  anchor: Extract<OverlayAnchor, { type: "block" }>,
  block: MeasuredBlock,
): boolean {
  return resolveAnchorLineTop(anchor, block) !== undefined;
}

export function ensureShapeAnchorDx<T extends Pick<OverlayShape, "x" | "anchor">>(
  shapes: T[],
  blockRects: ReadonlyMap<string, MeasuredBlock>,
): { shapes: T[]; changed: boolean } {
  let changed = false;

  const next = shapes.map((shape) => {
    const anchor = shape.anchor;
    if (anchor?.type !== "block" || typeof anchor.dx === "number") {
      return shape;
    }

    const rect = blockRects.get(anchor.blockId);
    if (typeof rect?.left !== "number") {
      return shape;
    }

    changed = true;
    return {
      ...shape,
      anchor: {
        ...anchor,
        dx: shape.x - rect.left,
      },
    };
  });

  return { shapes: changed ? next : shapes, changed };
}

function resolveShapePositionWithOrder<T extends Pick<OverlayShape, "x" | "y" | "anchor">>(
  shape: T,
  blockRects: ReadonlyMap<string, MeasuredBlock>,
  orderedBlocks: MeasuredBlock[],
  blockGaps: OverlayBlockGapMap,
): T {
  if (shape.anchor?.type !== "block") {
    return shape;
  }

  const rect = blockRects.get(shape.anchor.blockId);
  if (!rect) {
    return shape;
  }

  const target = resolveAnchorLineTarget(shape.anchor, rect, orderedBlocks);
  const anchorBlock = target?.block ?? rect;
  const reserveGap = getAnchorReserveGap(shape.anchor, blockGaps);
  const x = typeof shape.anchor.dx === "number" && typeof anchorBlock.left === "number"
    ? anchorBlock.left + shape.anchor.dx
    : shape.x;
  const y = target === undefined || !shape.anchor.line
    ? rect.top - reserveGap + shape.anchor.dy
    : target.line.top - reserveGap + shape.anchor.line.dy;

  return x === shape.x && y === shape.y ? shape : { ...shape, x, y };
}

function getAnchorReserveGap(
  anchor: Extract<OverlayAnchor, { type: "block" }>,
  blockGaps: OverlayBlockGapMap,
): number {
  if (anchor.reserveSpace !== true) {
    return 0;
  }
  const gap = blockGaps[anchor.blockId];
  return typeof gap === "number" && Number.isFinite(gap) ? Math.max(0, gap) : 0;
}

function resolveAnchorLineTop(
  anchor: Extract<OverlayAnchor, { type: "block" }>,
  block: MeasuredBlock,
): number | undefined {
  if (!anchor.line || !block.lines?.length) {
    return undefined;
  }

  return block.lines.find((line) => line.index === anchor.line?.index)?.top;
}

function resolveAnchorLineTarget(
  anchor: Extract<OverlayAnchor, { type: "block" }>,
  block: MeasuredBlock,
  orderedBlocks: MeasuredBlock[],
): { block: MeasuredBlock; line: MeasuredLine } | undefined {
  if (!anchor.line || !block.lines?.length) {
    return undefined;
  }

  const directLine = block.lines.find((line) => line.index === anchor.line?.index);
  if (directLine) {
    return { block, line: directLine };
  }

  let remainingLineIndex = anchor.line.index - block.lines.length;
  if (remainingLineIndex < 0) {
    return undefined;
  }

  const blockIndex = orderedBlocks.findIndex((item) => item.id === block.id);
  if (blockIndex < 0) {
    return undefined;
  }

  for (const candidate of orderedBlocks.slice(blockIndex + 1)) {
    // Only siblings: a container (a list, a box block) reports the same line
    // boxes as its children, so mixing the two levels would consume each
    // overflowed line twice and land the figure too far down the page.
    if (candidate.containerId !== block.containerId) {
      continue;
    }
    if (!blocksShareColumn(block, candidate)) {
      continue;
    }
    const lines = candidate.lines ?? [];
    if (remainingLineIndex < lines.length) {
      return { block: candidate, line: lines[remainingLineIndex] };
    }
    remainingLineIndex -= lines.length;
  }

  return undefined;
}

function resolveShapeAnchorPoint(
  anchor: Extract<OverlayAnchor, { type: "shape" }>,
  parent: OverlayShape,
): { x: number; y: number } {
  const parentBounds = getShapeAnchorReferenceBounds(parent);
  const baseX = typeof anchor.rx === "number"
    ? parentBounds.x + parentBounds.w * anchor.rx
    : parent.x;
  const baseY = typeof anchor.ry === "number"
    ? parentBounds.y + parentBounds.h * anchor.ry
    : parent.y;
  return {
    x: baseX + anchor.dx,
    y: baseY + anchor.dy,
  };
}

function getShapeAnchorReferenceBounds(shape: OverlayShape): OverlayBounds {
  if (
    shape.type === "group" ||
    shape.type === "geo" ||
    shape.type === "image" ||
    shape.type === "callout" ||
    shape.type === "graph2dShape" ||
    shape.type === "graph3dShape" ||
    shape.type === "tableShape" ||
    shape.type === "chartShape"
  ) {
    return {
      x: shape.x,
      y: shape.y,
      w: shape.props.w,
      h: shape.props.h,
    };
  }

  if (shape.type === "arc") {
    const fallback = Math.max(0.5, shape.props.r);
    const rx = typeof shape.props.rx === "number" && Number.isFinite(shape.props.rx)
      ? Math.max(0.5, shape.props.rx)
      : fallback;
    const ry = typeof shape.props.ry === "number" && Number.isFinite(shape.props.ry)
      ? Math.max(0.5, shape.props.ry)
      : fallback;
    return { x: shape.x, y: shape.y, w: rx * 2, h: ry * 2 };
  }

  if (shape.type === "text") {
    const height = typeof shape.props.h === "number" && Number.isFinite(shape.props.h)
      ? Math.max(1, shape.props.h)
      : 1;
    return {
      x: shape.x,
      y: shape.y,
      w: Math.max(8, shape.props.w),
      h: height,
    };
  }

  if (shape.type === "arrow") {
    return getPointBounds(shape.x, shape.y, [shape.props.start, shape.props.end], 10);
  }

  return getPointBounds(shape.x, shape.y, shape.props.points, 10);
}

function getPointBounds(
  x: number,
  y: number,
  points: Array<{ x: number; y: number }>,
  padding: number,
): OverlayBounds {
  if (points.length === 0) {
    return { x, y, w: 1, h: 1 };
  }

  const xs = points.map((point) => x + point.x);
  const ys = points.map((point) => y + point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX - padding,
    y: minY - padding,
    w: Math.max(1, maxX - minX + padding * 2),
    h: Math.max(1, maxY - minY + padding * 2),
  };
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

function sortBlocksForAnchorOrder(
  blocks: MeasuredBlock[],
  anchorColumns = getAnchorColumns(blocks),
): MeasuredBlock[] {
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

function getBlockReadOrderKey(
  block: MeasuredBlock,
  index: number,
  anchorColumns: AnchorColumn[],
): AnchorReadOrderKey {
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
  const page = Math.max(
    0,
    Math.floor((y + COLUMN_PROBE_TOLERANCE_PX) / ANCHOR_PAGE_STRIDE_PX),
  );
  return {
    page,
    localY: y - page * ANCHOR_PAGE_STRIDE_PX,
  };
}

function getAnchorColumns(blocks: MeasuredBlock[]): AnchorColumn[] {
  const columns: Array<{
    representative: MeasuredBlock;
    left: number;
    right: number;
    blockIds: Set<string>;
  }> = [];

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

function getBlockColumnIndex(
  block: MeasuredBlock,
  columns: AnchorColumn[],
): number | undefined {
  return columns.find((column) => column.blockIds.has(block.id))?.index;
}
