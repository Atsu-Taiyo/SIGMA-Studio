export type SigmaChartKind = "bar" | "line" | "pie" | "scatter";

/**
 * The author's intent for a chart. Everything here is chosen by a person; nothing is derived.
 *
 * The data a chart draws lives elsewhere on the shape — read live from the referenced table, or from
 * the snapshot when that table is gone — so a settings panel writing this object can never race the
 * snapshot sync for the same field.
 */
export interface SigmaChartSpec {
  version: 1;
  kind: SigmaChartKind;
  /**
   * Which axis of the table carries the series.
   *
   * `"columns"` (the default) reads the first row as headers and the first column as labels;
   * `"rows"` is the same reading of the transposed table, which is what the swap toggle flips.
   */
  orientation: "columns" | "rows";
  /** Treat the leading row (after any transpose) as series names rather than data. */
  headerRow: boolean;
  /** Treat the leading column (after any transpose) as category labels rather than data. */
  labelColumn: boolean;
  title?: string;
  legend: boolean;
  /**
   * Series colour keyed by the table's own `column.id` / `row.id`.
   *
   * Keying on the track id rather than the series index is what keeps a colour attached to its
   * entity: inserting or reordering a column leaves every existing series the colour it had.
   */
  seriesColors: Record<string, string>;
}

export interface SigmaChartSeries {
  /** The `column.id` / `row.id` the series was read from. Stable across edits to the table. */
  id: string;
  name: string;
  /** One entry per label. `null` marks a cell that held no number — a gap, not a zero. */
  values: (number | null)[];
}

/** Derived drawing input: also what a chart persists so it survives losing its table. */
export interface SigmaChartData {
  labels: string[];
  series: SigmaChartSeries[];
  /** Scatter only: the x coordinate of each point, parallel to `labels`. */
  xValues?: (number | null)[];
}

/**
 * Eight categorical colours that stay apart on white paper, drawn from the saturated band of the
 * shared palette so a chart sits with the other figures in a document rather than beside them.
 */
export const CHART_SERIES_PALETTE: readonly string[] = [
  "#0083d5",
  "#d95800",
  "#069041",
  "#c40000",
  "#5b27d2",
  "#008f82",
  "#d9a300",
  "#88b020",
];

/**
 * Series past the eighth are grey on purpose. Cycling the palette would give two series the same
 * colour, which reads as "these are related" — a neutral says "too many to tell apart" instead.
 */
export const CHART_SERIES_FALLBACK_COLOR = "#737373";
