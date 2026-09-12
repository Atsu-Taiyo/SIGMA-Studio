import {
  getTableCellMatrix,
  resolveDocumentFontFamily,
  type SigmaTableCell,
  type SigmaTableGridLineOverride,
  type SigmaTableGridStyle,
  type SigmaTableSpec,
  type SigmaTableTrackSize,
} from "@/features/document";

export type SigmaTableGridLineKey =
  | { axis: "vertical"; edge: "left" | "right" }
  | { axis: "vertical"; beforeColumnId: string }
  | { axis: "horizontal"; edge: "top" | "bottom" }
  | { axis: "horizontal"; beforeRowId: string };

export interface SigmaTableResolvedBorderStyle {
  visible: boolean;
  borderColor: string;
  borderWidth: number;
  borderStyle: NonNullable<SigmaTableGridStyle["borderStyle"]>;
}

export interface SigmaTableCellBorderStyles {
  borderTop: string;
  borderRight: string;
  borderBottom: string;
  borderLeft: string;
}

export function resolveTableColumnWidths(
  table: SigmaTableSpec,
  totalWidth: number,
): number[] {
  return resolveTrackSizes(table.columns.map((column) => column.width), totalWidth);
}

export function resolveTableRowHeights(
  table: SigmaTableSpec,
  totalHeight: number,
): number[] {
  return resolveTrackSizes(table.rows.map((row) => row.height), totalHeight);
}

export function getTableVerticalLineKey(
  table: SigmaTableSpec,
  boundaryIndex: number,
): SigmaTableGridLineKey | null {
  if (boundaryIndex < 0 || boundaryIndex > table.columns.length) {
    return null;
  }
  if (boundaryIndex === 0) {
    return { axis: "vertical", edge: "left" };
  }
  if (boundaryIndex === table.columns.length) {
    return { axis: "vertical", edge: "right" };
  }
  return { axis: "vertical", beforeColumnId: table.columns[boundaryIndex].id };
}

export function getTableHorizontalLineKey(
  table: SigmaTableSpec,
  boundaryIndex: number,
): SigmaTableGridLineKey | null {
  if (boundaryIndex < 0 || boundaryIndex > table.rows.length) {
    return null;
  }
  if (boundaryIndex === 0) {
    return { axis: "horizontal", edge: "top" };
  }
  if (boundaryIndex === table.rows.length) {
    return { axis: "horizontal", edge: "bottom" };
  }
  return { axis: "horizontal", beforeRowId: table.rows[boundaryIndex].id };
}

export function isTableLineKeyValid(
  table: SigmaTableSpec,
  key: SigmaTableGridLineKey,
): boolean {
  if (key.axis === "vertical") {
    if ("edge" in key) {
      return key.edge === "left" || key.edge === "right";
    }
    return table.columns.findIndex((column) => column.id === key.beforeColumnId) > 0;
  }
  if ("edge" in key) {
    return key.edge === "top" || key.edge === "bottom";
  }
  return table.rows.findIndex((row) => row.id === key.beforeRowId) > 0;
}

export function getTableLineOverride(
  table: SigmaTableSpec,
  key: SigmaTableGridLineKey,
): SigmaTableGridLineOverride | undefined {
  const overrides = table.grid.lineOverrides ?? [];
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const override = overrides[index];
    if (tableLineKeysEqual(override, key)) {
      return override;
    }
  }
  return undefined;
}

export function resolveTableLineBorder(
  table: SigmaTableSpec,
  key: SigmaTableGridLineKey,
): SigmaTableResolvedBorderStyle {
  const isOuter = "edge" in key;
  const defaultVisible = isOuter
    ? table.grid.showOuterBorder !== false
    : table.grid.showInnerBorders !== false;
  const override = getTableLineOverride(table, key)?.style;
  const borderWidth = override?.borderWidth ?? table.grid.borderWidth;
  return {
    visible: override?.visible ?? defaultVisible,
    borderColor: override?.borderColor ?? table.grid.borderColor,
    borderWidth: Number.isFinite(borderWidth) ? Math.max(0, borderWidth) : 0,
    borderStyle: override?.borderStyle ?? table.grid.borderStyle ?? "solid",
  };
}

export function getTableCssBorderValue(
  border: SigmaTableResolvedBorderStyle,
): string {
  if (!border.visible || border.borderWidth <= 0) {
    return "0";
  }
  return `${border.borderWidth}px ${border.borderStyle} ${border.borderColor}`;
}

