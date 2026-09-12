import { createId } from "@/lib/id";
import {
  getTableCellBorderStyles,
  getTableCssBorderValue,
  getTableHorizontalLineKey,
  getTableLineOverride,
  getTableVerticalLineKey,
  isTableLineKeyValid,
  resolveTableColumnWidths,
  resolveTableLineBorder,
  resolveTableRowHeights,
  tableLineKeysEqual,
  type SigmaTableCellBorderStyles,
  type SigmaTableGridLineKey,
  type SigmaTableResolvedBorderStyle,
} from "@/features/rendering/core";

import type {
  SigmaTableCell,
  SigmaTableCellContent,
  SigmaTableGridLineOverride,
  SigmaTableGridLineStyle,
  SigmaTableGridStyle,
  SigmaTableColumn,
  SigmaTableKind,
  SigmaTableRow,
  SigmaTableSpec,
  SigmaTableTrackSize,
  OverlayTableShape,
} from "../types";

export const TABLE_SHAPE_TYPE = "tableShape" as const;
export const DEFAULT_TABLE_WIDTH = 260;
export const DEFAULT_TABLE_HEIGHT = 124;
export const DEFAULT_TABLE_COLUMN_WIDTH = 64;
export const DEFAULT_TABLE_ROW_HEIGHT = 32;
export const MIN_TABLE_COLUMN_WIDTH = 1;
export const MIN_TABLE_ROW_HEIGHT = 1;

export {
  getTableCellBorderStyles,
  getTableCssBorderValue,
  getTableHorizontalLineKey,
  getTableLineOverride,
  getTableVerticalLineKey,
  isTableLineKeyValid,
  resolveTableColumnWidths,
  resolveTableLineBorder,
  resolveTableRowHeights,
};
export type {
  SigmaTableCellBorderStyles,
  SigmaTableGridLineKey,
  SigmaTableResolvedBorderStyle,
};

export function createTableShapeProps(
  kind: SigmaTableKind = "plain",
  width = DEFAULT_TABLE_WIDTH,
  height = DEFAULT_TABLE_HEIGHT,
): OverlayTableShape["props"] {
  const table = kind === "variation" ? createVariationTableSpec() : createPlainTableSpec();
  return {
    w: width,
    h: height,
    table,
  };
}

export function createPlainTableSpec(rowCount = 3, columnCount = 3): SigmaTableSpec {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: createId("table_row"),
    height: { mode: "auto", min: index === 0 ? 34 : 32 } satisfies SigmaTableTrackSize,
    role: index === 0 ? "header" as const : "body" as const,
  }));
  const columns = Array.from({ length: columnCount }, () => ({
    id: createId("table_col"),
    width: { mode: "fr", value: 1, min: DEFAULT_TABLE_COLUMN_WIDTH } satisfies SigmaTableTrackSize,
  }));

  return {
    version: 1,
    kind: "plain",
    columns,
    rows,
    cells: rows.flatMap((row) => columns.map((column) => createCell(row.id, column.id))),
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: {
      align: "center",
      verticalAlign: "middle",
      paddingX: 8,
      paddingY: 5,
      color: "#111827",
      fontSize: 15,
      fontWeight: "normal",
    },
  };
}

export function createVariationTableSpec(): SigmaTableSpec {
  const rows = [
    { id: createId("table_row"), height: { mode: "auto", min: 32 } satisfies SigmaTableTrackSize, role: "variable" as const },
    { id: createId("table_row"), height: { mode: "auto", min: 32 } satisfies SigmaTableTrackSize, role: "derivative" as const },
    { id: createId("table_row"), height: { mode: "auto", min: 38 } satisfies SigmaTableTrackSize, role: "variation" as const },
  ];
  const columns = [
    { id: createId("table_col"), width: { mode: "auto", min: 48, max: 96 } satisfies SigmaTableTrackSize, role: "label" as const },
    { id: createId("table_col"), width: { mode: "fr", value: 1, min: 56 } satisfies SigmaTableTrackSize, role: "interval" as const },
    { id: createId("table_col"), width: { mode: "auto", min: 52, max: 96 } satisfies SigmaTableTrackSize, role: "point" as const },
    { id: createId("table_col"), width: { mode: "fr", value: 1, min: 56 } satisfies SigmaTableTrackSize, role: "interval" as const },
  ];
  const [labelColumn, leftColumn, pointColumn, rightColumn] = columns;
  const [xRow, derivativeRow, variationRow] = rows;

  return {
    version: 1,
    kind: "variation",
    columns,
    rows,
    cells: [
      createCell(xRow.id, labelColumn.id, mathContent("x")),
      createCell(xRow.id, leftColumn.id),
      createCell(xRow.id, pointColumn.id, mathContent("a")),
      createCell(xRow.id, rightColumn.id),
      createCell(derivativeRow.id, labelColumn.id, mathContent("f'(x)")),
      createCell(derivativeRow.id, leftColumn.id, mathContent("+")),
      createCell(derivativeRow.id, pointColumn.id, mathContent("0")),
      createCell(derivativeRow.id, rightColumn.id, mathContent("-")),
      createCell(variationRow.id, labelColumn.id, mathContent("f(x)")),
      createCell(variationRow.id, leftColumn.id, mathContent("\\nearrow")),
      createCell(variationRow.id, pointColumn.id),
      createCell(variationRow.id, rightColumn.id, mathContent("\\searrow")),
    ],
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: {
      align: "center",
      verticalAlign: "middle",
      paddingX: 8,
      paddingY: 5,
      color: "#111827",
      fontSize: 15,
      fontWeight: "normal",
    },
  };
}

