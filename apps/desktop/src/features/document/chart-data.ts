import { CHART_SERIES_FALLBACK_COLOR, CHART_SERIES_PALETTE } from "./model/chart";
import { isSafeCssColor } from "./css-safety";
import { getTableCellFormulaResult } from "./model/table-formula";
import { getTableCellMatrix } from "./model/table-grid";
import { parseChartNumber } from "./model/table-number";
import { inlineNodesToPlainText } from "./model/rich-text";
import type { SigmaChartData, SigmaChartSeries, SigmaChartSpec } from "./model/chart";
import type { OverlayShape, SigmaTableCell, SigmaTableSpec } from "./overlay-model";

export interface DeriveChartDataOptions {
  /**
   * Names a series whose header cell is missing or blank.
   *
   * Left at the default in the app, deliberately. The derived name is persisted in a chart's
   * snapshot, so sourcing it from the UI language would make document content depend on the
   * viewer's locale — switching to English would rewrite every chart-bearing document, and the
   * legend the canvas draws would disagree with the panel. The ordinal reads the same everywhere.
   * The hook stays for callers that render names outside a document.
   */
  seriesNameFallback?: (index: number) => string;
}

function defaultSeriesNameFallback(index: number): string {
  return String(index + 1);
}

// Re-exported so the chart derivation stays the one import site callers already know, while the
// parser itself sits beside the grid expansion the formula engine reads cells through.
export { parseChartNumber };

/**
 * Reads a table the way the chart's spec says to read it: labels, series, and (for scatter) the x
 * coordinates. Pure — the same table and spec always give the same data.
 */
export function deriveChartData(
  table: SigmaTableSpec,
  spec: SigmaChartSpec,
  options: DeriveChartDataOptions = {},
): SigmaChartData {
  const seriesNameFallback = options.seriesNameFallback ?? defaultSeriesNameFallback;
  const matrix = getTableCellMatrix(table);
  const transposed = spec.orientation === "rows";
  const rowCount = transposed ? matrix.columnCount : matrix.rowCount;
  const columnCount = transposed ? matrix.rowCount : matrix.columnCount;
  const seriesIds = transposed
    ? table.rows.map((row) => row.id)
    : table.columns.map((column) => column.id);

  // One accessor for both orientations: "rows" is the same grid read with the indices swapped, so
  // the header/label rules below never have to know which way round the table is.
  const cellAt = (rowIndex: number, columnIndex: number): SigmaTableCell | undefined => (
    transposed
      ? matrix.occupants[columnIndex]?.[rowIndex]?.cell
      : matrix.occupants[rowIndex]?.[columnIndex]?.cell
  );

  const firstDataRow = spec.headerRow && rowCount > 0 ? 1 : 0;
  const firstSeriesColumn = spec.labelColumn && columnCount > 0 ? 1 : 0;

  const labels: string[] = [];
  for (let rowIndex = firstDataRow; rowIndex < rowCount; rowIndex += 1) {
    labels.push(firstSeriesColumn > 0
      ? getTableCellText(table, cellAt(rowIndex, 0))
      : String(rowIndex - firstDataRow + 1));
  }

  const series: SigmaChartSeries[] = [];
  for (let columnIndex = firstSeriesColumn; columnIndex < columnCount; columnIndex += 1) {
    const values: (number | null)[] = [];
    for (let rowIndex = firstDataRow; rowIndex < rowCount; rowIndex += 1) {
      values.push(getTableCellNumber(table, cellAt(rowIndex, columnIndex)));
    }
    // A column that holds no number at all is not a series — it is prose next to the data.
    if (!values.some((value) => value !== null)) {
      continue;
    }
    const headerText = firstDataRow > 0 ? getTableCellText(table, cellAt(0, columnIndex)).trim() : "";
    series.push({
      id: seriesIds[columnIndex] ?? String(columnIndex),
      name: headerText === "" ? seriesNameFallback(series.length) : headerText,
      values,
    });
  }

  if (spec.kind === "pie") {
    return toPieChartData(labels, series);
  }
  if (spec.kind === "scatter") {
    return toScatterChartData(labels, series, firstSeriesColumn > 0);
  }
  return { labels, series };
}