export function getTableCellBorderStyles(
  table: SigmaTableSpec,
  rowIndex: number,
  columnIndex: number,
  rowSpan = 1,
  colSpan = 1,
): SigmaTableCellBorderStyles {
  return {
    borderTop: getTableBoundaryCssBorder(table, "horizontal", rowIndex),
    borderRight: getTableBoundaryCssBorder(table, "vertical", columnIndex + colSpan),
    borderBottom: getTableBoundaryCssBorder(table, "horizontal", rowIndex + rowSpan),
    borderLeft: getTableBoundaryCssBorder(table, "vertical", columnIndex),
  };
}

export function tableLineKeysEqual(
  left: SigmaTableGridLineKey,
  right: SigmaTableGridLineKey,
): boolean {
  if (left.axis !== right.axis) {
    return false;
  }
  if ("edge" in left || "edge" in right) {
    return "edge" in left && "edge" in right && left.edge === right.edge;
  }
  if (left.axis === "vertical" && right.axis === "vertical") {
    return left.beforeColumnId === right.beforeColumnId;
  }
  if (left.axis === "horizontal" && right.axis === "horizontal") {
    return left.beforeRowId === right.beforeRowId;
  }
  return false;
}

function getTableBoundaryCssBorder(
  table: SigmaTableSpec,
  axis: "vertical" | "horizontal",
  boundaryIndex: number,
): string {
  const key = axis === "vertical"
    ? getTableVerticalLineKey(table, boundaryIndex)
    : getTableHorizontalLineKey(table, boundaryIndex);
  if (!key) {
    return "0";
  }
  const border = resolveTableLineBorder(table, key);
  if (border.visible && border.borderWidth > 0 && border.borderStyle === "double") {
    return "0";
  }
  return getTableCssBorderValue(border);
}

/** Below a hundredth of a device pixel — nothing a layout engine can act on. */
const TRACK_SIZE_EPSILON = 1e-6;

/**
 * Track sizes that always add up to `totalSize`.
 *
 * The total is the load-bearing part, not an incidental one. Every surface renders the table as
 * `<table style="height: h"><tr style="height: rowHeight">`, and a browser treats those heights as
 * minimums: when the declared rows add up to less than `h` it stretches them (proportionally, as
 * measured in Chrome) to fill the box. The overlay that paints `double` boundaries is positioned
 * from these numbers, so a short total put the drawn line and the cell edge it stands in for in
 * different places — visibly so in the PDF and the SVG export, which have no DOM to measure and
 * therefore drew the boundaries at the unstretched offsets. The editor papered over its own copy of
 * the problem by re-measuring the rendered rows and drawing from that, a measure/render loop.
 *
 * Returning a total that already equals the box leaves the browser nothing to distribute, which is
 * what makes these numbers a fixed point: they are what gets drawn, on every surface, without
 * anybody measuring anything.
 *
 * `min` and `max` are honoured while there is room to honour them. The total wins when they
 * conflict with it, because a browser never sees them and would distribute the difference itself.
 */
function resolveTrackSizes(
  tracks: SigmaTableTrackSize[],
  totalSize: number,
): number[] {
  if (tracks.length === 0) {
    return [];
  }

  const baseSizes = tracks.map(getBaseTrackSize);
  const baseTotal = baseSizes.reduce((sum, size) => sum + size, 0);
  // A shape whose `props.h` is NaN or Infinity has nothing to fill, and arithmetic on it would put
  // `top: NaNpx` into the SVG export. Fall back to what the tracks asked for.
  const boundedTotalSize = Number.isFinite(totalSize)
    ? Math.max(1, totalSize)
    : Math.max(1, baseTotal);
  if (baseTotal > boundedTotalSize) {
    const scale = boundedTotalSize / baseTotal;
    return baseSizes.map((size) => size * scale);
  }

  const remaining = boundedTotalSize - baseTotal;
  if (remaining <= TRACK_SIZE_EPSILON) {
    return baseSizes;
  }
  if (baseTotal <= 0) {
    // Every track asked for nothing (`min: 0`), so there is no ratio to preserve. `max` still is:
    // settling redistributes whatever an equal split cannot give a capped track.
    const equalShare = boundedTotalSize / tracks.length;
    return settleTrackSizesToTotal(
      tracks.map((track) => Math.min(equalShare, getTrackMaxSize(track))),
      tracks,
      boundedTotalSize,
    );
  }

  const frTotal = tracks.reduce(
    (sum, track) => sum + (track.mode === "fr" ? Math.max(0, track.value) : 0),
    0,
  );
  const grown = frTotal > 0
    ? tracks.map((track, index) => {
        if (track.mode !== "fr") {
          return baseSizes[index];
        }
        const expanded = baseSizes[index]
          + remaining * (Math.max(0, track.value) / frTotal);
        return clampTrackSize(expanded, track.min, track.max);
      })
    // Nothing declared itself flexible, so grow every track by the same ratio. That is what the
    // browser does with the leftover space, so agreeing with it here is what keeps the drawn cell
    // edges where they already were.
    // Multiplied before dividing: `size * (total / base)` loses the last bit and lands a track on
    // 229.99999999999997 instead of 230, which is a whole device pixel once offsets accumulate.
    : baseSizes.map((size, index) => Math.min(
        (size * boundedTotalSize) / baseTotal,
        Math.max(size, getTrackMaxSize(tracks[index])),
      ));

  return settleTrackSizesToTotal(grown, tracks, boundedTotalSize);
}

