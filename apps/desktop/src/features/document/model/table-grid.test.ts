import { describe, expect, it } from "vitest";

import { getTableCellMatrix } from "./table-grid";
import type { SigmaTableCell, SigmaTableSpec } from "../overlay-model";

function cell(
  rowId: string,
  columnId: string,
  text: string,
  span: { rowSpan?: number; colSpan?: number } = {},
): SigmaTableCell {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    ...span,
    content: [{
      type: "paragraph",
      id: `${rowId}-${columnId}-p`,
      children: [{ type: "text", text }],
    }],
  };
}

function table(rowIds: string[], columnIds: string[], cells: SigmaTableCell[]): SigmaTableSpec {
  return {
    version: 1,
    kind: "plain",
    columns: columnIds.map((id) => ({ id, width: { mode: "auto" } })),
    rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
    cells,
    grid: { borderColor: "#000000", borderWidth: 1 },
    defaultCellStyle: {},
  };
}

describe("getTableCellMatrix", () => {
  it("maps every position of a plain grid to its own cell", () => {
    const matrix = getTableCellMatrix(table(
      ["r1", "r2"],
      ["c1", "c2"],
      [cell("r1", "c1", "a"), cell("r1", "c2", "b"), cell("r2", "c1", "c"), cell("r2", "c2", "d")],
    ));

    expect(matrix.occupants.map((row) => row.map((placement) => placement.cell?.id))).toEqual([
      ["r1-c1", "r1-c2"],
      ["r2-c1", "r2-c2"],
    ]);
  });

  it("reports one origin per cell of a plain grid", () => {
    const matrix = getTableCellMatrix(table(
      ["r1", "r2"],
      ["c1", "c2"],
      [cell("r1", "c1", "a"), cell("r1", "c2", "b"), cell("r2", "c1", "c"), cell("r2", "c2", "d")],
    ));

    expect(matrix.origins.map((row) => row.length)).toEqual([2, 2]);
  });

  it("lets a colSpan cell occupy the columns it covers", () => {
    const matrix = getTableCellMatrix(table(
      ["r1", "r2"],
      ["c1", "c2"],
      [cell("r1", "c1", "wide", { colSpan: 2 }), cell("r2", "c1", "c"), cell("r2", "c2", "d")],
    ));

    expect(matrix.occupants[0].map((placement) => placement.cell?.id)).toEqual(["r1-c1", "r1-c1"]);
  });

  it("omits the covered column from the origins of a colSpan row", () => {
    const matrix = getTableCellMatrix(table(
      ["r1", "r2"],
      ["c1", "c2"],
      [cell("r1", "c1", "wide", { colSpan: 2 }), cell("r2", "c1", "c"), cell("r2", "c2", "d")],
    ));

    expect(matrix.origins[0]).toHaveLength(1);
  });

  it("lets a rowSpan cell occupy the rows it covers", () => {
    const matrix = getTableCellMatrix(table(
      ["r1", "r2"],
      ["c1", "c2"],
      [cell("r1", "c1", "tall", { rowSpan: 2 }), cell("r1", "c2", "b"), cell("r2", "c2", "d")],
    ));

    expect(matrix.occupants.map((row) => row[0].cell?.id)).toEqual(["r1-c1", "r1-c1"]);
  });

  it("keeps an undefined cell for a position the table never declares", () => {
    const matrix = getTableCellMatrix(table(
      ["r1"],
      ["c1", "c2"],
      [cell("r1", "c1", "a")],
    ));

    expect(matrix.occupants[0][1]).toEqual({
      cell: undefined,
      rowIndex: 0,
      columnIndex: 1,
      rowSpan: 1,
      colSpan: 1,
    });
  });

  it("gives an overlapped position to the span that reached it first", () => {
    const matrix = getTableCellMatrix(table(
      ["r1", "r2"],
      ["c1", "c2", "c3"],
      [
        cell("r1", "c1", "wide", { colSpan: 2 }),
        // Declared but unreachable: `r1-c1` already covers this position.
        cell("r1", "c2", "loser"),
        cell("r1", "c3", "z"),
      ],
    ));

    expect(matrix.occupants[0].map((placement) => placement.cell?.id)).toEqual(["r1-c1", "r1-c1", "r1-c3"]);
  });

  it("counts the rows and columns of the declared tracks", () => {
    const matrix = getTableCellMatrix(table(["r1", "r2"], ["c1", "c2", "c3"], []));

    expect({ rowCount: matrix.rowCount, columnCount: matrix.columnCount }).toEqual({
      rowCount: 2,
      columnCount: 3,
    });
  });

  it("clamps a span that reaches past the last row", () => {
    const matrix = getTableCellMatrix(table(
      ["r1"],
      ["c1"],
      [cell("r1", "c1", "tall", { rowSpan: 4 })],
    ));

    expect(matrix.occupants).toHaveLength(1);
  });
});