export function createVariationDoubleLineTableSpec(): SigmaTableSpec {
  const table = createVariationTableSpec();
  const labelSeparator = getTableVerticalLineKey(table, 1);
  return labelSeparator
    ? upsertTableLineOverride(table, labelSeparator, {
        borderStyle: "double",
        borderWidth: 3,
        visible: true,
      })
    : table;
}

export function createOpenSidesTableSpec(rowCount = 3, columnCount = 4): SigmaTableSpec {
  const table = createPlainTableSpec(rowCount, columnCount);
  const leftEdge = getTableVerticalLineKey(table, 0);
  const rightEdge = getTableVerticalLineKey(table, table.columns.length);
  let nextTable = table;

  if (leftEdge) {
    nextTable = upsertTableLineOverride(nextTable, leftEdge, { visible: false });
  }

  if (rightEdge) {
    nextTable = upsertTableLineOverride(nextTable, rightEdge, { visible: false });
  }

  return nextTable;
}

export function applyTableTemplateStyle(table: SigmaTableSpec, template: SigmaTableSpec): SigmaTableSpec {
  const lineOverrides = remapTemplateLineOverrides(template, table);
  const grid: SigmaTableGridStyle = {
    ...template.grid,
  };

  if (lineOverrides.length > 0) {
    grid.lineOverrides = lineOverrides;
  } else {
    delete grid.lineOverrides;
  }

  return {
    ...table,
    kind: template.kind,
    grid,
    defaultCellStyle: {
      ...table.defaultCellStyle,
      ...template.defaultCellStyle,
    },
  };
}

export function upsertTableLineOverride(
  table: SigmaTableSpec,
  key: SigmaTableGridLineKey,
  style: SigmaTableGridLineStyle,
): SigmaTableSpec {
  if (!isTableLineKeyValid(table, key)) {
    return table;
  }

  const current = getTableLineOverride(table, key);
  const nextOverride = {
    ...key,
    style: {
      ...(current?.style ?? {}),
      ...style,
    },
  } as SigmaTableGridLineOverride;
  let replaced = false;
  const lineOverrides = (table.grid.lineOverrides ?? []).map((override) => {
    if (!tableLineKeysEqual(override, key)) {
      return override;
    }
    replaced = true;
    return nextOverride;
  });

  if (!replaced) {
    lineOverrides.push(nextOverride);
  }

  return {
    ...table,
    grid: {
      ...table.grid,
      lineOverrides,
    },
  };
}

export function removeTableLineOverride(table: SigmaTableSpec, key: SigmaTableGridLineKey): SigmaTableSpec {
  const lineOverrides = (table.grid.lineOverrides ?? []).filter((override) => !tableLineKeysEqual(override, key));
  const grid = { ...table.grid };
  if (lineOverrides.length > 0) {
    grid.lineOverrides = lineOverrides;
  } else {
    delete grid.lineOverrides;
  }

  return {
    ...table,
    grid,
  };
}

export function resizeTableColumnBoundary(
  table: SigmaTableSpec,
  leftIndex: number,
  leftWidth: number,
  rightWidth: number,
): SigmaTableSpec {
  if (leftIndex < 0 || leftIndex >= table.columns.length - 1) {
    return table;
  }

  return {
    ...table,
    columns: table.columns.map((column, index) => {
      if (index === leftIndex) {
        return setColumnWidth(column, leftWidth);
      }
      if (index === leftIndex + 1) {
        return setColumnWidth(column, rightWidth);
      }
      return column;
    }),
  };
}

export function resizeTableColumnEdge(
  table: SigmaTableSpec,
  edge: "left" | "right",
  width: number,
): SigmaTableSpec {
  if (table.columns.length === 0) {
    return table;
  }

  const targetIndex = edge === "left" ? 0 : table.columns.length - 1;

  return {
    ...table,
    columns: table.columns.map((column, index) => index === targetIndex ? setColumnWidth(column, width) : column),
  };
}

