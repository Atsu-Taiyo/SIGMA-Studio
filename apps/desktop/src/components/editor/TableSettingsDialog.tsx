"use client";

import { getTableCellMatrix } from "@/features/document";

import type { LucideIcon } from "lucide-react";
import  {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import  {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { ColorPalette } from "@/components/editor/ColorPalette";
import  {
  applyTableTemplateStyle,
  createOpenSidesTableSpec,
  createPlainTableSpec,
  createVariationDoubleLineTableSpec,
  createVariationTableSpec,
  getTableCellBorderStyles,
  getTableCssBorderValue,
  getTableHorizontalLineKey,
  getTableLineOverride,
  getTableVerticalLineKey,
  insertTableColumn,
  insertTableRow,
  removeTableColumn,
  removeTableLineOverride,
  removeTableRow,
  resolveTableColumnWidths,
  resolveTableLineBorder,
  resolveTableRowHeights,
  upsertTableLineOverride,
  type SigmaTableGridLineKey,
  type SigmaTableResolvedBorderStyle,
} from "@/components/editor/overlay-canvas/shapes/table";
import { applyTableCellStyleToRange, getTableLineLabel } from "@/components/editor/overlay-canvas/shapes/table-editor-model";
import type  {
  SigmaTableBorderStyle,
  SigmaTableCell,
  SigmaTableCellContent,
  SigmaTableGridLineStyle,
  SigmaTableSpec,
} from "@/components/editor/overlay-canvas/types";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { Select } from "@/components/ui/Select";
import type { InlineNode, TextAlign } from "@/features/document";
import { getTableCellDisplayNodes } from "@/features/document";
import { isSafeCssDeclarationValue } from "@/features/document/css-safety";
import { MathPreview, OverlayTableTrendCell } from "@/features/rendering/adapters/react";
import { getCumulativeOffsets } from "@/features/rendering/core";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

type TableTemplateId = "plain" | "variation" | "variationDouble" | "openSides";

interface TableTemplateOption {
  id: TableTemplateId;
  table: () => SigmaTableSpec;
}

interface TableTemplatePreviewOption extends TableTemplateOption {
  previewTable: SigmaTableSpec;
}

interface TableLineControl {
  id: string;
  label: string;
  key: SigmaTableGridLineKey;
}

interface TablePreviewLineOffsets {
  columnOffsets: number[];
  rowOffsets: number[];
}

interface TableSettingsDialogProps {
  mode: "insert" | "edit";
  initialTable: SigmaTableSpec;
  initialSize: { w: number; h: number };
  onCancel: () => void;
  onApply: (table: SigmaTableSpec, size: { w: number; h: number }) => void;
}

// 表示ラベルは `settings.table.template.<id>` が持つ。ここは並びと生成器だけ。
const TEMPLATE_OPTIONS: TableTemplateOption[] = [
  { id: "plain", table: () => createPlainTableSpec(3, 3) },
  { id: "variation", table: createVariationTableSpec },
  { id: "variationDouble", table: createVariationDoubleLineTableSpec },
  { id: "openSides", table: () => createOpenSidesTableSpec(3, 4) },
];

const MIN_TABLE_ROWS = 1;
const MAX_TABLE_ROWS = 8;
const MIN_TABLE_COLUMNS = 1;
const MAX_TABLE_COLUMNS = 16;
const MIXED_SELECT_VALUE = "mixed";

type LineTypeOption = {
  id: "none" | "solid1" | "solid2" | "dashed" | "double";
  visible: boolean;
  borderStyle: SigmaTableBorderStyle;
  borderWidth: number;
};

const LINE_TYPE_OPTIONS: LineTypeOption[] = [
  { id: "none", visible: false, borderStyle: "solid", borderWidth: 0 },
  { id: "solid1", visible: true, borderStyle: "solid", borderWidth: 1 },
  { id: "solid2", visible: true, borderStyle: "solid", borderWidth: 2 },
  { id: "dashed", visible: true, borderStyle: "dashed", borderWidth: 1 },
  { id: "double", visible: true, borderStyle: "double", borderWidth: 3 },
];

function getLineTypeId(border: { visible: boolean; borderStyle: SigmaTableBorderStyle; borderWidth: number }): string {
  if (!border.visible || border.borderWidth <= 0) {
    return "none";
  }
  if (border.borderStyle === "double") {
    return "double";
  }
  if (border.borderStyle === "dashed" || border.borderStyle === "dotted") {
    return "dashed";
  }
  return border.borderWidth >= 2 ? "solid2" : "solid1";
}

// 表示ラベルは `settings.table.align.<value>` が持つ。
const CELL_ALIGN_OPTIONS: { value: TextAlign; Icon: LucideIcon }[] = [
  { value: "left", Icon: AlignLeft },
  { value: "center", Icon: AlignCenter },
  { value: "right", Icon: AlignRight },
];

export function TableSettingsDialog({
  mode,
  initialTable,
  initialSize,
  onCancel,
  onApply,
}: TableSettingsDialogProps) {
  const [table, setTable] = useState(initialTable);
  const [activeTemplate, setActiveTemplate] = useState<TableTemplateId | "custom">(() => inferTemplateId(initialTable));
  const t = useT("settings");
  const tCommon = useT("common");
  const [selectedLines, setSelectedLines] = useState<SigmaTableGridLineKey[]>([]);
  const [borderColorPickerOpen, setBorderColorPickerOpen] = useState(false);
  const borderColorButtonRef = useRef<HTMLButtonElement | null>(null);
  const [templatePreviews] = useState<TableTemplatePreviewOption[]>(() => (
    TEMPLATE_OPTIONS.map((template) => ({
      ...template,
      // The table factories create random SigmaDoc ids. Keep preview ids stable
      // while the dialog is open so local edits do not remount every card.
      previewTable: template.table(),
    }))
  ));
  const lineControls = useMemo(() => getTableLineControls(table, t), [table, t]);
  const selectedLineControls = useMemo(
    () => getSelectedLineControls(lineControls, selectedLines),
    [lineControls, selectedLines],
  );
  const selectedLineBorders = selectedLineControls.map((line) => resolveTableLineBorder(table, line.key));
  const selectedLineCount = selectedLineControls.length;
  const selectedLineHasOverride = selectedLineControls.some((line) => Boolean(getTableLineOverride(table, line.key)));
  const selectedLineTypeValue = getSharedSelectValue(
    selectedLineBorders.map((border) => getLineTypeId(border)),
  );
  const selectedBorderColor = selectedLineBorders[0]?.borderColor ?? table.grid.borderColor;
  const cellAlign: TextAlign = (table.defaultCellStyle.align ?? "center") as TextAlign;
  const title = mode === "insert" ? t("table.titleInsert") : t("table.titleEdit");
  const borderColorPickerVisible = selectedLineCount > 0 && borderColorPickerOpen;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const applyTemplate = (template: TableTemplateOption) => {
    const templateTable = template.table();
    const nextTable = mode === "edit"
      ? applyTableTemplateStyle(table, templateTable)
      : templateTable;
    setTable(nextTable);
    setActiveTemplate(template.id);
    setSelectedLines([]);
    setBorderColorPickerOpen(false);
  };

  const setRowCount = (rowCount: number) => {
    setTable((current) => resizeTableRows(current, rowCount));
    setActiveTemplate("custom");
    setBorderColorPickerOpen(false);
  };

  const setColumnCount = (columnCount: number) => {
    setTable((current) => resizeTableColumns(current, columnCount));
    setActiveTemplate("custom");
    setBorderColorPickerOpen(false);
  };

  const selectLine = (key: SigmaTableGridLineKey, additive: boolean) => {
    setBorderColorPickerOpen(false);
    setSelectedLines((current) => {
      const keyId = getTableLineDomKey(key);
      if (!additive) {
        return [key];
      }
      if (current.some((line) => getTableLineDomKey(line) === keyId)) {
        return current.filter((line) => getTableLineDomKey(line) !== keyId);
      }
      return [...current, key];
    });
  };

  const updateSelectedLineStyle = (style: SigmaTableGridLineStyle) => {
    if (selectedLineControls.length === 0) {
      return;
    }

    setTable((current) => selectedLineControls.reduce(
      (nextTable, line) => upsertTableLineOverride(nextTable, line.key, style),
      current,
    ));
    setActiveTemplate("custom");
  };

  const updateSelectedLineType = (option: LineTypeOption) => {
    updateSelectedLineStyle({
      visible: option.visible,
      borderStyle: option.borderStyle,
      borderWidth: option.borderWidth,
    });
  };

  const setCellAlign = (align: TextAlign) => {
    setTable((current) => ({
      ...applyTableCellStyleToRange(current, {
        startRow: 0,
        endRow: current.rows.length - 1,
        startColumn: 0,
        endColumn: current.columns.length - 1,
      }, { align }),
      defaultCellStyle: {
        ...current.defaultCellStyle,
        align,
      },
    }));
  };

  const clearSelectedLineStyle = () => {
    if (selectedLineControls.length === 0) {
      return;
    }

    setTable((current) => selectedLineControls.reduce(
      (nextTable, line) => removeTableLineOverride(nextTable, line.key),
      current,
    ));
    setActiveTemplate("custom");
  };

  const dialog = (
    <div
      className="table-settings-backdrop"
      data-modal-backdrop=""
      role="presentation"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        className="table-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="table-settings-header">
          <div className="table-settings-title">
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={tCommon("actions.close")} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        <div className="table-settings-body">
          <section className="table-settings-top">
            <div className="table-settings-track-fields">
              <NumberStepper
                label={t("table.rows")}
                hint={`(${MIN_TABLE_ROWS}〜${MAX_TABLE_ROWS})`}
                value={table.rows.length}
                min={MIN_TABLE_ROWS}
                max={MAX_TABLE_ROWS}
                onChange={setRowCount}
              />
              <NumberStepper
                label={t("table.columns")}
                hint={`(${MIN_TABLE_COLUMNS}〜${MAX_TABLE_COLUMNS})`}
                value={table.columns.length}
                min={MIN_TABLE_COLUMNS}
                max={MAX_TABLE_COLUMNS}
                onChange={setColumnCount}
              />
            </div>
            <div className="table-settings-pattern">
              <div className="table-settings-section-title">
                <h3>{t("table.pattern")}</h3>
              </div>
              <div className="table-template-grid">
                {templatePreviews.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={activeTemplate === template.id ? "active" : ""}
                    aria-pressed={activeTemplate === template.id}
                    aria-label={t(`table.template.${template.id}`)}
                    title={t(`table.template.${template.id}`)}
                    onClick={() => applyTemplate(template)}
                  >
                    <TableSettingsPreview table={template.previewTable} width={72} height={38} compact />
                    <span className="table-template-label">{t(`table.template.${template.id}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="table-settings-main">
            <div className="table-settings-preview-panel">
              <div className="table-settings-section-title">
                <h3>{t("table.preview")}</h3>
              </div>
              <TableSettingsPreview
                table={table}
                width={360}
                height={200}
                selectedLines={selectedLineControls.map((line) => line.key)}
                onSelectLine={selectLine}
              />
            </div>

            <div className="table-settings-border-panel">
              <div className="table-settings-section-title">
                <h3>{t("table.borders")}</h3>
              </div>
              <div className="table-border-controls">
                <div className="table-border-status">
                  <span>{getSelectedLineAxisBadge(selectedLineControls, t)}</span>
                  <strong>{getSelectedLineStatusLabel(selectedLineControls, t)}</strong>
                </div>
                <label className="table-border-line-type">
                  <span className="table-border-label">{t("table.lineTypeLabel")}</span>
                  <Select
                    aria-label={t("table.lineTypeAria")}
                    disabled={selectedLineCount === 0}
                    value={selectedLineTypeValue}
                    options={[
                      ...(selectedLineTypeValue === MIXED_SELECT_VALUE
                        ? [{ value: MIXED_SELECT_VALUE, label: tCommon("color.mixed"), disabled: true }]
                        : []),
                      ...LINE_TYPE_OPTIONS.map((option) => ({
                        value: option.id,
                        label: t(`table.lineType.${option.id}`),
                      })),
                    ]}
                    onChange={(id) => {
                      const option = LINE_TYPE_OPTIONS.find((entry) => entry.id === id);
                      if (option) {
                        updateSelectedLineType(option);
                      }
                    }}
                  />
                </label>
                <label className="table-border-color">
                  <span className="table-border-label">{t("table.colorLabel")}</span>
                  <button
                    ref={borderColorButtonRef}
                    type="button"
                    className="table-border-color-button"
                    aria-label={t("table.colorAria")}
                    aria-haspopup="dialog"
                    aria-expanded={borderColorPickerVisible}
                    disabled={selectedLineCount === 0}
                    onClick={() => setBorderColorPickerOpen((current) => !current)}
                  >
                    <span
                      className="table-border-color-swatch"
                      style={{ backgroundColor: toColorInputValue(selectedBorderColor) }}
                      aria-hidden="true"
                    />
                    <span>{toColorInputValue(selectedBorderColor)}</span>
                  </button>
                  <ToolbarPopover
                    open={borderColorPickerVisible}
                    anchorRef={borderColorButtonRef}
                    onClose={() => setBorderColorPickerOpen(false)}
                    className="color-popover"
                    ariaLabel={t("table.colorAria")}
                  >
                    <ColorPalette
                      value={toColorInputValue(selectedBorderColor)}
                      onChange={(color) => {
                        if (color === null) return;
                        updateSelectedLineStyle({
                          borderColor: color,
                          visible: true,
                        });
                        setBorderColorPickerOpen(false);
                      }}
                    />
                  </ToolbarPopover>
                </label>
                <button
                  type="button"
                  className="table-line-reset-button"
                  disabled={!selectedLineHasOverride}
                  onClick={clearSelectedLineStyle}
                >
                  {t("table.resetDefaults")}
                </button>
              </div>
            </div>
          </section>

          <section className="table-settings-section table-settings-cell-align">
            <div className="table-settings-section-title">
              <h3>{t("table.cellAlign")}</h3>
            </div>
            <div className="table-cell-align-options" role="group" aria-label={t("table.cellAlign")}>
              {CELL_ALIGN_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`table-cell-align-option ${cellAlign === option.value ? "active" : ""}`}
                  aria-label={t(`table.align.${option.value}`)}
                  aria-pressed={cellAlign === option.value}
                  title={t(`table.align.${option.value}`)}
                  onClick={() => setCellAlign(option.value)}
                >
                  <option.Icon size={16} />
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="table-settings-footer">
          <button type="button" className="button subtle" onClick={onCancel}>{tCommon("actions.cancel")}</button>
          <button type="button" className="button primary" onClick={() => onApply(table, initialSize)}>
            OK
          </button>
        </footer>
      </div>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(dialog, document.body);
}

function NumberStepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const t = useT("settings");
  return (
    <label className="table-number-stepper">
      <div className="table-number-stepper-input">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(clampInteger(Number(event.target.value), min, max))}
        />
        <div className="table-number-stepper-buttons">
          <button
            type="button"
            aria-label={t("table.increase", { label })}
            disabled={value >= max}
            onClick={() => onChange(value + 1)}
          >
            <ChevronUp size={11} />
          </button>
          <button
            type="button"
            aria-label={t("table.decrease", { label })}
            disabled={value <= min}
            onClick={() => onChange(value - 1)}
          >
            <ChevronDown size={11} />
          </button>
        </div>
      </div>
      <span className="table-number-stepper-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

function TableSettingsPreview({
  table,
  width = 240,
  height = 122,
  compact = false,
  selectedLines = [],
  onSelectLine,
}: {
  table: SigmaTableSpec;
  width?: number;
  height?: number;
  compact?: boolean;
  selectedLines?: SigmaTableGridLineKey[];
  onSelectLine?: (line: SigmaTableGridLineKey, additive: boolean) => void;
}) {
  const t = useT("settings");
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const columnWidths = resolveTableColumnWidths(table, width);
  const rowHeights = resolveTableRowHeights(table, height);
  const calculatedColumnOffsets = getCumulativeOffsets(columnWidths);
  const calculatedRowOffsets = getCumulativeOffsets(rowHeights);
  const [renderedOffsets, setRenderedOffsets] = useState<TablePreviewLineOffsets | null>(null);
  const columnOffsets = renderedOffsets?.columnOffsets.length === table.columns.length + 1
    ? renderedOffsets.columnOffsets
    : calculatedColumnOffsets;
  const rowOffsets = renderedOffsets?.rowOffsets.length === table.rows.length + 1
    ? renderedOffsets.rowOffsets
    : calculatedRowOffsets;
  const { origins } = getTableCellMatrix(table);
  const interactive = !compact && onSelectLine;
  const selectedLineIds = new Set(selectedLines.map(getTableLineDomKey));

  useLayoutEffect(() => {
    const nextOffsets = measurePreviewLineOffsets(tableElementRef.current, table.columns.length, table.rows.length);
    setRenderedOffsets((current) => previewLineOffsetsEqual(current, nextOffsets) ? current : nextOffsets);
  }, [height, table, width]);

  return (
    <div className={`table-settings-preview ${compact ? "compact" : ""}`}>
      <div className="table-settings-preview-surface" style={{ width, height }}>
        <table ref={tableElementRef} style={{ width, height }}>
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
                  return (
                    <td
                      key={cell?.id ?? `${row.id}:${column.id}`}
                      rowSpan={rowSpan}
                      colSpan={colSpan}
                      style={getPreviewCellStyle(table, cell, rowIndex, columnIndex, rowSpan, colSpan, compact)}
                    >
                      {cell?.content.map((content) => (
                        <span key={content.id} className="table-settings-preview-cell-content">
                          {renderPreviewContent(table, cell, content, colSpan)}
                        </span>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-preview-rendered-lines" aria-hidden="true">
          {rowOffsets.map((offset, index) => {
            const key = getTableHorizontalLineKey(table, index);
            if (!key) {
              return null;
            }

            const border = resolveTableLineBorder(table, key);
            if (!border.visible || border.borderWidth <= 0) {
              return null;
            }

            return (
              <div
                key={`rendered-horizontal-${getTableLineDomKey(key)}`}
                className="table-preview-rendered-line horizontal"
                style={{
                  top: offset,
                  borderTop: getTableCssBorderValue(border),
                }}
              />
            );
          })}
        </div>
        {interactive && (
          <div className="table-preview-line-controls" aria-hidden={false}>
            {columnOffsets.map((offset, index) => {
              const key = getTableVerticalLineKey(table, index);
              if (!key) {
                return null;
              }
              const border = resolveTableLineBorder(table, key);
              const selected = selectedLineIds.has(getTableLineDomKey(key));
              return (
                <Fragment key={`vertical-${getTableLineDomKey(key)}`}>
                  <button
                    type="button"
                    className={`table-preview-line-target vertical ${selected ? "selected" : ""}`}
                    style={{ left: offset }}
                    aria-label={t("table.selectLine", { label: getTableLineLabel(table, key, t) })}
                    title={getTableLineLabel(table, key, t)}
                    onClick={(event) => onSelectLine(key, event.shiftKey)}
                  />
                  <div
                    className={`table-preview-line-highlight vertical ${selected ? "selected" : ""}`}
                    style={getTablePreviewLineHighlightStyle("vertical", offset, border)}
                    aria-hidden="true"
                  />
                </Fragment>
              );
            })}
            {rowOffsets.map((offset, index) => {
              const key = getTableHorizontalLineKey(table, index);
              if (!key) {
                return null;
              }
              const border = resolveTableLineBorder(table, key);
              const selected = selectedLineIds.has(getTableLineDomKey(key));
              return (
                <Fragment key={`horizontal-${getTableLineDomKey(key)}`}>
                  <button
                    type="button"
                    className={`table-preview-line-target horizontal ${selected ? "selected" : ""}`}
                    style={{ top: offset }}
                    aria-label={t("table.selectLine", { label: getTableLineLabel(table, key, t) })}
                    title={getTableLineLabel(table, key, t)}
                    onClick={(event) => onSelectLine(key, event.shiftKey)}
                  />
                  <div
                    className={`table-preview-line-highlight horizontal ${selected ? "selected" : ""}`}
                    style={getTablePreviewLineHighlightStyle("horizontal", offset, border)}
                    aria-hidden="true"
                  />
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function getTableLineControls(table: SigmaTableSpec, t: Translate<"settings">): TableLineControl[] {
  const controls: TableLineControl[] = [];
  for (let index = 0; index <= table.columns.length; index += 1) {
    const key = getTableVerticalLineKey(table, index);
    if (key) {
      controls.push({
        id: getTableLineDomKey(key),
        label: getTableLineLabel(table, key, t),
        key,
      });
    }
  }
  for (let index = 0; index <= table.rows.length; index += 1) {
    const key = getTableHorizontalLineKey(table, index);
    if (key) {
      controls.push({
        id: getTableLineDomKey(key),
        label: getTableLineLabel(table, key, t),
        key,
      });
    }
  }
  return controls;
}

function getSelectedLineControls(
  lineControls: TableLineControl[],
  selectedLines: SigmaTableGridLineKey[],
): TableLineControl[] {
  const selectedIds = new Set(selectedLines.map(getTableLineDomKey));
  return lineControls.filter((line) => selectedIds.has(line.id));
}

function getSharedSelectValue(values: string[]): string {
  if (values.length === 0) {
    return MIXED_SELECT_VALUE;
  }

  const [firstValue] = values;
  return values.every((value) => value === firstValue) ? firstValue : MIXED_SELECT_VALUE;
}

function getSelectedLineAxisBadge(selectedLineControls: TableLineControl[], t: Translate<"settings">): string {
  if (selectedLineControls.length === 0) {
    return t("table.line.badgeNone");
  }

  if (selectedLineControls.length > 1) {
    return t("table.line.badgeMultiple");
  }

  return getTableLineAxisLabel(selectedLineControls[0].key, t);
}

function getSelectedLineStatusLabel(selectedLineControls: TableLineControl[], t: Translate<"settings">): string {
  if (selectedLineControls.length === 0) {
    return t("table.line.statusNone");
  }

  if (selectedLineControls.length > 1) {
    return t("table.line.statusMultiple", { lines: selectedLineControls.length });
  }

  return getTableLineStatusLabel(selectedLineControls[0].key, t);
}

function resizeTableColumns(table: SigmaTableSpec, columnCount: number): SigmaTableSpec {
  const targetCount = clampInteger(columnCount, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS);
  let nextTable = table;
  while (nextTable.columns.length < targetCount) {
    nextTable = insertTableColumn(nextTable, nextTable.columns.length);
  }
  while (nextTable.columns.length > targetCount) {
    const lastColumn = nextTable.columns[nextTable.columns.length - 1];
    nextTable = removeTableColumn(nextTable, lastColumn.id);
  }
  return nextTable;
}

function resizeTableRows(table: SigmaTableSpec, rowCount: number): SigmaTableSpec {
  const targetCount = clampInteger(rowCount, MIN_TABLE_ROWS, MAX_TABLE_ROWS);
  let nextTable = table;
  while (nextTable.rows.length < targetCount) {
    nextTable = insertTableRow(nextTable, nextTable.rows.length);
  }
  while (nextTable.rows.length > targetCount) {
    const lastRow = nextTable.rows[nextTable.rows.length - 1];
    nextTable = removeTableRow(nextTable, lastRow.id);
  }
  return nextTable;
}

function inferTemplateId(table: SigmaTableSpec): TableTemplateId | "custom" {
  if (table.kind === "variation") {
    const labelSeparator = getTableVerticalLineKey(table, 1);
    if (labelSeparator && resolveTableLineBorder(table, labelSeparator).borderStyle === "double") {
      return "variationDouble";
    }
    return "variation";
  }

  const leftEdge = getTableVerticalLineKey(table, 0);
  const rightEdge = getTableVerticalLineKey(table, table.columns.length);
  if (
    leftEdge &&
    rightEdge &&
    !resolveTableLineBorder(table, leftEdge).visible &&
    !resolveTableLineBorder(table, rightEdge).visible
  ) {
    return "openSides";
  }

  return "plain";
}

function getPreviewCellStyle(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
  rowIndex: number,
  columnIndex: number,
  rowSpan: number,
  colSpan: number,
  compact: boolean,
): CSSProperties {
  const style = {
    ...table.defaultCellStyle,
    ...(cell?.style ?? {}),
  };
  const borders = getTableCellBorderStyles(table, rowIndex, columnIndex, rowSpan, colSpan);

  return {
    textAlign: style.align ?? "center",
    verticalAlign: style.verticalAlign ?? "middle",
    padding: compact ? "2px 3px" : `${style.paddingY ?? 5}px ${style.paddingX ?? 8}px`,
    color: style.color,
    background: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: compact ? 10 : style.fontSize ? `${style.fontSize}pt` : undefined,
    fontWeight: style.fontWeight,
    ...borders,
  };
}

type TablePreviewLineHighlightStyle = CSSProperties & {
  "--table-preview-line-color"?: string;
  "--table-preview-line-width"?: string;
  "--table-preview-line-style"?: string;
  "--table-preview-line-opacity"?: string;
};

function getTablePreviewLineHighlightStyle(
  axis: "vertical" | "horizontal",
  offset: number,
  border: SigmaTableResolvedBorderStyle,
): TablePreviewLineHighlightStyle {
  const lineWidth = border.visible && border.borderWidth > 0
    ? Math.max(1, border.borderWidth)
    : 1;
  const style: TablePreviewLineHighlightStyle = axis === "vertical"
    ? { left: offset }
    : { top: offset };

  style["--table-preview-line-color"] = border.borderColor;
  style["--table-preview-line-width"] = `${lineWidth}px`;
  style["--table-preview-line-style"] = border.borderStyle;
  style["--table-preview-line-opacity"] = border.visible && border.borderWidth > 0 ? "1" : "0";

  return style;
}

function getTableLineDomKey(key: SigmaTableGridLineKey): string {
  if ("edge" in key) {
    return `${key.axis}:edge:${key.edge}`;
  }

  return key.axis === "vertical"
    ? `${key.axis}:before:${key.beforeColumnId}`
    : `${key.axis}:before:${key.beforeRowId}`;
}

function getTableLineAxisLabel(key: SigmaTableGridLineKey, t: Translate<"settings">): string {
  return key.axis === "vertical" ? t("table.line.axisVertical") : t("table.line.axisHorizontal");
}

function getTableLineStatusLabel(key: SigmaTableGridLineKey, t: Translate<"settings">): string {
  if ("edge" in key) {
    if (key.axis === "vertical") {
      return key.edge === "left" ? t("table.line.edgeLeft") : t("table.line.edgeRight");
    }

    return key.edge === "top" ? t("table.line.edgeTop") : t("table.line.edgeBottom");
  }

  return key.axis === "vertical" ? t("table.line.vertical") : t("table.line.horizontal");
}

/**
 * Where the dialog's own preview actually drew its rows and columns.
 *
 * The table shape's editing surface no longer measures anything — its offsets come straight from
 * `resolveTableRowHeights`, which now fills the shape's box exactly, so the browser has no leftover
 * space to redistribute (`shape-renderer-architecture.test.ts` pins that). This preview is not the
 * same case: its cells put their content in the normal flow
 * (`.table-settings-preview-cell-content` is an `inline-flex` span inside the `<td>`, not the
 * `position: absolute` content layer the shape uses), so a row here really does grow past its
 * declared height when the text in it is taller. The clickable line targets have to sit on the rows
 * the author is looking at, and this is a fixed-size dialog preview that nothing compares against
 * the PDF, so the measurement stays.
 */
function measurePreviewLineOffsets(
  tableElement: HTMLTableElement | null,
  columnCount: number,
  rowCount: number,
): TablePreviewLineOffsets | null {
  if (!tableElement) {
    return null;
  }

  const tableRect = tableElement.getBoundingClientRect();
  if (tableRect.width <= 0 || tableRect.height <= 0) {
    return null;
  }

  const rows = Array.from(tableElement.rows);
  const firstRow = rows[0];
  if (rows.length !== rowCount || !firstRow) {
    return null;
  }

  const firstRowCells = Array.from(firstRow.cells);
  const firstCell = firstRowCells[0];
  if (firstRowCells.length !== columnCount || !firstCell) {
    return null;
  }

  return {
    columnOffsets: [
      firstCell.getBoundingClientRect().left - tableRect.left,
      ...firstRowCells.map((cell) => cell.getBoundingClientRect().right - tableRect.left),
    ].map(roundOffset),
    rowOffsets: [
      firstRow.getBoundingClientRect().top - tableRect.top,
      ...rows.map((row) => row.getBoundingClientRect().bottom - tableRect.top),
    ].map(roundOffset),
  };
}

function previewLineOffsetsEqual(
  current: TablePreviewLineOffsets | null,
  next: TablePreviewLineOffsets | null,
): boolean {
  if (current === next) {
    return true;
  }

  if (!current || !next) {
    return false;
  }

  return offsetsEqual(current.columnOffsets, next.columnOffsets) && offsetsEqual(current.rowOffsets, next.rowOffsets);
}

function offsetsEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((offset, index) => Math.abs(offset - right[index]) < 0.25);
}

function roundOffset(offset: number): number {
  return Math.round(offset * 1000) / 1000;
}

function renderPreviewContent(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
  content: SigmaTableCellContent,
  colSpan: number,
): ReactNode {
  if (content.type === "trend") {
    // The same component the table itself draws, so the preview cannot show an arrow the document
    // does not have. It used to be KaTeX here — and `\to` for `flat`, where every other surface used
    // `\rightarrow`, so this preview was the odd one out among four drawings of the same cell.
    return <OverlayTableTrendCell colSpan={colSpan} content={content} />;
  }

  // The live table is what the dialog previews, so a formula cell has to show the same value here
  // as it does on the canvas behind the dialog.
  return renderInlineNodes(getTableCellDisplayNodes(table, cell, content));
}

function renderInlineNodes(children: readonly InlineNode[]): ReactNode {
  return children.map((child, index) => {
    if (child.type === "mathInline") {
      return <MathPreview key={child.id} tex={child.tex} />;
    }

    // The colour is carried because the projection puts the error colour there, and this preview
    // exists to agree with the canvas behind the dialog. It goes through the same safety funnel as
    // every other document-supplied colour.
    const color = child.color && isSafeCssDeclarationValue(child.color) ? child.color : undefined;
    return <span key={`${child.text}-${index}`} style={color ? { color } : undefined}>{child.text}</span>;
  });
}

function toColorInputValue(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#111827";
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