/**
 * Hands the shortfall a `max` clamp left behind to the tracks that can still take it, until the
 * sizes add up to `targetTotal`.
 *
 * Growing is the only direction it has to handle: a base size already satisfies its own `min`, so
 * clamping an expanded track can only pull it back down.
 */
function settleTrackSizesToTotal(
  sizes: number[],
  tracks: SigmaTableTrackSize[],
  targetTotal: number,
): number[] {
  const settled = [...sizes];
  // Each pass either closes the gap or saturates at least one more track at its `max`.
  for (let pass = 0; pass <= settled.length; pass += 1) {
    const shortfall = targetTotal - settled.reduce((sum, size) => sum + size, 0);
    if (shortfall <= TRACK_SIZE_EPSILON) {
      break;
    }
    const openIndexes = settled
      .map((_, index) => index)
      .filter((index) => settled[index] < getTrackMaxSize(tracks[index]) - TRACK_SIZE_EPSILON);
    if (openIndexes.length === 0) {
      break;
    }
    // Weighted by current size so the ratio between the open tracks survives, with a floor of 1 so
    // a zero-width track is not excluded from a share it could hold.
    const openWeight = openIndexes.reduce((sum, index) => sum + Math.max(1, settled[index]), 0);
    for (const index of openIndexes) {
      const share = shortfall * (Math.max(1, settled[index]) / openWeight);
      settled[index] = Math.min(
        settled[index] + share,
        Math.max(settled[index], getTrackMaxSize(tracks[index])),
      );
    }
  }

  const settledTotal = settled.reduce((sum, size) => sum + size, 0);
  if (settledTotal > 0 && Math.abs(targetTotal - settledTotal) > TRACK_SIZE_EPSILON) {
    // Every track is pinned at its `max` and the box is still not full. Scale past `max` rather than
    // hand the difference to the browser, which would distribute it where nothing can read it back.
    return settled.map((size) => (size * targetTotal) / settledTotal);
  }
  return settled;
}

function getTrackMaxSize(track: SigmaTableTrackSize): number {
  if (track.mode === "fixed") {
    return Number.POSITIVE_INFINITY;
  }
  return track.max ?? Number.POSITIVE_INFINITY;
}

function getBaseTrackSize(track: SigmaTableTrackSize): number {
  if (track.mode === "fixed") {
    return Math.max(1, track.value);
  }
  return clampTrackSize(track.min ?? 1, track.min, track.max);
}

function clampTrackSize(
  value: number,
  min: number | undefined,
  max: number | undefined,
): number {
  return Math.max(min ?? 1, Math.min(value, max ?? Number.POSITIVE_INFINITY));
}

/**
 * Framework-neutral CSS declarations: camelCase property names with unit-complete string values.
 *
 * React consumes this directly as a `CSSProperties`, and so does the static view the SVG export
 * renders through — which is the point. The table used to be drawn by two independent
 * implementations (a React editor and an HTML string serializer in `overlay-svg.ts`) that had to
 * be kept in step by hand. Values carry their unit rather than relying on React's implicit `px`
 * so that every consumer reads the same string.
 */
export type OverlayTableStyleModel = Record<string, string>;

export interface OverlayTableGridCell {
  cell: SigmaTableCell | undefined;
  colSpan: number;
  columnIndex: number;
  rowIndex: number;
  rowSpan: number;
}

export interface OverlayTableGridRow {
  cells: OverlayTableGridCell[];
  height: number;
  rowId: string;
}

