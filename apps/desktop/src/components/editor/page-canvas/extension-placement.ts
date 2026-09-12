import type { MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";

const COLUMN_SCOPED_MAX_WIDTH_RATIO = 0.72;

export interface ColumnBounds {
  left: number;
  right: number;
  width: number;
}

export interface ColumnContentAnchor extends ColumnBounds {
  top: number;
}

/** Returns a measured block's column-sized bounds, or null for full-width content. */
export function getNarrowColumnBounds(
  block: MeasuredBlock | undefined,
  pageContentWidth: number,
): ColumnBounds | null {
  if (
    !block ||
    typeof block.left !== "number" ||
    typeof block.width !== "number" ||
    !Number.isFinite(block.left) ||
    !Number.isFinite(block.width) ||
    block.width <= 0 ||
    !Number.isFinite(pageContentWidth) ||
    pageContentWidth <= 0 ||
    block.width > pageContentWidth * COLUMN_SCOPED_MAX_WIDTH_RATIO
  ) {
    return null;
  }

  return {
    left: block.left,
    right: block.left + block.width,
    width: block.width,
  };
}

/** Places extension content directly below its measured target column. */
export function getColumnContentAnchor(
  block: MeasuredBlock | undefined,
  pageContentWidth: number,
  gap = 4,
): ColumnContentAnchor | null {
  const bounds = getNarrowColumnBounds(block, pageContentWidth);
  if (!bounds || !block || typeof block.height !== "number" || !Number.isFinite(block.height)) {
    return null;
  }

  return {
    ...bounds,
    top: Math.max(0, block.top + block.height + gap),
  };
}

/** Centers a floating widget and clamps it to the supplied horizontal bounds. */
export function placeCenteredWidget(
  candidateCenter: number,
  desiredWidth: number,
  bounds: ColumnBounds,
  margin: number,
): { center: number; width: number } {
  const safeMargin = Math.max(0, Math.min(margin, bounds.width / 2));
  const availableWidth = Math.max(1, bounds.width - safeMargin * 2);
  const width = Math.min(Math.max(1, desiredWidth), availableWidth);
  const minCenter = bounds.left + safeMargin + width / 2;
  const maxCenter = bounds.right - safeMargin - width / 2;

  return {
    center: Math.max(minCenter, Math.min(candidateCenter, Math.max(minCenter, maxCenter))),
    width,
  };
}
