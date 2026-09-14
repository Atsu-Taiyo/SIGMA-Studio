import type { Editor as TiptapEditor } from "@tiptap/core";

import { MM_TO_PX } from "@/features/document";

import { clamp } from "../math";
import type {
  SigmaTableCell,
  SigmaTableCellStyle,
  SigmaTableCellContent,
  SigmaTableSpec,
  SigmaTableTrackSize,
} from "../types";
import {
  getTableHorizontalLineKey,
  getTableVerticalLineKey,
  type SigmaTableGridLineKey,
} from "./table";

/**
 * Rendering-model facade. The table used to be drawn twice — here for the editor and again as an
 * HTML string in `overlay-svg.ts` — so the geometry now lives in `features/rendering/core` and
 * both surfaces read it from there. Editing concerns (selection, navigation, toolbars, mm
 * conversion, DOM measurement) stay in this file.
 */
export {
  getCumulativeOffsets,
  getTableCellContentJustify,
  getTableCellContentLayerStyleModel as getTableCellContentLayerStyle,
  getTableCellStyleModel as getTableCellStyle,
  getTableLineDomKey,
  getTableRenderedLineConnectorModels as getTableRenderedLineConnectors,
  getTableRenderedLineModels,
  getTableRenderedLineStyleModel as getTableRenderedLineStyle,
  shouldRenderTableLineOverlay,
  type OverlayTableLineConnectorModel,
  type OverlayTableRenderedLineModel,
  type OverlayTableStyleModel,
} from "@/features/rendering/core";
import { getTableLineDomKey } from "@/features/rendering/core";
import type { Translate } from "@/lib/i18n";

export type TableCellNavigationDirection = "left" | "right" | "up" | "down";
export type TableCellFocusPlacement = "start" | "end";

export interface TableEditorViewLike {
  state: {
    selection: {
      empty: boolean;
      from: number;
      to: number;
      $from: {
        parentOffset: number;
        parent: {
          content: {
            size: number;
          };
        };
      };
      $to: {
        parentOffset: number;
        parent: {
          content: {
            size: number;
          };
        };
      };
    };
    doc: {
      content: {
        size: number;
      };
    };
  };
  coordsAtPos: (pos: number) => { top: number; right: number; bottom: number; left: number };
  dom: HTMLElement;
  posAtDOM?: (node: Node, offset: number, bias?: number) => number;
}

export interface TableCellPosition {
  rowIndex: number;
  columnIndex: number;
}

export interface TableCellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface TableCellSelection {
  anchor: TableCellPosition;
  focus: TableCellPosition;
}

export type TableDeletePreview = "rows" | "columns";
export type TableToolbarMode = "cell" | "line";
export type TableToolbarPosition = { x: number; y: number };

export function getTableCellSelectionRange(table: SigmaTableSpec, selection: TableCellSelection): TableCellRange | null {
  if (
    !isTableCellPositionInBounds(table, selection.anchor.rowIndex, selection.anchor.columnIndex) ||
    !isTableCellPositionInBounds(table, selection.focus.rowIndex, selection.focus.columnIndex)
  ) {
    return null;
  }

  return normalizeTableCellRange(selection);
}

export function normalizeTableCellRange(selection: TableCellSelection): TableCellRange {
  return {
    startRow: Math.min(selection.anchor.rowIndex, selection.focus.rowIndex),
    endRow: Math.max(selection.anchor.rowIndex, selection.focus.rowIndex),
    startColumn: Math.min(selection.anchor.columnIndex, selection.focus.columnIndex),
    endColumn: Math.max(selection.anchor.columnIndex, selection.focus.columnIndex),
  };
}

export function rangeToSelection(range: TableCellRange): TableCellSelection {
  return {
    anchor: { rowIndex: range.startRow, columnIndex: range.startColumn },
    focus: { rowIndex: range.endRow, columnIndex: range.endColumn },
  };
}

export function isTablePositionInRange(range: TableCellRange, position: TableCellPosition): boolean {
  return position.rowIndex >= range.startRow &&
    position.rowIndex <= range.endRow &&
    position.columnIndex >= range.startColumn &&
    position.columnIndex <= range.endColumn;
}

