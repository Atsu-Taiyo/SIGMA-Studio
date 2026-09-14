"use client";

import { getTableCellMatrix } from "@/features/document";

import type { Editor as TiptapEditor } from "@tiptap/core";
import  {
  AlignCenter,
  AlignLeft,
  AlignRight,
  GripVertical,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Type,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import  {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FloatingEditorToolbar } from "./floating-editor-toolbar";

import type { TextAlign } from "@/features/document";

import type { SigmaTableFormulaErrorCode } from "@/features/document";
import { getTableCellFormulaResult } from "@/features/document";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import  {
  OVERLAY_LINE_WIDTH_VALUES,
  OverlayLineDashMenuButton,
  OverlayLineWidthMenuButton,
  OverlayTextAlignMenuButton,
  type OverlayLineDashOption,
  type OverlayTextAlignOption,
} from "../overlay-line-style-menus";
import { clamp } from "./math";
import type { TableShapeResizePatch } from "./shape-editor-types";
import  {
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_ROW_HEIGHT,
  MIN_TABLE_COLUMN_WIDTH,
  MIN_TABLE_ROW_HEIGHT,
  getTableHorizontalLineKey,
  getTableVerticalLineKey,
  insertTableColumn,
  insertTableRow,
  isTableLineKeyValid,
  removeTableColumns,
  removeTableRows,
  resizeTableColumnBoundary,
  resizeTableColumnEdge,
  resizeTableRowBoundary,
  resizeTableRowEdge,
  resolveTableColumnWidths,
  resolveTableLineBorder,
  resolveTableRowHeights,
  upsertTableLineOverride,
  type SigmaTableGridLineKey,
} from "./shapes/table";
import  {
  applyTableCellStyleToRange,
  fixedTableTrack,
  focusTableParagraphEditor,
  formatTableMm,
  getAllTableLineKeys,
  getColumnIdsInRange,
  getCumulativeOffsets,
  getDefaultTableToolbarPosition,
  getFirstTableParagraphContent,
  getInnerTableLineKeys,
  getNearestTableSelectionAfterDelete,
  getNextTableCellPosition,
  getOuterTableLineKeys,
  getRangeIndexes,
  getRowIdsInRange,
  getSharedPrimitive,
  getSharedRoundedNumber,
  getTableCellAtGridPosition,
  getTableCellContentLayerStyle,
  getTableCellFocusPlacement,
  getTableCellPositionFromClientPoint,
  getTableCellSelectionRange,
  getTableCellStyle,
  getTableLineDomKey,
  getTableLineLabel,
  getTableParagraphEditorKey,
  isTableCellPositionInBounds,
  isTablePositionInRange,
  mmToTablePx,
  normalizeTableCellRange,
  pxToTableMm,
  rangeToSelection,
  sumPositive,
  tableCellIntersectsRange,
  tableCellIntersectsRangeById,
  tableCellMatchesDeletePreview,
  tableLineKeysMatch,
  tableTrackToPx,
  type TableCellFocusPlacement,
  type TableCellNavigationDirection,
  type TableCellPosition,
  type TableCellRange,
  type TableCellSelection,
  type TableDeletePreview,
  type TableToolbarMode,
} from "./shapes/table-editor-model";
import { OverlayTableCellContentEditor } from "./table-cell-content-editor";
import { OverlayTableRenderedLines } from "./table-rendered-lines";
import type  {
  OverlayShape,
  OverlayShapeId,
  OverlayTextSize,
  SigmaTableCell,
  SigmaTableCellContent,
  SigmaTableGridLineStyle,
  SigmaTableSpec,
} from "./types";

/**
 * The sentence for each error value, by the value itself.
 *
 * The keys are the canonical Excel strings the document layer produces, so a new error code cannot
 * be added there without this map failing to compile.
 */
const TABLE_FORMULA_ERROR_LABEL_KEYS = {
  "#DIV/0!": "table.formula.error.divideByZero",
  "#NAME?": "table.formula.error.name",
  "#REF!": "table.formula.error.ref",
  "#VALUE!": "table.formula.error.value",
  "#NUM!": "table.formula.error.num",
  "#N/A": "table.formula.error.na",
  "#CYCLE!": "table.formula.error.cycle",
  // `as const` keeps the literal key types the translator demands; `satisfies` makes a new error
  // code in the document layer a compile error here rather than a missing tooltip.
} as const satisfies Record<SigmaTableFormulaErrorCode, string>;

/** The error a cell's formula ended in, or `null` when it holds no formula or evaluates cleanly. */
function getTableCellFormulaErrorCode(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
): SigmaTableFormulaErrorCode | null {
  if (!cell) {
    return null;
  }
  const paragraph = getFirstTableParagraphContent(cell);
  if (!paragraph) {
    return null;
  }
  return getTableCellFormulaResult(table, cell, paragraph)?.error ?? null;
}

const TABLE_ADD_CONTROL_HIDE_DELAY_MS = 500;

type TableResizeDrag =
  | {
      type: "columnBoundary";
      boundaryIndex: number;
      startClientX: number;
      leftWidth: number;
      rightWidth: number;
    }
  | {
      type: "rowBoundary";
      boundaryIndex: number;
      startClientY: number;
      topHeight: number;
      bottomHeight: number;
    }
  | {
      type: "columnEdge";
      edge: "left" | "right";
      startClientX: number;
      startShapeX: number;
      startShapeW: number;
      edgeWidth: number;
    }
  | {
      type: "rowEdge";
      edge: "top" | "bottom";
      startClientY: number;
      startShapeY: number;
      startShapeH: number;
      edgeHeight: number;
    };

interface TableCellSelectionDrag {
  anchor: TableCellPosition;
  startClientX: number;
  startClientY: number;
  active: boolean;
}

interface TableContextMenuState {
  x: number;
  y: number;
  range: TableCellRange;
}

type TableBorderStyle = NonNullable<SigmaTableSpec["grid"]["borderStyle"]>;
type TableLineStyleOption = TableBorderStyle | "none";

/**
 * 罫線の線種は上部メニューバーの線種ドロップダウンに「線なし」と「二重線」を加えたもの。
 * 文言は**ツールバーと同じ出典** (`chrome.format.lineDash.*`) から引く。この `label` は
 * `線の種類を変える（…）` へ補間されるので、ここが日本語のままだと英語 UI で混在する。
 */
function buildTableLineStyleOptions(t: Translate<"chrome">): OverlayLineDashOption<TableLineStyleOption>[] {
  return [
    { value: "none", label: t("format.lineDash.none"), hidden: true },
    { value: "solid", label: t("format.lineDash.solid") },
    { value: "dashed", label: t("format.lineDash.dashed"), dasharray: "8 5" },
    { value: "dotted", label: t("format.lineDash.dotted"), dasharray: "1 5" },
    { value: "double", label: t("format.lineDash.double"), double: true },
  ];
}

/**
 * 文字揃えの選択肢。**文言は辞書から引く** — この `label` は
 * `overlay-line-style-menus.tsx` の `文字の配置（現在: …）` に補間されるので、
 * ここが日本語のままだと英語 UI で混在した文になる。
 */
function buildTableAlignOptions(t: Translate<"chrome">): OverlayTextAlignOption<TextAlign>[] {
  return [
    { value: "left", label: t("format.align.left"), icon: AlignLeft },
    { value: "center", label: t("format.align.center"), icon: AlignCenter },
    { value: "right", label: t("format.align.right"), icon: AlignRight },
  ];
}

// 罫線の太さは上部メニューバーの線幅（細/中/太/極太）と同じドロップダウンを使うため、
// テーブル側の px 値と OverlayTextSize を相互変換する。
const TABLE_BORDER_WIDTH_BY_SIZE: Record<OverlayTextSize, number> = { s: 1, m: 2, l: 3, xl: 4 };

function tableBorderWidthToSize(width: number | null): OverlayTextSize | null {
  if (width === null) {
    return null;
  }
  let best: OverlayTextSize = "m";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const option of OVERLAY_LINE_WIDTH_VALUES) {
    const diff = Math.abs(TABLE_BORDER_WIDTH_BY_SIZE[option.value] - width);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = option.value;
    }
  }
  return best;
}


