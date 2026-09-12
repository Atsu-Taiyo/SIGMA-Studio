import type { SigmaTableCell, SigmaTableSpec } from "../overlay-model";

/**
 * One cell as it sits on the grid: the position it starts at and how far it reaches.
 *
 * `cell` is absent where the table declares no cell for that position; the placement still exists so
 * every grid position has an occupant and callers never index into a hole.
 */
export interface SigmaTableCellPlacement {
  cell: SigmaTableCell | undefined;
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  colSpan: number;
}

export interface SigmaTableCellMatrix {
  rowCount: number;
  columnCount: number;
  /** Placements that *start* in each row, in column order. Covered positions are omitted. */
  origins: SigmaTableCellPlacement[][];
  /** The placement occupying each grid position, indexed `[rowIndex][columnIndex]`. */
  occupants: SigmaTableCellPlacement[][];
}

/**
 * Expands `rowSpan`/`colSpan` once, for every reader that needs to know which cell owns a position.
 *
 * The layout model (`overlay-table-read-model.ts`) walks `origins` to place DOM cells; the chart
 * derivation walks `occupants` so a merged header names every column it visually covers. Keeping a
 * single expansion is what makes those two agree.
 */
export function getTableCellMatrix(table: SigmaTableSpec): SigmaTableCellMatrix {
  const rowCount = table.rows.length;
  const columnCount = table.columns.length;
  const cellMap = new Map(table.cells.map((cell) => [`${cell.rowId}:${cell.columnId}`, cell]));
  const occupants: SigmaTableCellPlacement[][] = Array.from(
    { length: rowCount },
    () => new Array<SigmaTableCellPlacement>(columnCount),
  );

  const origins = table.rows.map((row, rowIndex) => {
    const rowOrigins: SigmaTableCellPlacement[] = [];
    table.columns.forEach((column, columnIndex) => {
      if (occupants[rowIndex][columnIndex] !== undefined) {
        return;
      }
      const cell = cellMap.get(`${row.id}:${column.id}`);
      const placement: SigmaTableCellPlacement = {
        cell,
        rowIndex,
        columnIndex,
        rowSpan: cell?.rowSpan ?? 1,
        colSpan: cell?.colSpan ?? 1,
      };
      for (let y = rowIndex; y < Math.min(rowIndex + placement.rowSpan, rowCount); y += 1) {
        for (let x = columnIndex; x < Math.min(columnIndex + placement.colSpan, columnCount); x += 1) {
          occupants[y][x] ??= placement;
        }
      }
      rowOrigins.push(placement);
    });
    return rowOrigins;
  });

  return { rowCount, columnCount, origins, occupants };
}