export interface OverlayTableGridModel {
  columnOffsets: number[];
  columnWidths: number[];
  rowHeights: number[];
  rowOffsets: number[];
  rows: OverlayTableGridRow[];
}

export interface OverlayTableRenderedLineModel {
  axis: "horizontal" | "vertical";
  key: SigmaTableGridLineKey;
  domKey: string;
  style: OverlayTableStyleModel;
}

export interface OverlayTableLineConnectorModel {
  axis: "horizontal" | "vertical";
  id: string;
  style: OverlayTableStyleModel;
}

/**
 * Span expansion for a table: which cell owns each grid position and which positions it covers.
 *
 * The expansion itself lives in `getTableCellMatrix` (`features/document/model/table-grid.ts`), so
 * this layout model and the chart derivation agree on which cell owns a merged position. The static
 * view walks this. Two editor surfaces — `table-shape-editor.tsx` and the preview inside
 * `TableSettingsDialog.tsx` — still hand-roll the same `coveredCells` pass inside their render;
 * folding those onto this model is follow-up work, deliberately out of this change's scope. The one
 * copy that did NOT expand spans at all (`AiEditInlinePreviewCard`'s table preview, whose merged
 * cells shifted every following column) is gone: the card never renders an overlay insert, so it
 * has no table renderer left to keep in step.
 */
export function getTableGridModel(
  table: SigmaTableSpec,
  width: number,
  height: number,
): OverlayTableGridModel {
  const columnWidths = resolveTableColumnWidths(table, width);
  const rowHeights = resolveTableRowHeights(table, height);
  const matrix = getTableCellMatrix(table);

  const rows = table.rows.map((row, rowIndex) => {
    const cells: OverlayTableGridCell[] = (matrix.origins[rowIndex] ?? []).map((placement) => ({
      cell: placement.cell,
      colSpan: placement.colSpan,
      columnIndex: placement.columnIndex,
      rowIndex: placement.rowIndex,
      rowSpan: placement.rowSpan,
    }));
    return { cells, height: rowHeights[rowIndex], rowId: row.id };
  });

  return {
    columnOffsets: getCumulativeOffsets(columnWidths),
    columnWidths,
    rowHeights,
    rowOffsets: getCumulativeOffsets(rowHeights),
    rows,
  };
}

export function getCumulativeOffsets(sizes: number[]): number[] {
  const offsets = [0];
  for (const size of sizes) {
    offsets.push(offsets[offsets.length - 1] + size);
  }
  return offsets;
}

export interface OverlayTableTrendGlyphModel {
  width: number;
  height: number;
  line: { x1: number; y1: number; x2: number; y2: number };
  /** `points` for the arrow head polygon. */
  arrowPoints: string;
  color: string;
  strokeWidth: number;
}

/**
 * The arrow a `trend` cell draws.
 *
 * One model for every surface: the static view, the cell editor, and the table settings preview all
 * render this, so the arrow the author edits is the arrow the PDF and the embedded viewer show. The
 * editing surface used to draw a KaTeX `\nearrow` instead, which neither stretched across a merged
 * cell nor matched the exported glyph.
 *
 * Plain SVG geometry only — no DOM tokens, so `features/document/architecture.test.ts` keeps this
 * layer free of the browser.
 */
export function getTableTrendGlyphModel(
  direction: "down" | "flat" | "up",
  colSpan: number,
): OverlayTableTrendGlyphModel {
  const width = Math.max(42, colSpan > 1 ? 38 * colSpan : 44);
  const height = 24;
  const y1 = direction === "up" ? 18 : direction === "down" ? 6 : 12;
  const y2 = direction === "up" ? 6 : direction === "down" ? 18 : 12;
  const arrowPoints = direction === "up"
    ? `${width - 6},${y2} ${width - 12},${y2 - 1.5} ${width - 9},${y2 + 4}`
    : direction === "down"
      ? `${width - 6},${y2} ${width - 12},${y2 + 1.5} ${width - 9},${y2 - 4}`
      : `${width - 6},${y2} ${width - 12},${y2 - 3} ${width - 12},${y2 + 3}`;

  return {
    width,
    height,
    line: { x1: 6, y1, x2: width - 7, y2 },
    arrowPoints,
    color: "#111827",
    strokeWidth: 1,
  };
}

export function getTableLineDomKey(key: SigmaTableGridLineKey): string {
  if ("edge" in key) {
    return `${key.axis}:edge:${key.edge}`;
  }

  return key.axis === "vertical"
    ? `${key.axis}:before:${key.beforeColumnId}`
    : `${key.axis}:before:${key.beforeRowId}`;
}

