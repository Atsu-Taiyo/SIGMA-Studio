import {
  assignChartSeriesColors,
  deriveChartData,
  type DeriveChartDataOptions,
  type SigmaChartData,
  type SigmaChartSpec,
  type SigmaTableSpec,
} from "@/features/document";

export const CHART_SHAPE_TYPE = "chartShape" as const;

/** A new chart is as tall as a table is wide, in the proportion a bar chart reads best at. */
export const CHART_ASPECT_RATIO = 0.62;
/** Gap between a table and the chart created from it. */
export const CHART_CREATE_GAP_PX = 16;
export const MIN_CHART_WIDTH = 160;
export const MIN_CHART_HEIGHT = 120;

export interface ChartShapeProps {
  w: number;
  h: number;
  spec: SigmaChartSpec;
  sourceTableShapeId?: string;
  dataSnapshot: SigmaChartData;
}

/**
 * The spec a brand-new chart starts from: a bar chart reading the table the way a person writes one
 * — first row as headers, first column as labels.
 *
 * `seriesColors` is materialized here rather than left empty so the author's palette is pinned at
 * creation. Leaving it empty would let a later column insertion re-index the fallback and quietly
 * repaint every existing series.
 */
export function createChartSpecForTable(
  table: SigmaTableSpec,
  options: DeriveChartDataOptions = {},
): SigmaChartSpec {
  const base: SigmaChartSpec = {
    version: 1,
    kind: "bar",
    orientation: "columns",
    headerRow: true,
    labelColumn: true,
    legend: true,
    seriesColors: {},
  };
  const data = deriveChartData(table, base, options);
  return { ...base, seriesColors: assignChartSeriesColors(data.series.map((series) => series.id)) };
}

/**
 * Props for a chart created from a table.
 *
 * The snapshot is written at creation even though the chart will read the table live: a chart whose
 * `dataSnapshot` is missing fails the overlay type guard, and a shape that fails that guard makes
 * the entire document refuse to open.
 */
export function createChartShapeProps(
  table: SigmaTableSpec,
  sourceTableShapeId: string,
  w: number,
  h: number,
  options: DeriveChartDataOptions = {},
): ChartShapeProps {
  const spec = createChartSpecForTable(table, options);
  return {
    w: Math.max(MIN_CHART_WIDTH, w),
    h: Math.max(MIN_CHART_HEIGHT, h),
    spec,
    sourceTableShapeId,
    dataSnapshot: deriveChartData(table, spec, options),
  };
}

/** Where a chart created from a table sits: directly beneath it, matching its width. */
export function getChartBoundsForTable(table: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const w = Math.max(MIN_CHART_WIDTH, table.w);
  return {
    x: table.x,
    y: table.y + table.h + CHART_CREATE_GAP_PX,
    w,
    h: Math.max(MIN_CHART_HEIGHT, Math.round(w * CHART_ASPECT_RATIO)),
  };
}
