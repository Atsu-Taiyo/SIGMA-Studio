import { describe, expect, it } from "vitest";

import type { SigmaTableSpec } from "../types";
import {
  applyTableTemplateStyle,
  createPlainTableSpec,
  createOpenSidesTableSpec,
  createVariationDoubleLineTableSpec,
  createVariationTableSpec,
  getTableCellBorderStyles,
  getTableHorizontalLineKey,
  getTableVerticalLineKey,
  insertTableColumn,
  insertTableRow,
  removeTableColumn,
  removeTableColumns,
  removeTableLineOverride,
  removeTableRow,
  removeTableRows,
  resolveTableLineBorder,
  resizeTableColumnBoundary,
  resizeTableColumnEdge,
  resizeTableRowBoundary,
  resizeTableRowEdge,
  resolveTableColumnWidths,
  resolveTableRowHeights,
  upsertTableLineOverride,
} from "./table";

describe("overlay table shape sizing", () => {
  it("keeps auto columns at their minimum while fr columns take remaining space", () => {
    const table = createVariationTableSpec();

    expect(resolveTableColumnWidths(table, 260)).toEqual([48, 80, 52, 80]);
  });

  it("uses mathInline for math-like default variation table cells", () => {
    const table = createVariationTableSpec();
    const [xRow, derivativeRow, variationRow] = table.rows;
    const [labelColumn, leftColumn, pointColumn, rightColumn] = table.columns;

    expect(getFirstCellMathTex(table, xRow.id, labelColumn.id)).toBe("x");
    expect(getFirstCellMathTex(table, xRow.id, pointColumn.id)).toBe("a");
    expect(getFirstCellMathTex(table, derivativeRow.id, leftColumn.id)).toBe("+");
    expect(getFirstCellMathTex(table, derivativeRow.id, pointColumn.id)).toBe("0");
    expect(getFirstCellMathTex(table, derivativeRow.id, rightColumn.id)).toBe("-");
    expect(getFirstCellMathTex(table, variationRow.id, leftColumn.id)).toBe("\\nearrow");
    expect(getFirstCellMathTex(table, variationRow.id, rightColumn.id)).toBe("\\searrow");
  });

  it("creates table templates with specialized grid lines", () => {
    const variation = createVariationDoubleLineTableSpec();
    const labelSeparator = getTableVerticalLineKey(variation, 1);
    expect(labelSeparator).not.toBeNull();
    expect(resolveTableLineBorder(variation, labelSeparator!)).toMatchObject({
      borderStyle: "double",
      borderWidth: 3,
      visible: true,
    });

    const openSides = createOpenSidesTableSpec();
    const leftEdge = getTableVerticalLineKey(openSides, 0);
    const rightEdge = getTableVerticalLineKey(openSides, openSides.columns.length);
    expect(leftEdge).not.toBeNull();
    expect(rightEdge).not.toBeNull();
    expect(resolveTableLineBorder(openSides, leftEdge!).visible).toBe(false);
    expect(resolveTableLineBorder(openSides, rightEdge!).visible).toBe(false);
  });

  it("applies table template styles without replacing existing cell content", () => {
    const table = withFirstCellText(createPlainTableSpec(2, 3), "kept content");
    const nextTable = applyTableTemplateStyle(table, createVariationDoubleLineTableSpec());
    const labelSeparator = getTableVerticalLineKey(nextTable, 1);

    expect(nextTable.kind).toBe("variation");
    expect(nextTable.rows).toBe(table.rows);
    expect(nextTable.columns).toBe(table.columns);
    expect(nextTable.cells).toBe(table.cells);
    expect(getFirstCellText(nextTable, table.rows[0].id, table.columns[0].id)).toBe("kept content");
    expect(getFirstCellMathTex(nextTable, table.rows[0].id, table.columns[0].id)).toBeUndefined();
    expect(labelSeparator).not.toBeNull();
    expect(resolveTableLineBorder(nextTable, labelSeparator!)).toMatchObject({
      borderStyle: "double",
      borderWidth: 3,
      visible: true,
    });
  });

  it("maps open-side template edge overrides onto the existing table", () => {
    const table = withFirstCellText(createPlainTableSpec(2, 2), "left alone");
    const nextTable = applyTableTemplateStyle(table, createOpenSidesTableSpec());
    const leftEdge = getTableVerticalLineKey(nextTable, 0);
    const rightEdge = getTableVerticalLineKey(nextTable, nextTable.columns.length);

    expect(getFirstCellText(nextTable, table.rows[0].id, table.columns[0].id)).toBe("left alone");
    expect(leftEdge).not.toBeNull();
    expect(rightEdge).not.toBeNull();
    expect(resolveTableLineBorder(nextTable, leftEdge!).visible).toBe(false);
    expect(resolveTableLineBorder(nextTable, rightEdge!).visible).toBe(false);
  });

  it("keeps auto rows compact instead of sharing remaining height", () => {
    const table: SigmaTableSpec = {
      version: 1,
      kind: "plain",
      columns: [
        { id: "c1", width: { mode: "fixed", value: 100 } },
      ],
      rows: [
        { id: "r1", height: { mode: "auto", min: 24 } },
        { id: "r2", height: { mode: "auto" } },
        { id: "r3", height: { mode: "fr", value: 1, min: 30 } },
      ],
      cells: [],
      grid: {
        borderColor: "#111827",
        borderWidth: 1,
      },
      defaultCellStyle: {},
    };

    expect(resolveTableRowHeights(table, 180)).toEqual([24, 1, 155]);
  });

  it("scales tracks below their preferred minimums when the table is made smaller", () => {
    const table = createPlainTableSpec(3, 3);
    const columnWidths = resolveTableColumnWidths(table, 30);
    const rowHeights = resolveTableRowHeights(table, 12);

    expect(columnWidths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(30);
    expect(columnWidths).toEqual([10, 10, 10]);
    expect(rowHeights.reduce((sum, height) => sum + height, 0)).toBeCloseTo(12);
    expect(Math.max(...rowHeights)).toBeLessThan(5);
  });

  it("resizes adjacent columns and rows while keeping the table size stable", () => {
    const table = createPlainTableSpec(2, 2);
    const columnResized = resizeTableColumnBoundary(table, 0, 90, 110);
    const rowResized = resizeTableRowBoundary(columnResized, 0, 42, 36);

    expect(columnResized.columns.map((column) => column.width)).toEqual([
      { mode: "fixed", value: 90 },
      { mode: "fixed", value: 110 },
    ]);
    expect(rowResized.rows.map((row) => row.height)).toEqual([
      { mode: "fixed", value: 42 },
      { mode: "fixed", value: 36 },
    ]);
  });

  it("resizes outer column and row edges without changing adjacent tracks", () => {
    const table: SigmaTableSpec = {
      ...createPlainTableSpec(2, 3),
      columns: [
        { id: "c1", width: { mode: "fr", value: 1, min: 64 } },
        { id: "c2", width: { mode: "auto", min: 48 } },
        { id: "c3", width: { mode: "fr", value: 1, min: 64 } },
      ],
      rows: [
        { id: "r1", height: { mode: "auto", min: 34 }, role: "header" },
        { id: "r2", height: { mode: "fr", value: 1, min: 32 }, role: "body" },
      ],
    };

    const leftResized = resizeTableColumnEdge(table, "left", 92);
    const rightResized = resizeTableColumnEdge(table, "right", 118);
    const topResized = resizeTableRowEdge(table, "top", 44);
    const bottomResized = resizeTableRowEdge(table, "bottom", 52);

    expect(leftResized.columns.map((column) => column.width)).toEqual([
      { mode: "fixed", value: 92 },
      { mode: "auto", min: 48 },
      { mode: "fr", value: 1, min: 64 },
    ]);
    expect(rightResized.columns.map((column) => column.width)).toEqual([
      { mode: "fr", value: 1, min: 64 },
      { mode: "auto", min: 48 },
      { mode: "fixed", value: 118 },
    ]);
    expect(topResized.rows.map((row) => row.height)).toEqual([
      { mode: "fixed", value: 44 },
      { mode: "fr", value: 1, min: 32 },
    ]);
    expect(bottomResized.rows.map((row) => row.height)).toEqual([
      { mode: "auto", min: 34 },
      { mode: "fixed", value: 52 },
    ]);
  });

  it("adds and removes columns and rows with matching cells", () => {
    const table = createPlainTableSpec(2, 2);
    const withColumn = insertTableColumn(table, 1);
    const withRow = insertTableRow(withColumn, 1);

    expect(withColumn.columns).toHaveLength(3);
    expect(withColumn.cells.filter((cell) => cell.columnId === withColumn.columns[1].id)).toHaveLength(2);
    expect(withRow.rows).toHaveLength(3);
    expect(withRow.cells.filter((cell) => cell.rowId === withRow.rows[1].id)).toHaveLength(3);

    const withoutColumn = removeTableColumn(withRow, withRow.columns[1].id);
    const withoutRow = removeTableRow(withoutColumn, withRow.rows[1].id);

    expect(withoutColumn.columns).toHaveLength(2);
    expect(withoutColumn.cells.some((cell) => cell.columnId === withRow.columns[1].id)).toBe(false);
    expect(withoutRow.rows).toHaveLength(2);
    expect(withoutRow.cells.some((cell) => cell.rowId === withRow.rows[1].id)).toBe(false);
  });

  it("removes multiple columns and rows while preserving a valid table", () => {
    const table = createPlainTableSpec(3, 4);
    const withoutColumns = removeTableColumns(table, [
      table.columns[1].id,
      table.columns[2].id,
    ]);
    const withoutRows = removeTableRows(withoutColumns, [
      withoutColumns.rows[0].id,
      withoutColumns.rows[1].id,
    ]);

    expect(withoutColumns.columns).toHaveLength(2);
    expect(withoutColumns.cells.some((cell) => cell.columnId === table.columns[1].id)).toBe(false);
    expect(withoutColumns.cells.some((cell) => cell.columnId === table.columns[2].id)).toBe(false);
    expect(withoutRows.rows).toHaveLength(1);
    expect(withoutRows.cells.some((cell) => cell.rowId === withoutColumns.rows[0].id)).toBe(false);
    expect(removeTableColumns(withoutRows, withoutRows.columns.map((column) => column.id))).toBe(withoutRows);
    expect(removeTableRows(withoutRows, withoutRows.rows.map((row) => row.id))).toBe(withoutRows);
  });

  it("clamps cell spans after deleting tracks", () => {
    const table = createPlainTableSpec(4, 4);
    const spanningCell = {
      ...table.cells[0],
      rowSpan: 4,
      colSpan: 4,
    };
    const withSpan = {
      ...table,
      cells: [spanningCell, ...table.cells.slice(1)],
    };
    const withoutMiddleTracks = removeTableRows(
      removeTableColumns(withSpan, [table.columns[1].id]),
      [table.rows[1].id],
    );
    const remainingSpan = withoutMiddleTracks.cells.find((cell) => cell.id === spanningCell.id);

    expect(remainingSpan?.rowSpan).toBe(3);
    expect(remainingSpan?.colSpan).toBe(3);
    expect(removeTableRows(withSpan, [table.rows[0].id]).cells.some((cell) => cell.id === spanningCell.id)).toBe(false);
    expect(removeTableColumns(withSpan, [table.columns[0].id]).cells.some((cell) => cell.id === spanningCell.id)).toBe(false);
  });

  it("resolves per-line border overrides from the table default style", () => {
    const table = createPlainTableSpec(2, 2);
    const verticalLine = getTableVerticalLineKey(table, 1);
    expect(verticalLine).not.toBeNull();

    const withDottedLine = upsertTableLineOverride(table, verticalLine!, {
      borderStyle: "dotted",
      borderWidth: 3,
    });
    expect(resolveTableLineBorder(withDottedLine, verticalLine!)).toEqual({
      visible: true,
      borderColor: "#111827",
      borderWidth: 3,
      borderStyle: "dotted",
    });
    expect(getTableCellBorderStyles(withDottedLine, 0, 0).borderRight).toBe("3px dotted #111827");
    expect(getTableCellBorderStyles(withDottedLine, 0, 1).borderLeft).toBe("3px dotted #111827");

    const hiddenLine = upsertTableLineOverride(withDottedLine, verticalLine!, { visible: false });
    expect(resolveTableLineBorder(hiddenLine, verticalLine!).visible).toBe(false);
    expect(getTableCellBorderStyles(hiddenLine, 0, 0).borderRight).toBe("0");

    const cleared = removeTableLineOverride(hiddenLine, verticalLine!);
    expect(cleared.grid.lineOverrides).toBeUndefined();
    expect(getTableCellBorderStyles(cleared, 0, 0).borderRight).toBe("1px solid #111827");
  });

  it("removes line overrides that no longer point at an internal grid line", () => {
    const table = createPlainTableSpec(2, 2);
    const verticalLine = getTableVerticalLineKey(table, 1);
    const horizontalLine = getTableHorizontalLineKey(table, 1);
    expect(verticalLine).not.toBeNull();
    expect(horizontalLine).not.toBeNull();

    const styled = upsertTableLineOverride(
      upsertTableLineOverride(table, verticalLine!, { borderWidth: 4 }),
      horizontalLine!,
      { borderStyle: "dashed" },
    );
    expect(styled.grid.lineOverrides).toHaveLength(2);

    const withoutFirstColumn = removeTableColumn(styled, styled.columns[0].id);
    expect(withoutFirstColumn.grid.lineOverrides?.some((override) => override.axis === "vertical")).toBe(false);

    const withoutFirstRow = removeTableRow(styled, styled.rows[0].id);
    expect(withoutFirstRow.grid.lineOverrides?.some((override) => override.axis === "horizontal")).toBe(false);
  });
});

function getFirstCellMathTex(table: SigmaTableSpec, rowId: string, columnId: string): string | undefined {
  const cell = table.cells.find((item) => item.rowId === rowId && item.columnId === columnId);
  const content = cell?.content[0];
  if (content?.type !== "paragraph") {
    return undefined;
  }

  const child = content.children[0];
  return child?.type === "mathInline" ? child.tex : undefined;
}

function getFirstCellText(table: SigmaTableSpec, rowId: string, columnId: string): string | undefined {
  const cell = table.cells.find((item) => item.rowId === rowId && item.columnId === columnId);
  const content = cell?.content[0];
  if (content?.type !== "paragraph") {
    return undefined;
  }

  const child = content.children[0];
  return child?.type === "text" ? child.text : undefined;
}

function withFirstCellText(table: SigmaTableSpec, text: string): SigmaTableSpec {
  const firstCell = table.cells[0];
  return {
    ...table,
    cells: table.cells.map((cell) => {
      if (cell.id !== firstCell.id) {
        return cell;
      }

      return {
        ...cell,
        content: [{
          type: "paragraph",
          id: "table_p_kept",
          children: [{ type: "text", text }],
        }],
      };
    }),
  };
}