/**
 * The declarations `.overlay-table-shape td` and `.overlay-table-cell-content-layer` supply in the
 * app, for output that ships without the stylesheet (the SVG export).
 *
 * They are deliberately NOT part of the editor's inline style: an inline declaration beats the
 * stylesheet, so duplicating CSS there would freeze whatever a state rule wants to change.
 * `table-static-style.test.ts` checks these against `globals.css`.
 */
export const OVERLAY_TABLE_CELL_STATIC_STYLE: OverlayTableStyleModel = {
  boxSizing: "border-box",
  position: "relative",
  minWidth: "0",
  overflow: "hidden",
};

/**
 * The inherited text declarations `.overlay-table-shape` supplies.
 *
 * The static view has no such wrapper — it is one inline-styled tree so the exported SVG stands on
 * its own — so without these a cell fell back to `line-height: normal` while the editing surface
 * used 1.35: a cell's text moved by a fraction of a line the moment the table became interactive,
 * and the same gap sat between the editor and the PDF. Per-cell values from the table spec are
 * applied after these on the `<td>`, so a spec that sets them still wins.
 * `table-static-style.test.tsx` compares them to the CSS.
 */
export const OVERLAY_TABLE_TEXT_STATIC_STYLE: OverlayTableStyleModel = {
  color: "#111827",
  fontSize: "15pt",
  lineHeight: "1.35",
};

export const OVERLAY_TABLE_CELL_CONTENT_LAYER_STATIC_STYLE: OverlayTableStyleModel = {
  position: "absolute",
  inset: "0",
  display: "flex",
  minWidth: "0",
  minHeight: "0",
  flexDirection: "column",
  overflow: "hidden",
};

export function getTableCellStyleModel(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
  rowIndex: number,
  columnIndex: number,
  rowSpan: number,
  colSpan: number,
): OverlayTableStyleModel {
  const style = { ...table.defaultCellStyle, ...(cell?.style ?? {}) };
  const fontFamily = resolveDocumentFontFamily(style.fontFamily);
  const borders = getTableCellBorderStyles(table, rowIndex, columnIndex, rowSpan, colSpan);

  return {
    textAlign: style.align ?? "center",
    verticalAlign: style.verticalAlign ?? "middle",
    padding: "0",
    ...(style.color ? { color: style.color } : {}),
    ...(style.backgroundColor ? { background: style.backgroundColor } : {}),
    ...(fontFamily ? { fontFamily } : {}),
    // SigmaDoc のフォントサイズは pt。px の数値へ落とさず、静的表示・Tiptap 編集表示・SVG 出力で
    // 同じ単位を継承させる。
    ...(style.fontSize ? { fontSize: `${style.fontSize}pt` } : {}),
    ...(style.fontWeight ? { fontWeight: String(style.fontWeight) } : {}),
    borderTop: borders.borderTop,
    borderRight: borders.borderRight,
    borderBottom: borders.borderBottom,
    borderLeft: borders.borderLeft,
  };
}

export function getTableCellContentLayerStyleModel(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
): OverlayTableStyleModel {
  const style = { ...table.defaultCellStyle, ...(cell?.style ?? {}) };

  return {
    justifyContent: getTableCellContentJustify(style.verticalAlign ?? "middle"),
    padding: `${style.paddingY ?? 5}px ${style.paddingX ?? 8}px`,
  };
}

export function getTableCellContentJustify(
  verticalAlign: SigmaTableSpec["defaultCellStyle"]["verticalAlign"],
): "center" | "flex-end" | "flex-start" {
  if (verticalAlign === "top") {
    return "flex-start";
  }
  if (verticalAlign === "bottom") {
    return "flex-end";
  }
  return "center";
}

/** Only a `double` border needs the overlay layer; every other style is drawn by the cell edges. */
export function shouldRenderTableLineOverlay(border: SigmaTableResolvedBorderStyle): boolean {
  return border.visible && border.borderWidth > 0 && border.borderStyle === "double";
}

export function getTableRenderedLineStyleModel(
  axis: "horizontal" | "vertical",
  offset: number,
  border: SigmaTableResolvedBorderStyle,
): OverlayTableStyleModel {
  const lineWidth = Math.max(0, border.borderWidth);
  const borderValue = `${lineWidth}px ${border.borderStyle} ${border.borderColor}`;
  return axis === "vertical"
    ? { left: `${offset - lineWidth / 2}px`, borderLeft: borderValue }
    : { top: `${offset - lineWidth / 2}px`, borderTop: borderValue };
}