/**
 * The table's full reading — every series, before any chart kind narrows it.
 *
 * This is what a chart persists. `deriveChartData` reduces for the kind being drawn (a pie keeps
 * one filtered series; a scatter spends one on the x axis), and storing *that* would make the
 * snapshot lossy: switch to pie, lose the table, switch back to bar, and the other series are gone
 * for good. The renderers narrow whatever they are handed, so keeping the whole reading here costs
 * nothing and keeps the fallback complete.
 */
export function deriveChartSnapshotData(
  table: SigmaTableSpec,
  spec: SigmaChartSpec,
  options: DeriveChartDataOptions = {},
): SigmaChartData {
  return spec.kind === "bar" || spec.kind === "line"
    ? deriveChartData(table, spec, options)
    : deriveChartData(table, { ...spec, kind: "bar" }, options);
}

/** A pie shows one whole, so it draws the first series only, and only its non-negative slices. */
function toPieChartData(labels: string[], series: SigmaChartSeries[]): SigmaChartData {
  const first = series[0];
  if (!first) {
    return { labels: [], series: [] };
  }
  const kept: number[] = [];
  first.values.forEach((value, index) => {
    if (value !== null && value >= 0) {
      kept.push(index);
    }
  });
  return {
    labels: kept.map((index) => labels[index] ?? ""),
    series: [{ ...first, values: kept.map((index) => first.values[index]) }],
  };
}

/**
 * A scatter needs an x for every point. Numeric labels are the natural source; when the label column
 * is prose (or absent) the first numeric series becomes x and stops being something to plot.
 */
function toScatterChartData(
  labels: string[],
  series: SigmaChartSeries[],
  hasLabelColumn: boolean,
): SigmaChartData {
  const labelNumbers = labels.map((label) => parseChartNumber(label));
  if (hasLabelColumn && labels.length > 0 && labelNumbers.every((value) => value !== null)) {
    return { labels, series, xValues: labelNumbers };
  }
  const [xSeries, ...rest] = series;
  if (!xSeries) {
    return { labels, series };
  }
  return { labels, series: rest, xValues: xSeries.values };
}

/**
 * The data a chart should draw right now.
 *
 * Live table first, snapshot second — and the choice lives here rather than at each surface so the
 * editor, the static tree and the SVG export cannot disagree about which one they are showing. A
 * chart whose table was deleted, whose reference was dropped on paste, or which sits in a running
 * region that structurally cannot see the body keeps drawing from its snapshot.
 */
export function resolveChartData(
  props: { spec: SigmaChartSpec; dataSnapshot: SigmaChartData },
  sourceTable: SigmaTableSpec | null | undefined,
  options: DeriveChartDataOptions = {},
): SigmaChartData {
  if (!sourceTable) {
    return props.dataSnapshot;
  }
  // The options object is part of the key rather than a reason to skip the cache: callers hold a
  // memoized one (it only changes with the locale), so keying on its identity keeps a localized
  // fallback correct *and* memoized. An inline options object simply misses and is collected.
  const optionsKey: object = options.seriesNameFallback ? options : DEFAULT_DERIVE_OPTIONS;
  let bySpec = derivedChartDataCache.get(sourceTable);
  if (!bySpec) {
    bySpec = new WeakMap();
    derivedChartDataCache.set(sourceTable, bySpec);
  }
  let byOptions = bySpec.get(props.spec);
  if (!byOptions) {
    byOptions = new WeakMap();
    bySpec.set(props.spec, byOptions);
  }
  const cached = byOptions.get(optionsKey);
  if (cached) {
    return cached;
  }
  const derived = deriveChartData(sourceTable, props.spec, options);
  byOptions.set(optionsKey, derived);
  return derived;
}

/**
 * Derived data, memoized on the identity of the table and the spec it was read from.
 *
 * Identity stability is the point, not just the saved arithmetic: the SVG export memoizes chart
 * markup on the identity of the `SigmaChartData` it is handed, so a fresh object per call would
 * make that cache miss every single time — which is exactly what it did before this memo existed.
 * Both keys are objects held weakly, so nothing needs evicting; table and spec are immutable
 * snapshots in the overlay model, so identity is a sound key with no invalidation logic.
 */
const derivedChartDataCache = new WeakMap<
  SigmaTableSpec,
  WeakMap<SigmaChartSpec, WeakMap<object, SigmaChartData>>
>();

/** Stands in for "no options", so the options axis is always an object key. */
const DEFAULT_DERIVE_OPTIONS: DeriveChartDataOptions = {};