export function tableCellIntersectsRange(
  range: TableCellRange,
  rowIndex: number,
  columnIndex: number,
  rowSpan = 1,
  colSpan = 1,
): boolean {
  const endRow = rowIndex + Math.max(1, rowSpan) - 1;
  const endColumn = columnIndex + Math.max(1, colSpan) - 1;
  return rowIndex <= range.endRow &&
    endRow >= range.startRow &&
    columnIndex <= range.endColumn &&
    endColumn >= range.startColumn;
}

export function tableCellMatchesDeletePreview(
  range: TableCellRange,
  preview: TableDeletePreview,
  rowIndex: number,
  columnIndex: number,
  rowSpan = 1,
  colSpan = 1,
): boolean {
  if (preview === "rows") {
    return rowIndex <= range.endRow && rowIndex + Math.max(1, rowSpan) - 1 >= range.startRow;
  }

  return columnIndex <= range.endColumn && columnIndex + Math.max(1, colSpan) - 1 >= range.startColumn;
}

export function getRowIdsInRange(table: SigmaTableSpec, range: TableCellRange): string[] {
  const startRow = clampTableIndex(range.startRow, table.rows.length);
  const endRow = clampTableIndex(range.endRow, table.rows.length);
  return table.rows.slice(startRow, endRow + 1).map((row) => row.id);
}

export function getColumnIdsInRange(table: SigmaTableSpec, range: TableCellRange): string[] {
  const startColumn = clampTableIndex(range.startColumn, table.columns.length);
  const endColumn = clampTableIndex(range.endColumn, table.columns.length);
  return table.columns.slice(startColumn, endColumn + 1).map((column) => column.id);
}

export function getNearestTableSelectionAfterDelete(table: SigmaTableSpec, range: TableCellRange): TableCellSelection | null {
  if (table.rows.length === 0 || table.columns.length === 0) {
    return null;
  }

  const position = {
    rowIndex: clampTableIndex(range.startRow, table.rows.length),
    columnIndex: clampTableIndex(range.startColumn, table.columns.length),
  };
  return {
    anchor: position,
    focus: position,
  };
}

/** Hit-test an editing destination only; measured rectangles never determine table layout. */
export function getTableContentIdFromClientPoint(
  cellElement: HTMLTableCellElement | null,
  clientX: number,
  clientY: number,
): string | null {
  for (const element of cellElement?.querySelectorAll<HTMLElement>("[data-table-content-id]") ?? []) {
    const bounds = element.getBoundingClientRect();
    if (clientX >= bounds.left && clientX <= bounds.right
      && clientY >= bounds.top && clientY <= bounds.bottom) {
      return element.dataset.tableContentId ?? null;
    }
  }
  return null;
}

export function getTableCellPositionFromClientPoint(
  tableElement: HTMLTableElement | null,
  tableWidth: number,
  tableHeight: number,
  columnOffsets: number[],
  rowOffsets: number[],
  clientX: number,
  clientY: number,
): TableCellPosition | null {
  const rect = tableElement?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || columnOffsets.length < 2 || rowOffsets.length < 2) {
    return null;
  }

  const localWidth = columnOffsets[columnOffsets.length - 1] || tableWidth;
  const localHeight = rowOffsets[rowOffsets.length - 1] || tableHeight;
  const scaleX = rect.width / Math.max(1, tableWidth);
  const scaleY = rect.height / Math.max(1, tableHeight);
  const localX = clamp((clientX - rect.left) / Math.max(0.01, scaleX), 0, Math.max(0, localWidth - 0.001));
  const localY = clamp((clientY - rect.top) / Math.max(0.01, scaleY), 0, Math.max(0, localHeight - 0.001));

  return {
    rowIndex: getTrackIndexFromOffset(rowOffsets, localY),
    columnIndex: getTrackIndexFromOffset(columnOffsets, localX),
  };
}

export function getTrackIndexFromOffset(offsets: number[], value: number): number {
  for (let index = 0; index < offsets.length - 1; index += 1) {
    if (value < offsets[index + 1] || index === offsets.length - 2) {
      return index;
    }
  }

  return 0;
}

export function clampTableIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.trunc(clamp(index, 0, length - 1));
}

export function getTableParagraphEditorKey(cellId: string, contentId: string): string {
  return `${cellId}:${contentId}`;
}

export function getTableCellNavigationDirection(event: KeyboardEvent): TableCellNavigationDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
    return null;
  }

  if (event.key === "ArrowLeft") {
    return "left";
  }
  if (event.key === "ArrowRight") {
    return "right";
  }
  if (event.key === "ArrowUp") {
    return "up";
  }
  if (event.key === "ArrowDown") {
    return "down";
  }

  return null;
}