export function OverlayTableShapeEditor({
  shape,
  editing,
  onFocus,
  onChange,
  onResize,
  onCreateChart,
  onFirstCellReady,
}: {
  shape: Extract<OverlayShape, { type: "tableShape" }>;
  editing: boolean;
  onFocus: (editor: TiptapEditor, shapeId: OverlayShapeId) => void;
  onChange: (shapeId: OverlayShapeId, table: SigmaTableSpec) => void;
  onResize: (shapeId: OverlayShapeId, patch: TableShapeResizePatch) => void;
  /** Called only once its first paragraph editor can receive focus. */
  onFirstCellReady?: (editor: TiptapEditor, shapeId: OverlayShapeId) => void;
  /** Absent on surfaces that cannot insert shapes; the menu item is then hidden. */
  onCreateChart?: (shapeId: OverlayShapeId) => void;
}) {
  const tChrome = useT("chrome");
  // 罫線の呼び名は表の設定ダイアログと同じ出典 (`settings.table.line.*`)。
  const tSettings = useT("settings");
  const tShape = useT("shape");
  const table = shape.props.table;
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const tableLayoutWidth = Math.max(1, shape.props.w);
  const columnWidths = useMemo(() => resolveTableColumnWidths(table, tableLayoutWidth), [tableLayoutWidth, table]);
  const rowHeights = useMemo(() => resolveTableRowHeights(table, shape.props.h), [shape.props.h, table]);
  const columnOffsets = useMemo(() => getCumulativeOffsets(columnWidths), [columnWidths]);
  const rowOffsets = useMemo(() => getCumulativeOffsets(rowHeights), [rowHeights]);
  const [resizeDrag, setResizeDrag] = useState<TableResizeDrag | null>(null);
  const [selectedLines, setSelectedLines] = useState<SigmaTableGridLineKey[]>([]);
  const [cellSelection, setCellSelection] = useState<TableCellSelection | null>(null);
  const [cellSelectionDrag, setCellSelectionDrag] = useState<TableCellSelectionDrag | null>(null);
  const [contextMenu, setContextMenu] = useState<TableContextMenuState | null>(null);
  const [deletePreview, setDeletePreview] = useState<TableDeletePreview | null>(null);
  const [lineStyleMenuOpen, setLineStyleMenuOpen] = useState(false);
  const [lineWidthMenuOpen, setLineWidthMenuOpen] = useState(false);
  const [cellAlignMenuOpen, setCellAlignMenuOpen] = useState(false);
  const lineStyleButtonRef = useRef<HTMLButtonElement | null>(null);
  const lineWidthButtonRef = useRef<HTMLButtonElement | null>(null);
  const cellAlignButtonRef = useRef<HTMLButtonElement | null>(null);
  const [activeAddBoundaryKeys, setActiveAddBoundaryKeys] = useState<Set<string>>(() => new Set());
  const addControlHideTimeoutsRef = useRef<Map<string, number>>(new Map());
  const tableCellEditorsRef = useRef<Map<string, TiptapEditor>>(new Map());
  /**
   * The cell whose formula is being edited as source, or `null` when every formula cell shows its
   * value. Only this cell mounts a Tiptap editor for its formula.
   */
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  /**
   * A focus that has to wait for its editor to mount.
   *
   * Reaching a formula cell — by arrow key or by click — makes it show its source, and only then
   * does its editor exist. Without this, arrow navigation walked straight past every formula cell,
   * because it looks for an editor that has not been created yet.
   */
  const pendingCellFocusRef = useRef<
    { cellId: string; contentId: string; placement: TableCellFocusPlacement; clientPoint?: { left: number; top: number } } | null
  >(null);

  const activeSelectedLines = useMemo(
    () => editing ? selectedLines.filter((line) => isTableLineKeyValid(table, line)) : [],
    [editing, selectedLines, table],
  );
  const activeSelectedLine = activeSelectedLines[0] ?? null;
  const activeCellRange = editing && cellSelection
    ? getTableCellSelectionRange(table, cellSelection)
    : null;
  const toolbarMode: TableToolbarMode | null = activeSelectedLines.length > 0
    ? "line"
    : activeCellRange
      ? "cell"
      : null;
  const selectedLineBorders = activeSelectedLines.map((line) => resolveTableLineBorder(table, line));
  const { origins } = getTableCellMatrix(table);
  const wasEditingRef = useRef(editing);

  useEffect(() => {
    const enteredEditing = editing && !wasEditingRef.current;
    wasEditingRef.current = editing;
    if (!enteredEditing || table.rows.length === 0 || table.columns.length === 0) {
      return;
    }

    // Entering edit mode starts with every formula showing its value; `showFormulaSource` is also
    // gated on `editing`, so leaving edit mode needs no reset of its own.
    setFocusedCellId(null);
    pendingCellFocusRef.current = null;

    // 表そのものから編集へ入った直後は全セルを対象にする。
    // その後セルをクリック／ドラッグすれば通常のセル範囲指定へ切り替わる。
    setCellSelection({
      anchor: { rowIndex: 0, columnIndex: 0 },
      focus: {
        rowIndex: table.rows.length - 1,
        columnIndex: table.columns.length - 1,
      },
    });
  }, [editing, table.columns.length, table.rows.length]);

  const firstCell = getTableCellAtGridPosition(table, 0, 0);
  const firstParagraph = firstCell ? getFirstTableParagraphContent(firstCell) : null;
  const registerTableCellEditor = useCallback((cellId: string, contentId: string, editor: TiptapEditor) => {
    const editorKey = getTableParagraphEditorKey(cellId, contentId);
    tableCellEditorsRef.current.set(editorKey, editor);
    if (cellId === firstCell?.id && contentId === firstParagraph?.id) {
      onFirstCellReady?.(editor, shape.id);
    }
    const pending = pendingCellFocusRef.current;
    if (pending && pending.cellId === cellId && pending.contentId === contentId) {
      pendingCellFocusRef.current = null;
      focusTableParagraphEditor(editor, pending.placement);
      if (pending.clientPoint && !editor.isDestroyed) {
        const position = editor.view.posAtCoords(pending.clientPoint);
        if (position) editor.commands.setTextSelection(position.pos);
      }
    }
    return () => {
      if (tableCellEditorsRef.current.get(editorKey) === editor) {
        tableCellEditorsRef.current.delete(editorKey);
      }
    };
  }, [firstCell?.id, firstParagraph?.id, onFirstCellReady, shape.id]);

  const focusTableCell = useCallback((
    rowIndex: number,
    columnIndex: number,
    direction: TableCellNavigationDirection,
  ): boolean => {
    let nextPosition = getNextTableCellPosition(rowIndex, columnIndex, direction);
    while (isTableCellPositionInBounds(table, nextPosition.rowIndex, nextPosition.columnIndex)) {
      const targetCell = getTableCellAtGridPosition(table, nextPosition.rowIndex, nextPosition.columnIndex);
      const targetParagraph = targetCell ? getFirstTableParagraphContent(targetCell) : null;
      const targetEditor = targetCell && targetParagraph
        ? tableCellEditorsRef.current.get(getTableParagraphEditorKey(targetCell.id, targetParagraph.id))
        : null;

      if (targetEditor && !targetEditor.isDestroyed) {
        setFocusedCellId(targetCell?.id ?? null);
        focusTableParagraphEditor(targetEditor, getTableCellFocusPlacement(direction));
        return true;
      }

      // Inactive cells have no editor. Mount just the destination, then focus it when registered.
      if (targetCell && targetParagraph) {
        pendingCellFocusRef.current = {
          cellId: targetCell.id,
          contentId: targetParagraph.id,
          placement: getTableCellFocusPlacement(direction),
        };
        setFocusedCellId(targetCell.id);
        return true;
      }

      nextPosition = getNextTableCellPosition(nextPosition.rowIndex, nextPosition.columnIndex, direction);
    }

    return false;
  }, [table]);

  const updateCellContent = (cellId: string, contentId: string, nextContent: SigmaTableCellContent) => {
    onChange(shape.id, {
      ...table,
      cells: table.cells.map((cell) => {
        if (cell.id !== cellId) {
          return cell;
        }

        return {
          ...cell,
          content: cell.content.map((content) => content.id === contentId ? nextContent : content),
        };
      }),
    });
  };

  const selectTableLine = (lineKey: SigmaTableGridLineKey, additive: boolean) => {
    setCellSelection(null);
    closeTableContextMenu();
    setSelectedLines((current) => {
      if (!additive) {
        return [lineKey];
      }

      const lineId = getTableLineDomKey(lineKey);
      if (current.some((line) => getTableLineDomKey(line) === lineId)) {
        return current.filter((line) => getTableLineDomKey(line) !== lineId);
      }
      return [...current, lineKey];
    });
  };

  const updateSelectedLineStyle = (style: SigmaTableGridLineStyle) => {
    if (activeSelectedLines.length === 0) {
      return;
    }

    const nextTable = activeSelectedLines.reduce(
      (next, line) => upsertTableLineOverride(next, line, style),
      table,
    );
    onChange(shape.id, nextTable);
  };

  const updateSelectedColumnWidthMm = (valueMm: number) => {
    if (!activeCellRange) {
      return;
    }

    const widthPx = mmToTablePx(valueMm);
    const targetColumns = new Set(getRangeIndexes(activeCellRange.startColumn, activeCellRange.endColumn));
    const columns = table.columns.map((column, index) => (
      targetColumns.has(index) ? { ...column, width: fixedTableTrack(widthPx) } : column
    ));
    const nextTable = { ...table, columns };
    const nextWidths = columns.map((column, index) => tableTrackToPx(column.width, columnWidths[index] ?? DEFAULT_TABLE_COLUMN_WIDTH));
    onResize(shape.id, {
      w: sumPositive(nextWidths),
      h: shape.props.h,
      table: nextTable,
    });
  };

  const updateSelectedRowHeightMm = (valueMm: number) => {
    if (!activeCellRange) {
      return;
    }

    const heightPx = mmToTablePx(valueMm);
    const targetRows = new Set(getRangeIndexes(activeCellRange.startRow, activeCellRange.endRow));
    const rows = table.rows.map((row, index) => (
      targetRows.has(index) ? { ...row, height: fixedTableTrack(heightPx) } : row
    ));
    const nextTable = { ...table, rows };
    const nextHeights = rows.map((row, index) => tableTrackToPx(row.height, rowHeights[index] ?? DEFAULT_TABLE_ROW_HEIGHT));
    onResize(shape.id, {
      w: shape.props.w,
      h: sumPositive(nextHeights),
      table: nextTable,
    });
  };

  const updateSelectedCellAlign = (align: TextAlign) => {
    if (!activeCellRange) {
      return;
    }
    onChange(shape.id, applyTableCellStyleToRange(table, activeCellRange, { align }));
  };

  const updateSelectedCellFontSize = (fontSize: number) => {
    if (!activeCellRange || !Number.isFinite(fontSize) || fontSize <= 0) {
      return;
    }
    onChange(shape.id, applyTableCellStyleToRange(table, activeCellRange, { fontSize }));
  };

  const insertContextColumn = (side: "left" | "right") => {
    if (!contextMenu) {
      return;
    }
    const insertIndex = side === "left" ? contextMenu.range.startColumn : contextMenu.range.endColumn + 1;
    onChange(shape.id, insertTableColumn(table, insertIndex));
    closeTableContextMenu();
  };

  const insertContextRow = (side: "above" | "below") => {
    if (!contextMenu) {
      return;
    }
    const insertIndex = side === "above" ? contextMenu.range.startRow : contextMenu.range.endRow + 1;
    onChange(shape.id, insertTableRow(table, insertIndex));
    closeTableContextMenu();
  };

  const selectTableLinesFromContext = (scope: "all" | "outer" | "inner") => {
    const lines = scope === "all"
      ? getAllTableLineKeys(table)
      : scope === "outer"
        ? getOuterTableLineKeys(table)
        : getInnerTableLineKeys(table);
    setCellSelection(null);
    setSelectedLines(lines);
    closeTableContextMenu();
  };

  const handleCellEditorFocus = (editor: TiptapEditor, shapeId: OverlayShapeId, cellId: string) => {
    setSelectedLines([]);
    setFocusedCellId(cellId);
    onFocus(editor, shapeId);
  };

  const closeTableContextMenu = () => {
    setContextMenu(null);
    setDeletePreview(null);
  };

  const handleCellPointerDownCapture = (
    event: ReactPointerEvent<HTMLTableCellElement>,
    rowIndex: number,
    columnIndex: number,
  ) => {
    if (!editing || event.button !== 0) {
      return;
    }

    const anchor = { rowIndex, columnIndex };
    const clickedCell = getTableCellAtGridPosition(table, rowIndex, columnIndex);
    const clickedParagraph = clickedCell ? getFirstTableParagraphContent(clickedCell) : null;
    setFocusedCellId(clickedCell?.id ?? null);
    const clickedEditor = clickedCell && clickedParagraph
      ? tableCellEditorsRef.current.get(getTableParagraphEditorKey(clickedCell.id, clickedParagraph.id))
      : null;
    if (clickedCell && clickedParagraph && (!clickedEditor || clickedEditor.isDestroyed)) {
      pendingCellFocusRef.current = {
        cellId: clickedCell.id,
        contentId: clickedParagraph.id,
        placement: "end",
        ...(getTableCellFormulaResult(table, clickedCell, clickedParagraph)
          ? {} : { clientPoint: { left: event.clientX, top: event.clientY } }),
      };
    }
    setSelectedLines([]);
    closeTableContextMenu();
    setCellSelection({ anchor, focus: anchor });
    setCellSelectionDrag({
      anchor,
      startClientX: event.clientX,
      startClientY: event.clientY,
      active: false,
    });
  };

  const handleCellContextMenu = (
    event: ReactMouseEvent<HTMLTableCellElement>,
    rowIndex: number,
    columnIndex: number,
  ) => {
    if (!editing) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const clickedPosition = { rowIndex, columnIndex };
    const range = activeCellRange && isTablePositionInRange(activeCellRange, clickedPosition)
      ? activeCellRange
      : normalizeTableCellRange({ anchor: clickedPosition, focus: clickedPosition });
    setSelectedLines([]);
    setCellSelection(rangeToSelection(range));
    setContextMenu({
      x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 188)),
      y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 104)),
      range,
    });
    setDeletePreview(null);
  };

  const deleteContextRows = () => {
    if (!contextMenu) {
      return;
    }

    const rowIds = getRowIdsInRange(table, contextMenu.range);
    if (rowIds.length === 0 || rowIds.length >= table.rows.length) {
      return;
    }

    const nextTable = removeTableRows(table, rowIds);
    onChange(shape.id, nextTable);
    setCellSelection(getNearestTableSelectionAfterDelete(nextTable, contextMenu.range));
    closeTableContextMenu();
  };

  const deleteContextColumns = () => {
    if (!contextMenu) {
      return;
    }

    const columnIds = getColumnIdsInRange(table, contextMenu.range);
    if (columnIds.length === 0 || columnIds.length >= table.columns.length) {
      return;
    }

    const nextTable = removeTableColumns(table, columnIds);
    onChange(shape.id, nextTable);
    setCellSelection(getNearestTableSelectionAfterDelete(nextTable, contextMenu.range));
    closeTableContextMenu();
  };

  const getTableResizeScale = useCallback(() => {
    const rect = tableElementRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
      return 1;
    }

    return rect.width / tableLayoutWidth;
  }, [tableLayoutWidth]);

  const startColumnResize = (
    event: ReactPointerEvent<HTMLElement>,
    boundaryIndex: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setResizeDrag({
      type: "columnBoundary",
      boundaryIndex,
      startClientX: event.clientX,
      leftWidth: columnWidths[boundaryIndex],
      rightWidth: columnWidths[boundaryIndex + 1],
    });
  };

  const startColumnEdgeResize = (
    event: ReactPointerEvent<HTMLElement>,
    edge: "left" | "right",
  ) => {
    const edgeIndex = edge === "left" ? 0 : table.columns.length - 1;
    if (edgeIndex < 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setResizeDrag({
      type: "columnEdge",
      edge,
      startClientX: event.clientX,
      startShapeX: shape.x,
      startShapeW: shape.props.w,
      edgeWidth: columnWidths[edgeIndex] ?? MIN_TABLE_COLUMN_WIDTH,
    });
  };

  const startRowResize = (
    event: ReactPointerEvent<HTMLElement>,
    boundaryIndex: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setResizeDrag({
      type: "rowBoundary",
      boundaryIndex,
      startClientY: event.clientY,
      topHeight: rowHeights[boundaryIndex],
      bottomHeight: rowHeights[boundaryIndex + 1],
    });
  };

  const startRowEdgeResize = (
    event: ReactPointerEvent<HTMLElement>,
    edge: "top" | "bottom",
  ) => {
    const edgeIndex = edge === "top" ? 0 : table.rows.length - 1;
    if (edgeIndex < 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setResizeDrag({
      type: "rowEdge",
      edge,
      startClientY: event.clientY,
      startShapeY: shape.y,
      startShapeH: shape.props.h,
      edgeHeight: rowHeights[edgeIndex] ?? MIN_TABLE_ROW_HEIGHT,
    });
  };

  const clearAddControlHideTimeout = useCallback((boundaryKey?: string) => {
    if (boundaryKey === undefined) {
      for (const timeoutId of addControlHideTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      addControlHideTimeoutsRef.current.clear();
      return;
    }

    const timeoutId = addControlHideTimeoutsRef.current.get(boundaryKey);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      addControlHideTimeoutsRef.current.delete(boundaryKey);
    }
  }, []);

  const showAddControlForBoundary = useCallback((boundaryKey: string) => {
    clearAddControlHideTimeout(boundaryKey);
    setActiveAddBoundaryKeys((current) => {
      if (current.has(boundaryKey)) {
        return current;
      }
      const next = new Set(current);
      next.add(boundaryKey);
      return next;
    });
  }, [clearAddControlHideTimeout]);

  const hideAddControlAfterDelay = useCallback((boundaryKey: string) => {
    clearAddControlHideTimeout(boundaryKey);
    const timeoutId = window.setTimeout(() => {
      addControlHideTimeoutsRef.current.delete(boundaryKey);
      setActiveAddBoundaryKeys((current) => {
        if (!current.has(boundaryKey)) {
          return current;
        }
        const next = new Set(current);
        next.delete(boundaryKey);
        return next;
      });
    }, TABLE_ADD_CONTROL_HIDE_DELAY_MS);
    addControlHideTimeoutsRef.current.set(boundaryKey, timeoutId);
  }, [clearAddControlHideTimeout]);

  useEffect(() => clearAddControlHideTimeout, [clearAddControlHideTimeout]);

  useEffect(() => {
    if (!cellSelectionDrag) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const nextPosition = getTableCellPositionFromClientPoint(
        tableElementRef.current,
        tableLayoutWidth,
        shape.props.h,
        columnOffsets,
        rowOffsets,
        event.clientX,
        event.clientY,
      );
      if (!nextPosition) {
        return;
      }

      const active = cellSelectionDrag.active ||
        Math.hypot(event.clientX - cellSelectionDrag.startClientX, event.clientY - cellSelectionDrag.startClientY) >= 3;
      if (!active) {
        return;
      }

      event.preventDefault();
      tableElementRef.current?.ownerDocument.getSelection()?.removeAllRanges();
      if (!cellSelectionDrag.active) {
        setCellSelectionDrag({ ...cellSelectionDrag, active: true });
        // The press that started this drag opened the anchor cell's formula source. Selecting a
        // range is not editing that cell, so hand it back to its value — otherwise picking a range
        // to align or border makes one cell change its text under the pointer.
        setFocusedCellId(null);
        pendingCellFocusRef.current = null;
      }
      setCellSelection((current) => {
        if (
          current &&
          current.anchor.rowIndex === cellSelectionDrag.anchor.rowIndex &&
          current.anchor.columnIndex === cellSelectionDrag.anchor.columnIndex &&
          current.focus.rowIndex === nextPosition.rowIndex &&
          current.focus.columnIndex === nextPosition.columnIndex
        ) {
          return current;
        }
        return {
          anchor: cellSelectionDrag.anchor,
          focus: nextPosition,
        };
      });
    };

    const handlePointerUp = () => {
      setCellSelectionDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [cellSelectionDrag, columnOffsets, rowOffsets, shape.props.h, tableLayoutWidth]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".overlay-table-context-menu")) {
        return;
      }
      setContextMenu(null);
      setDeletePreview(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
        setDeletePreview(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!resizeDrag) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const resizeScale = Math.max(0.01, getTableResizeScale());

      if (resizeDrag.type === "columnBoundary") {
        const dx = (event.clientX - resizeDrag.startClientX) / resizeScale;
        const boundedDx = clamp(
          dx,
          MIN_TABLE_COLUMN_WIDTH - resizeDrag.leftWidth,
          resizeDrag.rightWidth - MIN_TABLE_COLUMN_WIDTH,
        );
        onChange(shape.id, resizeTableColumnBoundary(
          table,
          resizeDrag.boundaryIndex,
          resizeDrag.leftWidth + boundedDx,
          resizeDrag.rightWidth - boundedDx,
        ));
        return;
      }

      if (resizeDrag.type === "columnEdge") {
        const rawDelta = resizeDrag.edge === "left"
          ? (resizeDrag.startClientX - event.clientX) / resizeScale
          : (event.clientX - resizeDrag.startClientX) / resizeScale;
        const boundedDelta = Math.max(MIN_TABLE_COLUMN_WIDTH - resizeDrag.edgeWidth, rawDelta);
        const nextWidth = resizeDrag.edgeWidth + boundedDelta;
        const nextShapeW = Math.max(MIN_TABLE_COLUMN_WIDTH, resizeDrag.startShapeW + boundedDelta);
        onResize(shape.id, {
          x: resizeDrag.edge === "left" ? resizeDrag.startShapeX - boundedDelta : undefined,
          w: nextShapeW,
          h: shape.props.h,
          table: resizeTableColumnEdge(table, resizeDrag.edge, nextWidth),
        });
        return;
      }

      if (resizeDrag.type === "rowBoundary") {
        const dy = (event.clientY - resizeDrag.startClientY) / resizeScale;
        const boundedDy = clamp(
          dy,
          MIN_TABLE_ROW_HEIGHT - resizeDrag.topHeight,
          resizeDrag.bottomHeight - MIN_TABLE_ROW_HEIGHT,
        );
        onChange(shape.id, resizeTableRowBoundary(
          table,
          resizeDrag.boundaryIndex,
          resizeDrag.topHeight + boundedDy,
          resizeDrag.bottomHeight - boundedDy,
        ));
        return;
      }

      const rawDelta = resizeDrag.edge === "top"
        ? (resizeDrag.startClientY - event.clientY) / resizeScale
        : (event.clientY - resizeDrag.startClientY) / resizeScale;
      const boundedDelta = Math.max(MIN_TABLE_ROW_HEIGHT - resizeDrag.edgeHeight, rawDelta);
      const nextHeight = resizeDrag.edgeHeight + boundedDelta;
      const nextShapeH = Math.max(MIN_TABLE_ROW_HEIGHT, resizeDrag.startShapeH + boundedDelta);
      onResize(shape.id, {
        y: resizeDrag.edge === "top" ? resizeDrag.startShapeY - boundedDelta : undefined,
        w: shape.props.w,
        h: nextShapeH,
        table: resizeTableRowEdge(table, resizeDrag.edge, nextHeight),
      });
    };

    const handlePointerUp = () => {
      setResizeDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [getTableResizeScale, onChange, onResize, resizeDrag, shape.id, shape.props.h, shape.props.w, table]);

  const activeContextMenu = editing ? contextMenu : null;
  const activeDeletePreview = editing ? deletePreview : null;
  const contextRowIds = activeContextMenu ? getRowIdsInRange(table, activeContextMenu.range) : [];
  const contextColumnIds = activeContextMenu ? getColumnIdsInRange(table, activeContextMenu.range) : [];
  const canDeleteContextRows = contextRowIds.length > 0 && contextRowIds.length < table.rows.length;
  const canDeleteContextColumns = contextColumnIds.length > 0 && contextColumnIds.length < table.columns.length;
  const sharedLineStyle = getSharedPrimitive(selectedLineBorders.map((border): TableLineStyleOption => (
    border.visible ? border.borderStyle : "none"
  )));
  const sharedLineWidth = getSharedPrimitive(selectedLineBorders.map((border) => border.borderWidth));
  // 線幅は上部メニューバーの語彙（細/中/太/極太）へ写像する。
  const sharedLineSize = tableBorderWidthToSize(sharedLineWidth);
  const selectedCellColumnIndexes = activeCellRange ? getRangeIndexes(activeCellRange.startColumn, activeCellRange.endColumn) : [];
  const selectedCellRowIndexes = activeCellRange ? getRangeIndexes(activeCellRange.startRow, activeCellRange.endRow) : [];
  const sharedColumnWidthMm = getSharedRoundedNumber(selectedCellColumnIndexes.map((index) => pxToTableMm(columnWidths[index] ?? 0)));
  const sharedRowHeightMm = getSharedRoundedNumber(selectedCellRowIndexes.map((index) => pxToTableMm(rowHeights[index] ?? 0)));
  const selectedCellAlignRange = activeCellRange;
  const selectedCellAlign = selectedCellAlignRange
    ? getSharedPrimitive(table.cells
        .filter((cell) => tableCellIntersectsRangeById(table, cell, selectedCellAlignRange))
        .flatMap((cell) => {
          const fallback = cell.style?.align ?? table.defaultCellStyle.align ?? "center";
          const paragraphs = cell.content.filter((content) => content.type === "paragraph");
          return paragraphs.length > 0 ? paragraphs.map((content) => content.align ?? fallback) : [fallback];
        }))
    : null;
  const selectedCellFontSize = selectedCellAlignRange
    ? getSharedRoundedNumber(table.cells
        .filter((cell) => tableCellIntersectsRangeById(table, cell, selectedCellAlignRange))
        .map((cell) => cell.style?.fontSize ?? table.defaultCellStyle.fontSize ?? 15))
    : null;
  const defaultToolbarPosition = toolbarMode
    ? getDefaultTableToolbarPosition({
        mode: toolbarMode,
        cellRange: activeCellRange,
        line: activeSelectedLine,
        table,
        columnOffsets,
        rowOffsets,
        shapeWidth: shape.props.w,
        shapeHeight: shape.props.h,
      })
    : null;
  return (
    <div
      className={`overlay-table-shape ${editing ? "editing" : ""}`}
      style={{ width: shape.props.w, height: shape.props.h }}
      onContextMenu={(event) => {
        if (!editing) {
          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".overlay-table-context-menu, .overlay-table-floating-toolbar")) {
          return;
        }
        // セル上の右クリックは通常はセル編集に譲るが、表全体を選択中は
        // 罫線まわりの操作を出したいので、その場合だけメニューを開く。
        const wholeTableSelected = Boolean(activeCellRange
          && activeCellRange.startRow === 0
          && activeCellRange.endRow === table.rows.length - 1
          && activeCellRange.startColumn === 0
          && activeCellRange.endColumn === table.columns.length - 1);
        if (target?.closest("td") && !wholeTableSelected) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
          x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 220)),
          y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 220)),
          range: {
            startRow: 0,
            endRow: Math.max(0, table.rows.length - 1),
            startColumn: 0,
            endColumn: Math.max(0, table.columns.length - 1),
          },
        });
      }}
    >
      {editing && (
        <>
          {defaultToolbarPosition && (
            <FloatingEditorToolbar
              className={`overlay-table-floating-toolbar ${toolbarMode}`}
              anchorRef={tableElementRef}
              position={defaultToolbarPosition}
            >
              <button
                type="button"
                className="overlay-table-toolbar-grip"
                aria-label={tShape("table.moveMenu")}
                title={tShape("table.moveMenu")}
              >
                <GripVertical size={14} />
              </button>
              {toolbarMode === "line" ? (
                <>
                  <OverlayLineDashMenuButton
                    buttonRef={lineStyleButtonRef}
                    options={buildTableLineStyleOptions(tChrome)}
                    currentValue={sharedLineStyle}
                    open={lineStyleMenuOpen}
                    onToggle={() => {
                      setLineWidthMenuOpen(false);
                      setLineStyleMenuOpen((current) => !current);
                    }}
                    onSelect={(value) => {
                      if (value === "none") {
                        updateSelectedLineStyle({ visible: false });
                        setLineStyleMenuOpen(false);
                        return;
                      }
                      updateSelectedLineStyle({
                        borderStyle: value,
                        visible: true,
                        // 二重線は3px以上ないと2本に見えないため最小幅を確保する。
                        ...(value === "double" && (sharedLineWidth ?? 0) < 3 ? { borderWidth: 3 } : {}),
                      });
                      setLineStyleMenuOpen(false);
                    }}
                  />
                  <OverlayLineWidthMenuButton
                    buttonRef={lineWidthButtonRef}
                    currentValue={sharedLineSize}
                    open={lineWidthMenuOpen}
                    onToggle={() => {
                      setLineStyleMenuOpen(false);
                      setLineWidthMenuOpen((current) => !current);
                    }}
                    onSelect={(value) => {
                      updateSelectedLineStyle({ borderWidth: TABLE_BORDER_WIDTH_BY_SIZE[value], visible: true });
                      setLineWidthMenuOpen(false);
                    }}
                  />
                </>
              ) : (
                <>
                  <label className="overlay-table-toolbar-number">
                    <MoveHorizontal size={14} aria-label={tShape("table.columnWidth")} />
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder={tShape("table.mixed")}
                      value={sharedColumnWidthMm === null ? "" : formatTableMm(sharedColumnWidthMm)}
                      onChange={(event) => {
                        const value = Number.parseFloat(event.target.value);
                        if (Number.isFinite(value)) {
                          updateSelectedColumnWidthMm(value);
                        }
                      }}
                    />
                    <span>mm</span>
                  </label>
                  <label className="overlay-table-toolbar-number">
                    <MoveVertical size={14} aria-label={tShape("table.rowHeight")} />
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder={tShape("table.mixed")}
                      value={sharedRowHeightMm === null ? "" : formatTableMm(sharedRowHeightMm)}
                      onChange={(event) => {
                        const value = Number.parseFloat(event.target.value);
                        if (Number.isFinite(value)) {
                          updateSelectedRowHeightMm(value);
                        }
                      }}
                    />
                    <span>mm</span>
                  </label>
                  <label className="overlay-table-toolbar-number">
                    <Type size={14} aria-label={tShape("table.fontSize")} />
                    <input
                      type="number"
                      min="1"
                      step="0.5"
                      aria-label={tShape("table.fontSizeAria")}
                      placeholder={tShape("table.mixed")}
                      value={selectedCellFontSize === null ? "" : selectedCellFontSize}
                      onChange={(event) => {
                        const value = Number.parseFloat(event.target.value);
                        if (Number.isFinite(value)) {
                          updateSelectedCellFontSize(value);
                        }
                      }}
                    />
                    <span>pt</span>
                  </label>
                  <OverlayTextAlignMenuButton
                    buttonRef={cellAlignButtonRef}
                    options={buildTableAlignOptions(tChrome)}
                    currentValue={selectedCellAlign}
                    open={cellAlignMenuOpen}
                    onToggle={() => setCellAlignMenuOpen((current) => !current)}
                    onSelect={(value) => {
                      updateSelectedCellAlign(value);
                      setCellAlignMenuOpen(false);
                    }}
                  />
                </>
              )}
            </FloatingEditorToolbar>
          )}
          <div className="overlay-table-column-controls" aria-hidden={false}>
            {columnOffsets.map((offset, index) => {
              const lineKey = getTableVerticalLineKey(table, index);
              if (!lineKey) {
                return null;
              }
              const lineDomKey = getTableLineDomKey(lineKey);
              const isInternal = index > 0 && index < table.columns.length;
              const edge = index === 0 ? "left" : index === table.columns.length ? "right" : null;
              const isSelected = activeSelectedLines.some((line) => tableLineKeysMatch(line, lineKey));
              const isAddControlVisible = activeAddBoundaryKeys.has(lineDomKey);

              return (
                <div
                  key={`column-boundary-${lineDomKey}`}
                  role="button"
                  tabIndex={0}
                  className={[
                    "overlay-table-boundary-hotspot",
                    "column",
                    "resizable",
                    isSelected ? "selected" : "",
                    isAddControlVisible ? "add-visible" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ left: offset }}
                  aria-label={getTableLineLabel(table, lineKey, tSettings)}
                  data-testid="overlay-table-column-boundary"
                  onPointerEnter={() => showAddControlForBoundary(lineDomKey)}
                  onPointerLeave={() => hideAddControlAfterDelay(lineDomKey)}
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return;
                    }
                    // 罫線（特に外枠）は表の選択・移動より優先して掴めるよう、
                    // ここでイベントの伝播を止めて第一選択で罫線を選べるようにする。
                    event.stopPropagation();
                    selectTableLine(lineKey, event.shiftKey);
                    if (event.shiftKey) {
                      event.preventDefault();
                      return;
                    }
                    if (isInternal) {
                      startColumnResize(event, index - 1);
                      return;
                    }
                    if (edge) {
                      startColumnEdgeResize(event, edge);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectTableLine(lineKey, event.shiftKey);
                    }
                  }}
                >
                  <button
                    type="button"
                    className="overlay-table-add-control column"
                    aria-label={tShape("table.addColumnAt", { index: index + 1 })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onChange(shape.id, insertTableColumn(table, index));
                    }}
                  >
                    <Plus size={11} strokeWidth={2.4} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="overlay-table-row-controls" aria-hidden={false}>
            {rowOffsets.map((offset, index) => {
              const lineKey = getTableHorizontalLineKey(table, index);
              if (!lineKey) {
                return null;
              }
              const lineDomKey = getTableLineDomKey(lineKey);
              const isInternal = index > 0 && index < table.rows.length;
              const edge = index === 0 ? "top" : index === table.rows.length ? "bottom" : null;
              const isSelected = activeSelectedLines.some((line) => tableLineKeysMatch(line, lineKey));
              const isAddControlVisible = activeAddBoundaryKeys.has(lineDomKey);

              return (
                <div
                  key={`row-boundary-${lineDomKey}`}
                  role="button"
                  tabIndex={0}
                  className={[
                    "overlay-table-boundary-hotspot",
                    "row",
                    "resizable",
                    isSelected ? "selected" : "",
                    isAddControlVisible ? "add-visible" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ top: offset }}
                  aria-label={getTableLineLabel(table, lineKey, tSettings)}
                  data-testid="overlay-table-row-boundary"
                  onPointerEnter={() => showAddControlForBoundary(lineDomKey)}
                  onPointerLeave={() => hideAddControlAfterDelay(lineDomKey)}
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return;
                    }
                    // 罫線（特に外枠）は表の選択・移動より優先して掴めるよう、
                    // ここでイベントの伝播を止めて第一選択で罫線を選べるようにする。
                    event.stopPropagation();
                    selectTableLine(lineKey, event.shiftKey);
                    if (event.shiftKey) {
                      event.preventDefault();
                      return;
                    }
                    if (isInternal) {
                      startRowResize(event, index - 1);
                      return;
                    }
                    if (edge) {
                      startRowEdgeResize(event, edge);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectTableLine(lineKey, event.shiftKey);
                    }
                  }}
                >
                  <button
                    type="button"
                    className="overlay-table-add-control row"
                    aria-label={tShape("table.addRowAt", { index: index + 1 })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onChange(shape.id, insertTableRow(table, index));
                    }}
                  >
                    <Plus size={11} strokeWidth={2.4} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {activeContextMenu && typeof document !== "undefined" && createPortal((
        <div
          className="overlay-table-context-menu"
          role="menu"
          style={{ left: activeContextMenu.x, top: activeContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => insertContextColumn("left")}
          >
            {tShape("table.addColumnLeft")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => insertContextColumn("right")}
          >
            {tShape("table.addColumnRight")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => insertContextRow("above")}
          >
            {tShape("table.addRowAbove")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => insertContextRow("below")}
          >
            {tShape("table.addRowBelow")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={!canDeleteContextRows}
            onPointerEnter={() => setDeletePreview("rows")}
            onPointerLeave={() => setDeletePreview(null)}
            onFocus={() => setDeletePreview("rows")}
            onBlur={() => setDeletePreview(null)}
            onClick={deleteContextRows}
          >
            {tShape("table.deleteRows")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={!canDeleteContextColumns}
            onPointerEnter={() => setDeletePreview("columns")}
            onPointerLeave={() => setDeletePreview(null)}
            onFocus={() => setDeletePreview("columns")}
            onBlur={() => setDeletePreview(null)}
            onClick={deleteContextColumns}
          >
            {tShape("table.deleteColumns")}
          </button>
          {onCreateChart && (
            <>
              <div className="overlay-table-context-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  onCreateChart(shape.id);
                }}
              >
                {tShape("table.createChart")}
              </button>
            </>
          )}
          <div className="overlay-table-context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => selectTableLinesFromContext("all")}
          >
            {tShape("table.selectAllLines")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => selectTableLinesFromContext("outer")}
          >
            {tShape("table.selectOuterLines")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => selectTableLinesFromContext("inner")}
          >
            {tShape("table.selectInnerLines")}
          </button>
        </div>
      ), document.body)}
      <table
        ref={tableElementRef}
        className="overlay-table-shape-table"
        style={{
          width: tableLayoutWidth,
          height: shape.props.h,
          tableLayout: "fixed",
          border: 0,
        }}
      >
        <colgroup>
          {table.columns.map((column, index) => (
            <col key={column.id} style={{ width: columnWidths[index] }} />
          ))}
        </colgroup>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={row.id} style={{ height: rowHeights[rowIndex] }}>
              {origins[rowIndex].map(({ cell, columnIndex, rowSpan, colSpan }) => {
                const column = table.columns[columnIndex];
                const isSelectedCell = activeCellRange
                  ? tableCellIntersectsRange(activeCellRange, rowIndex, columnIndex, rowSpan, colSpan)
                  : false;
                const isDeletePreviewed = activeContextMenu && activeDeletePreview
                  ? tableCellMatchesDeletePreview(activeContextMenu.range, activeDeletePreview, rowIndex, columnIndex, rowSpan, colSpan)
                  : false;

                const cellStyle = getTableCellStyle(table, cell, rowIndex, columnIndex, rowSpan, colSpan);
                const contentLayerStyle = getTableCellContentLayerStyle(table, cell);
                // `#DIV/0!` is what the cell shows, and it is the same in every language; this is
                // the sentence explaining it, which is not.
                const formulaErrorCode = getTableCellFormulaErrorCode(table, cell);
                const formulaErrorMessage = formulaErrorCode
                  ? tShape(TABLE_FORMULA_ERROR_LABEL_KEYS[formulaErrorCode])
                  : null;

                return (
                  <td
                    key={cell?.id ?? `${row.id}:${column.id}`}
                    className={[
                      isSelectedCell ? "selected-cell" : "",
                      isDeletePreviewed ? "delete-preview" : "",
                    ].filter(Boolean).join(" ")}
                    data-table-row-index={rowIndex}
                    data-table-column-index={columnIndex}
                    data-table-cell-id={cell?.id}
                    data-table-formula-error={formulaErrorCode ?? undefined}
                    title={formulaErrorMessage ?? undefined}
                    aria-description={formulaErrorMessage
                      ? `${tShape("table.formula.errorAria")}: ${formulaErrorMessage}`
                      : undefined}
                    rowSpan={rowSpan}
                    colSpan={colSpan}
                    style={cellStyle}
                    onPointerDownCapture={(event) => handleCellPointerDownCapture(event, rowIndex, columnIndex)}
                    onPointerDown={(event) => {
                      if (editing && event.button === 0) {
                        event.stopPropagation();
                      }
                    }}
                    onContextMenuCapture={(event) => handleCellContextMenu(event, rowIndex, columnIndex)}
                  >
                    <div className="overlay-table-cell-content-layer" style={contentLayerStyle}>
                      {cell ? cell.content.map((content) => (
                        <OverlayTableCellContentEditor
                          key={content.id}
                          shapeId={shape.id}
                          cell={cell}
                          cellId={cell.id}
                          content={content}
                          editing={editing && cell.id === (focusedCellId ?? firstCell?.id)}
                          showFormulaSource={editing && focusedCellId === cell.id}
                          table={table}
                          rowIndex={rowIndex}
                          columnIndex={columnIndex}
                          colSpan={colSpan}
                          onFocus={handleCellEditorFocus}
                          onChange={updateCellContent}
                          onNavigate={focusTableCell}
                          onRegisterEditor={registerTableCellEditor}
                        />
                      )) : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <OverlayTableRenderedLines
        table={table}
        columnOffsets={columnOffsets}
        rowOffsets={rowOffsets}
      />
    </div>
  );
}