const snapshotDataCache = new WeakMap<
  SigmaTableSpec,
  WeakMap<SigmaChartSpec, WeakMap<object, SigmaChartData>>
>();

/** `deriveChartSnapshotData` memoized on (table, spec, options) identity; see `resolveChartData`. */
function deriveChartSnapshotDataMemoized(
  table: SigmaTableSpec,
  spec: SigmaChartSpec,
  options: DeriveChartDataOptions,
): SigmaChartData {
  const optionsKey: object = options.seriesNameFallback ? options : DEFAULT_DERIVE_OPTIONS;
  let bySpec = snapshotDataCache.get(table);
  if (!bySpec) {
    bySpec = new WeakMap();
    snapshotDataCache.set(table, bySpec);
  }
  let byOptions = bySpec.get(spec);
  if (!byOptions) {
    byOptions = new WeakMap();
    bySpec.set(spec, byOptions);
  }
  const cached = byOptions.get(optionsKey);
  if (cached) {
    return cached;
  }
  const derived = deriveChartSnapshotData(table, spec, options);
  byOptions.set(optionsKey, derived);
  return derived;
}

/**
 * The colour of one series: the author's choice when they made one, otherwise the palette entry for
 * its position. Past the palette everything is neutral grey — repeating a hue would claim two
 * unrelated series belong together.
 *
 * This lives beside the palette rather than in the drawing layer because `features/drawing` may not
 * import this feature at runtime (`features/drawing/architecture.test.ts` allows exactly one such
 * dependency, through the font facade). `getChartRenderLayout` therefore takes a resolver, and this
 * is the one every surface passes it.
 */
export function resolveChartSeriesColor(
  spec: SigmaChartSpec,
  seriesId: string,
  index: number,
): string {
  const chosen = Object.prototype.hasOwnProperty.call(spec.seriesColors, seriesId)
    ? spec.seriesColors[seriesId]
    : undefined;
  // The value-level backstop every sibling renderer carries (`overlay-svg.ts`, `Graph2DPreview`,
  // `OverlayTableStaticView`). The normalization and viewer boundaries already reject unsafe
  // colours, but pasting is a documented fourth entry that reaches live editor state without
  // passing either — so the single funnel every chart surface reads through checks it too.
  // Falling back to the palette keeps the policy that a bad colour costs one series its colour
  // and nothing more, rather than rejecting the whole document.
  if (typeof chosen === "string" && chosen !== "" && isSafeCssColor(chosen)) {
    return chosen;
  }
  return CHART_SERIES_PALETTE[index] ?? CHART_SERIES_FALLBACK_COLOR;
}

/**
 * Gives every series a colour, keeping the one it already had.
 *
 * New series take the first palette entry nobody is using, so inserting a column tints only the new
 * column. Past the palette everything is the neutral fallback.
 */
export function assignChartSeriesColors(
  seriesIds: readonly string[],
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const id of seriesIds) {
    const kept = Object.prototype.hasOwnProperty.call(existing, id) ? existing[id] : undefined;
    if (typeof kept === "string") {
      assigned.set(id, kept);
      used.add(kept);
    }
  }
  let cursor = 0;
  for (const id of seriesIds) {
    if (assigned.has(id)) {
      continue;
    }
    while (cursor < CHART_SERIES_PALETTE.length && used.has(CHART_SERIES_PALETTE[cursor])) {
      cursor += 1;
    }
    const color = CHART_SERIES_PALETTE[cursor] ?? CHART_SERIES_FALLBACK_COLOR;
    assigned.set(id, color);
    used.add(color);
    cursor += 1;
  }
  // `fromEntries` rather than assignment: it creates own properties even for keys like `__proto__`.
  return Object.fromEntries(assigned);
}

/**
 * The label/header text of a cell. Trend arrows carry no text and contribute nothing.
 *
 * A formula reads as what it evaluates to, so a header built with `=A2` names its series the way
 * the table displays it rather than showing the author their own source text in the legend.
 */
export function getTableCellText(table: SigmaTableSpec, cell: SigmaTableCell | undefined): string {
  if (!cell) {
    return "";
  }
  const formula = getCellFormulaResult(table, cell);
  if (formula) {
    return formula.display;
  }
  return getTableCellParagraphTexts(cell).join("\n");
}

