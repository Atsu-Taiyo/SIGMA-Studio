/** Shared by the lightweight placement preview and the canonical table created on release. */
export function getTablePlacementBounds(
  start: { x: number; y: number },
  end: { x: number; y: number },
  cell: { w: number; h: number },
) {
  const cellW = Math.max(1, cell.w);
  const cellH = Math.max(1, cell.h);
  const columns = Math.max(2, Math.round(Math.abs(end.x - start.x) / cellW));
  const rows = Math.max(2, Math.round(Math.abs(end.y - start.y) / cellH));
  const w = columns * cellW;
  const h = rows * cellH;
  return { x: end.x < start.x ? start.x - w : start.x,
    y: end.y < start.y ? start.y - h : start.y, w, h, rows, columns, cellW, cellH };
}