export function resizeTableRowBoundary(
  table: SigmaTableSpec,
  topIndex: number,
  topHeight: number,
  bottomHeight: number,
): SigmaTableSpec {
  if (topIndex < 0 || topIndex >= table.rows.length - 1) {
    return table;
  }

  return {
    ...table,
    rows: table.rows.map((row, index) => {
      if (index === topIndex) {
        return setRowHeight(row, topHeight);
      }
      if (index === topIndex + 1) {
        return setRowHeight(row, bottomHeight);
      }
      return row;
    }),
  };
}

export function resizeTableRowEdge(
  table: SigmaTableSpec,
  edge: "top" | "bottom",
  height: number,
): SigmaTableSpec {
  if (table.rows.length === 0) {
    return table;
  }

  const targetIndex = edge === "top" ? 0 : table.rows.length - 1;

  return {
    ...table,
    rows: table.rows.map((row, index) => index === targetIndex ? setRowHeight(row, height) : row),
  };
}

export function insertTableColumn(table: SigmaTableSpec, insertIndex: number): SigmaTableSpec {
  const boundedIndex = clampInteger(insertIndex, 0, table.columns.length);
  const column = {
    id: createId("table_col"),
    width: { mode: "auto", min: 40 } satisfies SigmaTableTrackSize,
  };
  const columns = [
    ...table.columns.slice(0, boundedIndex),
    column,
    ...table.columns.slice(boundedIndex),
  ];

  return {
    ...table,
    columns,
    grid: cleanTableGridLineOverrides(table.grid, columns, table.rows),
    cells: table.rows.flatMap((row) => {
      const existing = table.cells.filter((cell) => cell.rowId === row.id);
      return [
        ...existing.filter((cell) => columns.findIndex((item) => item.id === cell.columnId) < boundedIndex),
        createCell(row.id, column.id),
        ...existing.filter((cell) => columns.findIndex((item) => item.id === cell.columnId) > boundedIndex),
      ];
    }),
  };
}

export function removeTableColumn(table: SigmaTableSpec, columnId: string): SigmaTableSpec {
  return removeTableColumns(table, [columnId]);
}

export function removeTableColumns(table: SigmaTableSpec, columnIds: readonly string[]): SigmaTableSpec {
  const columnIdSet = new Set(columnIds);
  if (columnIdSet.size === 0 || table.columns.length <= 1) {
    return table;
  }

  const columns = table.columns.filter((column) => !columnIdSet.has(column.id));
  if (columns.length === 0 || columns.length === table.columns.length) {
    return table;
  }

  return {
    ...table,
    columns,
    cells: clampTableCellSpans(
      table.cells.filter((cell) => !columnIdSet.has(cell.columnId)),
      columns,
      table.rows,
    ),
    grid: cleanTableGridLineOverrides(table.grid, columns, table.rows),
  };
}

export function insertTableRow(table: SigmaTableSpec, insertIndex: number): SigmaTableSpec {
  const boundedIndex = clampInteger(insertIndex, 0, table.rows.length);
  const row = {
    id: createId("table_row"),
    height: { mode: "auto", min: DEFAULT_TABLE_ROW_HEIGHT } satisfies SigmaTableTrackSize,
    role: "body" as const,
  };
  const rows = [
    ...table.rows.slice(0, boundedIndex),
    row,
    ...table.rows.slice(boundedIndex),
  ];

  return {
    ...table,
    rows,
    grid: cleanTableGridLineOverrides(table.grid, table.columns, rows),
    cells: [
      ...table.cells.filter((cell) => rows.findIndex((item) => item.id === cell.rowId) < boundedIndex),
      ...table.columns.map((column) => createCell(row.id, column.id)),
      ...table.cells.filter((cell) => rows.findIndex((item) => item.id === cell.rowId) > boundedIndex),
    ],
  };
}

export function removeTableRow(table: SigmaTableSpec, rowId: string): SigmaTableSpec {
  return removeTableRows(table, [rowId]);
}

export function removeTableRows(table: SigmaTableSpec, rowIds: readonly string[]): SigmaTableSpec {
  const rowIdSet = new Set(rowIds);
  if (rowIdSet.size === 0 || table.rows.length <= 1) {
    return table;
  }

  const rows = table.rows.filter((row) => !rowIdSet.has(row.id));
  if (rows.length === 0 || rows.length === table.rows.length) {
    return table;
  }

  return {
    ...table,
    rows,
    cells: clampTableCellSpans(
      table.cells.filter((cell) => !rowIdSet.has(cell.rowId)),
      table.columns,
      rows,
    ),
    grid: cleanTableGridLineOverrides(table.grid, table.columns, rows),
  };
}

function remapTemplateLineOverrides(template: SigmaTableSpec, table: SigmaTableSpec): SigmaTableGridLineOverride[] {
  return (template.grid.lineOverrides ?? []).flatMap((override) => {
    const key = getRemappedTableLineKey(template, table, override);
    if (!key || !isTableLineKeyValid(table, key)) {
      return [];
    }

    return [{
      ...key,
      style: { ...override.style },
    } as SigmaTableGridLineOverride];
  });
}