/**
 * The number a cell holds, or `null` when it holds anything else.
 *
 * A cell with two paragraphs is ambiguous rather than empty — stripping the separator would splice
 * "1" and "2" into 12 — so it counts as no number at all.
 */
export function getTableCellNumber(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
): number | null {
  if (!cell) {
    return null;
  }
  // A trend cell is a direction arrow, never a measurement.
  if (cell.content.some((content) => content.type === "trend")) {
    return null;
  }
  const formula = getCellFormulaResult(table, cell);
  if (formula) {
    // An error is a gap, not a zero: the chart draws nothing there, the same as for a cell holding
    // prose. Plotting 0 would invent a data point the table does not contain.
    return formula.value.kind === "number" ? formula.value.value : null;
  }
  const texts = getTableCellParagraphTexts(cell);
  return texts.length === 1 ? parseChartNumber(texts[0]) : null;
}

/** The evaluation of a cell's formula, when its single paragraph holds one. */
function getCellFormulaResult(table: SigmaTableSpec, cell: SigmaTableCell) {
  const content = cell.content.length === 1 ? cell.content[0] : undefined;
  if (!content || content.type !== "paragraph") {
    return null;
  }
  return getTableCellFormulaResult(table, cell, content);
}

function getTableCellParagraphTexts(cell: SigmaTableCell): string[] {
  return cell.content
    .flatMap((content) => (content.type === "paragraph" ? [inlineNodesToPlainText(content.children)] : []))
    .map((text) => text.trim())
    .filter((text) => text !== "");
}

/** Value equality for derived chart data; see {@link syncChartDataSnapshots} for why it matters. */
export function chartDataEquals(a: SigmaChartData, b: SigmaChartData): boolean {
  if (a === b) {
    return true;
  }
  if (a.labels.length !== b.labels.length || a.series.length !== b.series.length) {
    return false;
  }
  if (a.labels.some((label, index) => label !== b.labels[index])) {
    return false;
  }
  if (!numbersEqual(a.xValues, b.xValues)) {
    return false;
  }
  return a.series.every((series, index) => {
    const other = b.series[index];
    return other !== undefined &&
      series.id === other.id &&
      series.name === other.name &&
      numbersEqual(series.values, other.values);
  });
}

function numbersEqual(
  a: readonly (number | null)[] | undefined,
  b: readonly (number | null)[] | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Refreshes every chart's `dataSnapshot` from the table it references.
 *
 * The snapshot is what a chart falls back to once its table is gone, so it has to be current at the
 * moment the table disappears — which means refreshing it on the way into the document rather than
 * hooking each of the many canvas paths that can change or delete a table (edit, undo, paste).
 *
 * Scope: this runs from the overlay canvas's own commit path. Writers that replace the document
 * wholesale — `applyExternalSnapshot`, and the AI apply path's table mutations — do not pass
 * through it, so a chart whose table is edited and deleted by one external write keeps the snapshot
 * it had before that write. Covering those means calling this from those writers too; it is a known
 * gap rather than something this function can close on its own.
 *
 * Copy-on-write, and gated on *value* equality rather than identity: the derivation is memoized per
 * table, so an identity check would rewrite every chart on every commit and mark an untouched
 * document dirty. Charts whose reference no longer resolves are left alone — their stale snapshot
 * is precisely the data they are meant to keep drawing.
 */
export function syncChartDataSnapshots(
  shapes: OverlayShape[],
  options: DeriveChartDataOptions = {},
): OverlayShape[] {
  let tables: Map<string, SigmaTableSpec> | undefined;
  let next: OverlayShape[] | undefined;
  shapes.forEach((shape, index) => {
    if (shape.type !== "chartShape" || !shape.props.sourceTableShapeId) {
      return;
    }
    if (!tables) {
      tables = new Map();
      for (const candidate of shapes) {
        if (candidate.type === "tableShape") {
          tables.set(candidate.id, candidate.props.table);
        }
      }
    }
    const table = tables.get(shape.props.sourceTableShapeId);
    if (!table) {
      return;
    }
    const derived = deriveChartSnapshotDataMemoized(table, shape.props.spec, options);
    if (chartDataEquals(derived, shape.props.dataSnapshot)) {
      return;
    }
    next ??= [...shapes];
    next[index] = { ...shape, props: { ...shape.props, dataSnapshot: derived } };
  });
  return next ?? shapes;
}