export function shouldNavigateTableCell(view: TableEditorViewLike, direction: TableCellNavigationDirection): boolean {
  const { selection } = view.state;
  if (!selection.empty) {
    return false;
  }

  if (direction === "left") {
    const domAtStart = isDomSelectionAtHorizontalEdge(view, "left");
    if (domAtStart !== null) {
      return domAtStart;
    }
    return selection.$from.parentOffset <= 0;
  }
  if (direction === "right") {
    const domAtEnd = isDomSelectionAtHorizontalEdge(view, "right");
    if (domAtEnd !== null) {
      return domAtEnd;
    }
    return selection.$to.parentOffset >= selection.$to.parent.content.size;
  }

  return isTableCellCaretAtVerticalEdge(view, direction);
}

export function isDomSelectionAtHorizontalEdge(
  view: TableEditorViewLike,
  direction: Extract<TableCellNavigationDirection, "left" | "right">,
): boolean | null {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || !selection.anchorNode || !view.dom.contains(selection.anchorNode)) {
    return null;
  }

  const { anchorNode, anchorOffset } = selection;
  if (view.posAtDOM) {
    try {
      const domPosition = view.posAtDOM(anchorNode, anchorOffset);
      const docStart = 1;
      const docEnd = Math.max(docStart, view.state.doc.content.size - 1);
      return direction === "left" ? domPosition <= docStart : domPosition >= docEnd;
    } catch {
      // Fall through to a conservative DOM-only check.
    }
  }

  if (anchorNode.nodeType === Node.TEXT_NODE) {
    const textLength = anchorNode.textContent?.length ?? 0;
    return direction === "left" ? anchorOffset <= 0 : anchorOffset >= textLength;
  }

  return direction === "left"
    ? anchorOffset <= 0
    : anchorOffset >= anchorNode.childNodes.length;
}

export function isTableCellCaretAtVerticalEdge(
  view: TableEditorViewLike,
  direction: Extract<TableCellNavigationDirection, "up" | "down">,
): boolean {
  const { selection } = view.state;
  try {
    const caretRect = view.coordsAtPos(selection.from);
    const editorRect = view.dom.getBoundingClientRect();
    const caretHeight = Math.max(1, caretRect.bottom - caretRect.top);
    const tolerance = Math.max(4, caretHeight * 0.45);

    return direction === "up"
      ? caretRect.top <= editorRect.top + tolerance
      : caretRect.bottom >= editorRect.bottom - tolerance;
  } catch {
    const endPosition = Math.max(1, view.state.doc.content.size - 1);
    return direction === "up" ? selection.from <= 1 : selection.to >= endPosition;
  }
}

export function getNextTableCellPosition(
  rowIndex: number,
  columnIndex: number,
  direction: TableCellNavigationDirection,
): { rowIndex: number; columnIndex: number } {
  if (direction === "left") {
    return { rowIndex, columnIndex: columnIndex - 1 };
  }
  if (direction === "right") {
    return { rowIndex, columnIndex: columnIndex + 1 };
  }
  if (direction === "up") {
    return { rowIndex: rowIndex - 1, columnIndex };
  }
  return { rowIndex: rowIndex + 1, columnIndex };
}

export function getTableCellFocusPlacement(direction: TableCellNavigationDirection): TableCellFocusPlacement {
  return direction === "left" || direction === "up" ? "end" : "start";
}

export function focusTableParagraphEditor(editor: TiptapEditor, placement: TableCellFocusPlacement): void {
  const position = placement === "end"
    ? Math.max(1, editor.state.doc.content.size - 1)
    : 1;
  editor.chain().focus().setTextSelection(position).run();
}

export function isTableCellPositionInBounds(table: SigmaTableSpec, rowIndex: number, columnIndex: number): boolean {
  return rowIndex >= 0 &&
    rowIndex < table.rows.length &&
    columnIndex >= 0 &&
    columnIndex < table.columns.length;
}

export function getTableCellAtGridPosition(
  table: SigmaTableSpec,
  rowIndex: number,
  columnIndex: number,
): SigmaTableCell | null {
  if (!isTableCellPositionInBounds(table, rowIndex, columnIndex)) {
    return null;
  }

  return table.cells.find((cell) => {
    const cellRowIndex = table.rows.findIndex((row) => row.id === cell.rowId);
    const cellColumnIndex = table.columns.findIndex((column) => column.id === cell.columnId);
    if (cellRowIndex < 0 || cellColumnIndex < 0) {
      return false;
    }

    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    return rowIndex >= cellRowIndex &&
      rowIndex < cellRowIndex + rowSpan &&
      columnIndex >= cellColumnIndex &&
      columnIndex < cellColumnIndex + colSpan;
  }) ?? null;
}