function getRemappedTableLineKey(
  template: SigmaTableSpec,
  table: SigmaTableSpec,
  key: SigmaTableGridLineKey,
): SigmaTableGridLineKey | null {
  if ("edge" in key) {
    return key;
  }

  const boundaryIndex = getTableLineBoundaryIndex(template, key);
  if (boundaryIndex === null) {
    return null;
  }

  return key.axis === "vertical"
    ? getTableVerticalLineKey(table, boundaryIndex)
    : getTableHorizontalLineKey(table, boundaryIndex);
}

function getTableLineBoundaryIndex(table: SigmaTableSpec, key: SigmaTableGridLineKey): number | null {
  if (key.axis === "vertical") {
    if ("edge" in key) {
      return key.edge === "left" ? 0 : table.columns.length;
    }

    const columnIndex = table.columns.findIndex((column) => column.id === key.beforeColumnId);
    return columnIndex > 0 ? columnIndex : null;
  }

  if ("edge" in key) {
    return key.edge === "top" ? 0 : table.rows.length;
  }

  const rowIndex = table.rows.findIndex((row) => row.id === key.beforeRowId);
  return rowIndex > 0 ? rowIndex : null;
}

function cleanTableGridLineOverrides(
  grid: SigmaTableGridStyle,
  columns: SigmaTableColumn[],
  rows: SigmaTableRow[],
): SigmaTableGridStyle {
  if (!grid.lineOverrides?.length) {
    return grid;
  }

  const lineOverrides = grid.lineOverrides.filter((override) => isLineOverrideValidForTracks(override, columns, rows));
  if (lineOverrides.length === grid.lineOverrides.length) {
    return grid;
  }

  const nextGrid = { ...grid };
  if (lineOverrides.length > 0) {
    nextGrid.lineOverrides = lineOverrides;
  } else {
    delete nextGrid.lineOverrides;
  }
  return nextGrid;
}

function clampTableCellSpans(
  cells: SigmaTableCell[],
  columns: SigmaTableColumn[],
  rows: SigmaTableRow[],
): SigmaTableCell[] {
  return cells.flatMap((cell) => {
    const rowIndex = rows.findIndex((row) => row.id === cell.rowId);
    const columnIndex = columns.findIndex((column) => column.id === cell.columnId);
    if (rowIndex < 0 || columnIndex < 0) {
      return [];
    }

    const rowSpan = clampInteger(cell.rowSpan ?? 1, 1, Math.max(1, rows.length - rowIndex));
    const colSpan = clampInteger(cell.colSpan ?? 1, 1, Math.max(1, columns.length - columnIndex));
    return [{
      ...cell,
      ...(rowSpan === 1 ? { rowSpan: undefined } : { rowSpan }),
      ...(colSpan === 1 ? { colSpan: undefined } : { colSpan }),
    }];
  });
}

function isLineOverrideValidForTracks(
  override: SigmaTableGridLineOverride,
  columns: SigmaTableColumn[],
  rows: SigmaTableRow[],
): boolean {
  if (override.axis === "vertical") {
    if ("edge" in override) {
      return override.edge === "left" || override.edge === "right";
    }
    return columns.findIndex((column) => column.id === override.beforeColumnId) > 0;
  }

  if ("edge" in override) {
    return override.edge === "top" || override.edge === "bottom";
  }
  return rows.findIndex((row) => row.id === override.beforeRowId) > 0;
}

function createCell(rowId: string, columnId: string, content: SigmaTableCellContent[] = [emptyParagraph()]): SigmaTableCell {
  return {
    id: createId("table_cell"),
    rowId,
    columnId,
    content,
  };
}

function emptyParagraph(): SigmaTableCellContent {
  return {
    type: "paragraph",
    id: createId("table_p"),
    children: [],
    align: "center",
  };
}

function mathContent(tex: string): SigmaTableCellContent[] {
  return [
    {
      type: "paragraph",
      id: createId("table_p"),
      children: [{
        type: "mathInline",
        id: createId("table_math"),
        tex,
        display: "inline",
        semanticRole: "expression",
      }],
      align: "center",
    },
  ];
}

function setColumnWidth(column: SigmaTableColumn, width: number): SigmaTableColumn {
  return {
    ...column,
    width: {
      mode: "fixed",
      value: Math.max(MIN_TABLE_COLUMN_WIDTH, width),
    },
  };
}

function setRowHeight(row: SigmaTableRow, height: number): SigmaTableRow {
  return {
    ...row,
    height: {
      mode: "fixed",
      value: Math.max(MIN_TABLE_ROW_HEIGHT, height),
    },
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