/** The `double` boundary lines that need their own overlay element, in column-then-row order. */
export function getTableRenderedLineModels(
  table: SigmaTableSpec,
  columnOffsets: number[],
  rowOffsets: number[],
): OverlayTableRenderedLineModel[] {
  const lines: OverlayTableRenderedLineModel[] = [];

  columnOffsets.forEach((offset, index) => {
    const key = getTableVerticalLineKey(table, index);
    if (!key) {
      return;
    }
    const border = resolveTableLineBorder(table, key);
    if (!shouldRenderTableLineOverlay(border)) {
      return;
    }
    lines.push({
      axis: "vertical",
      key,
      domKey: getTableLineDomKey(key),
      style: getTableRenderedLineStyleModel("vertical", offset, border),
    });
  });

  rowOffsets.forEach((offset, index) => {
    const key = getTableHorizontalLineKey(table, index);
    if (!key) {
      return;
    }
    const border = resolveTableLineBorder(table, key);
    if (!shouldRenderTableLineOverlay(border)) {
      return;
    }
    lines.push({
      axis: "horizontal",
      key,
      domKey: getTableLineDomKey(key),
      style: getTableRenderedLineStyleModel("horizontal", offset, border),
    });
  });

  return lines;
}

/**
 * Little stubs that close the gap where a `double` line crosses a perpendicular one.
 *
 * The generation order — every horizontal connector first, then every vertical one — is part of
 * the contract: it fixes both the DOM order and the ids the React keys are built from.
 */
export function getTableRenderedLineConnectorModels(
  table: SigmaTableSpec,
  columnOffsets: number[],
  rowOffsets: number[],
): OverlayTableLineConnectorModel[] {
  const connectors: OverlayTableLineConnectorModel[] = [];

  columnOffsets.forEach((columnOffset, columnIndex) => {
    const verticalKey = getTableVerticalLineKey(table, columnIndex);
    if (!verticalKey) {
      return;
    }
    const verticalBorder = resolveTableLineBorder(table, verticalKey);
    if (!shouldRenderTableLineOverlay(verticalBorder)) {
      return;
    }

    rowOffsets.forEach((rowOffset, rowIndex) => {
      const horizontalKey = getTableHorizontalLineKey(table, rowIndex);
      if (!horizontalKey) {
        return;
      }
      const horizontalBorder = resolveTableLineBorder(table, horizontalKey);
      if (!horizontalBorder.visible || horizontalBorder.borderWidth <= 0) {
        return;
      }

      connectors.push({
        axis: "horizontal",
        id: `connector-horizontal-${getTableLineDomKey(verticalKey)}-${getTableLineDomKey(horizontalKey)}`,
        style: {
          left: `${columnOffset - verticalBorder.borderWidth / 2}px`,
          top: `${rowOffset - horizontalBorder.borderWidth / 2}px`,
          width: `${verticalBorder.borderWidth}px`,
          height: "0px",
          borderTop: getTableCssBorderValue(horizontalBorder),
        },
      });
    });
  });

  rowOffsets.forEach((rowOffset, rowIndex) => {
    const horizontalKey = getTableHorizontalLineKey(table, rowIndex);
    if (!horizontalKey) {
      return;
    }
    const horizontalBorder = resolveTableLineBorder(table, horizontalKey);
    if (!shouldRenderTableLineOverlay(horizontalBorder)) {
      return;
    }

    columnOffsets.forEach((columnOffset, columnIndex) => {
      const verticalKey = getTableVerticalLineKey(table, columnIndex);
      if (!verticalKey) {
        return;
      }
      const verticalBorder = resolveTableLineBorder(table, verticalKey);
      if (!verticalBorder.visible || verticalBorder.borderWidth <= 0) {
        return;
      }

      connectors.push({
        axis: "vertical",
        id: `connector-vertical-${getTableLineDomKey(horizontalKey)}-${getTableLineDomKey(verticalKey)}`,
        style: {
          left: `${columnOffset - verticalBorder.borderWidth / 2}px`,
          top: `${rowOffset - horizontalBorder.borderWidth / 2}px`,
          width: "0px",
          height: `${horizontalBorder.borderWidth}px`,
          borderLeft: getTableCssBorderValue(verticalBorder),
        },
      });
    });
  });

  return connectors;
}