export function getFirstTableParagraphContent(
  cell: SigmaTableCell,
): Extract<SigmaTableCellContent, { type: "paragraph" }> | null {
  return cell.content.find((content): content is Extract<SigmaTableCellContent, { type: "paragraph" }> => (
    content.type === "paragraph"
  )) ?? null;
}

export function tableLineKeysMatch(left: SigmaTableGridLineKey, right: SigmaTableGridLineKey): boolean {
  return getTableLineDomKey(left) === getTableLineDomKey(right);
}

/**
 * 罫線の呼び名。**文言の出典は `settings.table.line.*` の 1 つだけ。**
 * 以前は `TableSettingsDialog` が同じ判定を翻訳付きで書き写して持っており、
 * こちらは日本語のまま残っていた (同じ語の実装が 2 つある状態)。
 */
export function getTableLineLabel(
  table: SigmaTableSpec,
  key: SigmaTableGridLineKey,
  t: Translate<"settings">,
): string {
  if (key.axis === "vertical") {
    if ("edge" in key) {
      return key.edge === "left" ? t("table.line.edgeLeft") : t("table.line.edgeRight");
    }

    const columnIndex = table.columns.findIndex((column) => column.id === key.beforeColumnId);
    return columnIndex > 0
      ? t("table.line.betweenColumns", { first: columnIndex, second: columnIndex + 1 })
      : t("table.line.vertical");
  }

  if ("edge" in key) {
    return key.edge === "top" ? t("table.line.edgeTop") : t("table.line.edgeBottom");
  }

  const rowIndex = table.rows.findIndex((row) => row.id === key.beforeRowId);
  return rowIndex > 0
    ? t("table.line.betweenRows", { first: rowIndex, second: rowIndex + 1 })
    : t("table.line.horizontal");
}

export function getAllTableLineKeys(table: SigmaTableSpec): SigmaTableGridLineKey[] {
  return [
    ...Array.from({ length: table.columns.length + 1 }, (_, index) => getTableVerticalLineKey(table, index)).filter((key): key is SigmaTableGridLineKey => Boolean(key)),
    ...Array.from({ length: table.rows.length + 1 }, (_, index) => getTableHorizontalLineKey(table, index)).filter((key): key is SigmaTableGridLineKey => Boolean(key)),
  ];
}

export function getOuterTableLineKeys(table: SigmaTableSpec): SigmaTableGridLineKey[] {
  return [
    getTableVerticalLineKey(table, 0),
    getTableVerticalLineKey(table, table.columns.length),
    getTableHorizontalLineKey(table, 0),
    getTableHorizontalLineKey(table, table.rows.length),
  ].filter((key): key is SigmaTableGridLineKey => Boolean(key));
}

export function getInnerTableLineKeys(table: SigmaTableSpec): SigmaTableGridLineKey[] {
  return [
    ...Array.from({ length: Math.max(0, table.columns.length - 1) }, (_, index) => getTableVerticalLineKey(table, index + 1)).filter((key): key is SigmaTableGridLineKey => Boolean(key)),
    ...Array.from({ length: Math.max(0, table.rows.length - 1) }, (_, index) => getTableHorizontalLineKey(table, index + 1)).filter((key): key is SigmaTableGridLineKey => Boolean(key)),
  ];
}

export function tableCellIntersectsRangeById(table: SigmaTableSpec, cell: SigmaTableCell, range: TableCellRange): boolean {
  const rowIndex = table.rows.findIndex((row) => row.id === cell.rowId);
  const columnIndex = table.columns.findIndex((column) => column.id === cell.columnId);
  if (rowIndex < 0 || columnIndex < 0) {
    return false;
  }
  return tableCellIntersectsRange(range, rowIndex, columnIndex, cell.rowSpan ?? 1, cell.colSpan ?? 1);
}

export function getRangeIndexes(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export function fixedTableTrack(value: number): SigmaTableTrackSize {
  return { mode: "fixed", value: Math.max(1, value) };
}

export function tableTrackToPx(track: SigmaTableTrackSize, fallback: number): number {
  if (track.mode === "fixed") return track.value;
  if (track.mode === "auto") return track.min ?? fallback;
  return track.min ?? fallback;
}

export function mmToTablePx(value: number): number {
  // 列幅・行高は上限を設けず自由に指定できるようにする（fixedTableTrack 側で最小1pxだけ担保）。
  return Math.max(0, value) * MM_TO_PX;
}

export function pxToTableMm(value: number): number {
  return value / MM_TO_PX;
}

export function formatTableMm(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : "";
}

export function sumPositive(values: number[]): number {
  return Math.max(1, values.reduce((sum, value) => sum + Math.max(1, value), 0));
}

export function getSharedPrimitive<T extends string | number | boolean>(values: T[]): T | null {
  if (values.length === 0) {
    return null;
  }
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

export function getSharedRoundedNumber(values: number[]): number | null {
  const rounded = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value * 10) / 10);
  return getSharedPrimitive(rounded);
}

export function applyTableCellStyleToRange(
  table: SigmaTableSpec,
  range: TableCellRange,
  style: Partial<SigmaTableCellStyle>,
): SigmaTableSpec {
  return {
    ...table,
    cells: table.cells.map((cell) => (
      tableCellIntersectsRangeById(table, cell, range)
        ? {
            ...cell,
            style: { ...(cell.style ?? {}), ...style },
            // Paragraph alignment overrides the inherited cell style in every renderer.
            content: style.align === undefined ? cell.content : cell.content.map((content) => (
              content.type === "paragraph" ? { ...content, align: style.align } : content
            )),
          }
        : cell
    )),
  };
}

export function getDefaultTableToolbarPosition({
  mode,
  cellRange,
  line,
  table,
  columnOffsets,
  rowOffsets,
  shapeWidth,
  shapeHeight,
}: {
  mode: TableToolbarMode;
  cellRange: TableCellRange | null;
  line: SigmaTableGridLineKey | null;
  table: SigmaTableSpec;
  columnOffsets: number[];
  rowOffsets: number[];
  shapeWidth: number;
  shapeHeight: number;
}): TableToolbarPosition {
  if (mode === "cell" && cellRange) {
    const left = columnOffsets[cellRange.startColumn] ?? 0;
    const top = rowOffsets[cellRange.startRow] ?? 0;
    const belowTop = (rowOffsets[cellRange.endRow + 1] ?? top) + 8;
    return {
      x: clamp(left, -8, Math.max(0, shapeWidth - 48)),
      y: clamp(top - 44 < -50 ? belowTop : top - 44, -50, Math.max(0, shapeHeight - 28)),
    };
  }

  if (mode === "line" && line) {
    const position = getTableLineToolbarAnchor(table, line, columnOffsets, rowOffsets);
    return {
      x: clamp(position.x, -8, Math.max(0, shapeWidth - 48)),
      y: clamp(position.y, -50, Math.max(0, shapeHeight - 28)),
    };
  }

  return { x: 0, y: -44 };
}

export function getTableLineToolbarAnchor(
  table: SigmaTableSpec,
  line: SigmaTableGridLineKey,
  columnOffsets: number[],
  rowOffsets: number[],
): TableToolbarPosition {
  if (line.axis === "vertical") {
    const index = "edge" in line
      ? line.edge === "left" ? 0 : table.columns.length
      : table.columns.findIndex((column) => column.id === line.beforeColumnId);
    return { x: columnOffsets[index] ?? 0, y: -44 };
  }

  const index = "edge" in line
    ? line.edge === "top" ? 0 : table.rows.length
    : table.rows.findIndex((row) => row.id === line.beforeRowId);
  return { x: 8, y: (rowOffsets[index] ?? 0) - 44 };
}

/*
 * `measureRenderedTableRowOffsets` / `getRenderedElementScale` / `tableOffsetArraysEqual` /
 * `getSegmentSizes` used to live here: the editor read its rendered `<tr>` rects back out of the
 * DOM (through a `ResizeObserver`) and drew the `double` line overlay and the row boundary handles
 * from that instead of from the model. They existed because the resolved row heights could add up
 * to less than the shape's height, which let the browser stretch the rows out from under the model.
 * `resolveTrackSizes` guarantees the total now, so the model's offsets are what every surface draws
 * and there is nothing left to measure. `shape-renderer-architecture.test.ts` pins their absence.
 */
