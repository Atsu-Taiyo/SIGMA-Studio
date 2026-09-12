// Type-only on purpose: `features/drawing` may hold exactly one runtime dependency on the document
// feature, and it is the font facade. Series colours therefore arrive as a resolver argument.
import type {
  SigmaChartData,
  SigmaChartSeries,
  SigmaChartSpec,
} from "@/features/document";

/**
 * Chart geometry, computed once and shared by every surface that draws a chart.
 *
 * This module is the `graph-layout.ts` of data charts: pure arithmetic, no DOM, no React. The editor
 * canvas, the static React view and the SVG export all map this same object onto elements, which is
 * what makes the three agree pixel for pixel instead of agreeing by inspection.
 */

/** Ink, gridlines and axis. Values, not CSS variables: the exported SVG carries no stylesheet. */
export const CHART_TEXT_COLOR = "#111827";
export const CHART_AXIS_COLOR = "#9ca3af";
export const CHART_GRID_COLOR = "#e5e7eb";
/** The paper showing between two adjacent bars; also the ring between pie slices. */
export const CHART_SURFACE_COLOR = "#ffffff";

/**
 * Set explicitly rather than inherited: the exported SVG is also viewed standalone, where there is
 * no document stylesheet to inherit from, and parity between the three surfaces is checked by
 * comparing markup.
 */
export const CHART_FONT_FAMILY = "sans-serif";
export const CHART_TITLE_FONT_SIZE = 13;
export const CHART_LABEL_FONT_SIZE = 11;
export const CHART_LINE_WIDTH = 2;
export const CHART_MARKER_RADIUS = 4;
export const CHART_BAR_RADIUS = 4;
/** Paper gap between adjacent bars of one group, in px. */
export const CHART_BAR_GAP = 2;

const PADDING = 12;
const TITLE_BLOCK_HEIGHT = 22;
const Y_AXIS_GUTTER = 44;
const X_AXIS_BAND_HEIGHT = 20;
const LEGEND_ROW_HEIGHT = 18;
const LEGEND_SWATCH = 10;
const LEGEND_GAP = 12;
/** Narrowest bar we will draw; below this a group degrades to touching bars, never escaping ones. */
const MIN_BAR_WIDTH = 0.5;
/**
 * Legend label width, estimated per glyph.
 *
 * A single Latin advance would under-measure Japanese by nearly half — this app's primary locale —
 * and the entries would overlap each other and run off the right edge. Full-width glyphs advance
 * roughly one em; Latin roughly half.
 */
const LEGEND_LATIN_ADVANCE = 0.56;
const LEGEND_WIDE_ADVANCE = 1;
const TARGET_TICK_INTERVALS = 4;
/** Beyond this the axis carries no information; clamping keeps the tick loop finite. */
const SCALE_LIMIT = 1e15;
/** Belt and braces for the tick loop, so no arithmetic surprise can make it unbounded. */
const MAX_TICKS = 64;

export interface ChartTick {
  value: number;
  /** Pixel position along the tick's axis (y for value ticks, x for category/scatter ticks). */
  position: number;
  label: string;
}

export interface ChartRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChartBar extends ChartRect {
  seriesId: string;
  color: string;
  value: number;
}

export interface ChartLine {
  seriesId: string;
  color: string;
  /** May contain several `M` subpaths: a gap breaks the line rather than bridging it. */
  d: string;
  markers: { x: number; y: number }[];
}

export interface ChartSlice {
  id: string;
  label: string;
  color: string;
  value: number;
  startAngle: number;
  endAngle: number;
  d: string;
}

export interface ChartPoint {
  seriesId: string;
  color: string;
  x: number;
  y: number;
}

export interface ChartLegendEntry {
  id: string;
  label: string;
  color: string;
  x: number;
  y: number;
}

export interface ChartRenderLayout {
  kind: SigmaChartSpec["kind"];
  width: number;
  height: number;
  plot: ChartRect;
  title: { text: string; x: number; y: number } | null;
  /** Value axis ticks with their y positions; empty for pie. */
  valueTicks: ChartTick[];
  /** Category (bar/line) or numeric (scatter) ticks with their x positions; empty for pie. */
  categoryTicks: ChartTick[];
  /** y of the value 0, where bars stand and the zero gridline is drawn. */
  baselineY: number;
  bars: ChartBar[];
  lines: ChartLine[];
  slices: ChartSlice[];
  points: ChartPoint[];
  legend: ChartLegendEntry[];
  /** Nothing to draw — the caller shows its own "no data" affordance. */
  empty: boolean;
}

/**
 * Rounds a raw step up to a readable one (1, 2, 2.5, 5 or 10 times a power of ten), so an axis
 * reads 0/25/50/75/100 rather than 0/24.25/48.5/72.75/97.
 */
export function niceChartStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const fraction = rawStep / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

export interface ChartScale {
  min: number;
  max: number;
  step: number;
  values: number[];
}

/**
 * A tick scale covering `[min, max]`.
 *
 * A degenerate range (every value identical, including all-zero) still yields a real scale — an axis
 * that collapses to a single line has no baseline for bars to stand on.
 */
export function getChartScale(min: number, max: number): ChartScale {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? max : 0;
  // Two cells at the far ends of the double range make `hi - lo` overflow to Infinity, which turns
  // the tick loop below into an unbounded allocation that throws out of a function all three render
  // surfaces call. An axis is meaningless at that magnitude anyway, so the window is clamped.
  let lo = Math.max(Math.min(safeMin, safeMax), -SCALE_LIMIT);
  let hi = Math.min(Math.max(safeMin, safeMax), SCALE_LIMIT);
  if (lo > hi) {
    [lo, hi] = [hi, lo];
  }
  if (lo === hi) {
    // All values equal: open a unit window around them so the axis keeps a height.
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) : 1;
    lo = lo - pad;
    hi = hi + pad;
  }
  const step = niceChartStep((hi - lo) / TARGET_TICK_INTERVALS);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const values: number[] = [];
  // Accumulating by index avoids the drift that `for (v = min; v <= max; v += step)` collects.
  const rawCount = Math.round((niceMax - niceMin) / step);
  const count = Number.isFinite(rawCount) ? Math.min(Math.max(rawCount, 1), MAX_TICKS) : 1;
  for (let index = 0; index <= count; index += 1) {
    values.push(roundToStep(niceMin + index * step, step));
  }
  return { min: niceMin, max: niceMax, step, values };
}

/** Trims the float noise that `min + index * step` leaves behind (0.1 + 0.2 …). */
function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.min(12, -Math.floor(Math.log10(step)) + 2));
  return Number(value.toFixed(decimals));
}

export function formatChartTickLabel(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Number(value.toFixed(6)));
}

/** Supplies the colour for a series or a pie slice; see `resolveChartSeriesColor` in the document feature. */
export type ChartSeriesColorResolver = (seriesId: string, index: number) => string;

/**
 * The colour key of one pie slice.
 *
 * Keyed on the slice's own label rather than its position, because `seriesColors` is an
 * entity-keyed contract: blanking a cell drops that entry and shifts every later index, which
 * would slide an author's chosen colour onto a different slice. A blank label has no entity to
 * name, so it falls back to its position.
 */
function pieSliceKey(seriesId: string, label: string, index: number): string {
  return label === "" ? `${seriesId}:#${index}` : `${seriesId}:${label}`;
}

/** One colourable thing in a chart: a series, or a pie slice. */
export interface ChartColorTarget {
  /** The key `spec.seriesColors` stores this colour under. */
  key: string;
  /** What to call it in a legend or a settings panel. */
  name: string;
  /** Position among the targets, which is what picks the palette fallback. */
  index: number;
}

/**
 * What a chart can colour, in draw order.
 *
 * The renderer and the settings panel both read this rather than each deriving keys of their own.
 * They had drifted: the panel keyed pie slices by position in the *unfiltered* label list while the
 * renderer keyed them by position after dropping empty and negative entries, so a snapshot-backed
 * pie coloured a key nothing drew and showed the wrong palette swatch for every slice after a gap.
 */
export function getChartColorTargets(data: SigmaChartData, spec: SigmaChartSpec): ChartColorTarget[] {
  const drawable = data.series.filter(hasValue);
  if (spec.kind === "scatter") {
    return getScatterSplit(data).series.map((series, index) => ({ key: series.id, name: series.name, index }));
  }
  if (spec.kind !== "pie") {
    return drawable.map((series, index) => ({ key: series.id, name: series.name, index }));
  }
  const first = drawable[0];
  if (!first) {
    return [];
  }
  const seriesId = first.id;
  return data.labels
    .map((label, index) => ({ label, value: valueAt(first, index) }))
    .filter((entry): entry is { label: string; value: number } => entry.value !== null && entry.value >= 0)
    .map((entry, index) => ({ key: pieSliceKey(seriesId, entry.label, index), name: entry.label, index }));
}

function hasValue(series: SigmaChartSeries): boolean {
  return series.values.some((value) => value !== null);
}

/** Reads `values[index]` defensively: the model does not force `values` to match `labels`. */
function valueAt(series: SigmaChartSeries, index: number): number | null {
  const value = series.values[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getChartRenderLayout(
  data: SigmaChartData,
  spec: SigmaChartSpec,
  size: { w: number; h: number },
  resolveSeriesColor: ChartSeriesColorResolver,
): ChartRenderLayout {
  const width = Math.max(1, size.w);
  const height = Math.max(1, size.h);
  const drawable = data.series.filter(hasValue);
  const title = spec.title?.trim() ? spec.title.trim() : null;
  const empty = drawable.length === 0 || data.labels.length === 0;

  const base = {
    kind: spec.kind,
    width,
    height,
    title: title ? { text: title, x: width / 2, y: PADDING + CHART_TITLE_FONT_SIZE } : null,
    valueTicks: [] as ChartTick[],
    categoryTicks: [] as ChartTick[],
    bars: [] as ChartBar[],
    lines: [] as ChartLine[],
    slices: [] as ChartSlice[],
    points: [] as ChartPoint[],
    legend: [] as ChartLegendEntry[],
  };

  if (spec.kind === "pie") {
    return layoutPie(data, spec, base, empty ? [] : drawable, resolveSeriesColor, { width, height, title: Boolean(title) });
  }

  const targets = getChartColorTargets(data, spec);
  const seriesColors = targets.map((target) => resolveSeriesColor(target.key, target.index));
  const legendEntries = spec.legend && targets.length >= 2
    ? targets.map((target, index) => ({ id: target.key, label: target.name, color: seriesColors[index] }))
    : [];
  const legendRows = countLegendRows(legendEntries, width);
  const legendHeight = legendRows * LEGEND_ROW_HEIGHT;

  const plot: ChartRect = {
    x: PADDING + Y_AXIS_GUTTER,
    y: PADDING + (title ? TITLE_BLOCK_HEIGHT : 0),
    w: Math.max(1, width - PADDING * 2 - Y_AXIS_GUTTER),
    h: Math.max(
      1,
      height - PADDING * 2 - (title ? TITLE_BLOCK_HEIGHT : 0) - X_AXIS_BAND_HEIGHT - legendHeight,
    ),
  };

  // `Number.isFinite`, not `!== null`: `valueAt` rejects non-finite entries when plotting, and a
  // scale built from a wider set than the marks would rescale the whole chart around a value that
  // is never drawn.
  // Planned before the scale: a scatter spends one series on x, and letting those numbers into the
  // value axis would stretch y by the x range — the same chart would then look different depending
  // on whether it was drawn from live data (already reduced) or from a snapshot (not).
  const scatterPlan: ScatterPlan | null = spec.kind === "scatter"
    ? { ...getScatterSplit(data), colors: seriesColors }
    : null;
  const valueSeries = scatterPlan ? scatterPlan.series : drawable;
  const values = valueSeries.flatMap((series) => (
    series.values.filter((value): value is number => value !== null && Number.isFinite(value))
  ));
  // A bar stands on zero, so the axis must contain it. A line or a scatter is a position rather than
  // a magnitude, so it only reaches for zero when the data already crosses it.
  const includeZero = spec.kind === "bar";
  const scale = getChartScale(
    Math.min(...values, includeZero ? 0 : Number.POSITIVE_INFINITY),
    Math.max(...values, includeZero ? 0 : Number.NEGATIVE_INFINITY),
  );
  const valueToY = (value: number): number => (
    plot.y + plot.h - ((value - scale.min) / (scale.max - scale.min)) * plot.h
  );
  const baselineY = valueToY(Math.min(Math.max(0, scale.min), scale.max));

  const valueTicks: ChartTick[] = empty ? [] : scale.values.map((value) => ({
    value,
    position: valueToY(value),
    label: formatChartTickLabel(value),
  }));

  const bandWidth = plot.w / Math.max(1, data.labels.length);
  const categoryTicks: ChartTick[] = empty || spec.kind === "scatter" ? [] : data.labels.map((label, index) => ({
    value: index,
    position: plot.x + (index + 0.5) * bandWidth,
    label,
  }));

  const legend = layoutLegend(legendEntries, width, plot.y + plot.h + X_AXIS_BAND_HEIGHT);

  if (empty) {
    return { ...base, plot, valueTicks: [], categoryTicks: [], baselineY, legend: [], empty: true };
  }

  if (spec.kind === "bar") {
    return {
      ...base,
      plot,
      valueTicks,
      categoryTicks,
      baselineY,
      legend,
      empty: false,
      bars: layoutBars(data, drawable, seriesColors, plot, bandWidth, valueToY, baselineY),
    };
  }

  if (spec.kind === "scatter") {
    const scatter = layoutScatter(scatterPlan, plot, valueToY);
    const scatterEmpty = scatter.points.length === 0;
    return {
      ...base,
      plot,
      // A scatter with no plottable pair keeps no axis: gridlines and labels around an empty plot
      // read as "all values are zero" rather than "there is nothing to draw".
      valueTicks: scatterEmpty ? [] : valueTicks,
      categoryTicks: scatterEmpty ? [] : scatter.ticks,
      baselineY,
      legend: scatterEmpty ? [] : legend,
      empty: scatterEmpty,
      points: scatter.points,
    };
  }

  return {
    ...base,
    plot,
    valueTicks,
    categoryTicks,
    baselineY,
    legend,
    empty: false,
    lines: layoutLines(data, drawable, seriesColors, plot, bandWidth, valueToY),
  };
}

function layoutBars(
  data: SigmaChartData,
  drawable: SigmaChartSeries[],
  colors: string[],
  plot: ChartRect,
  bandWidth: number,
  valueToY: (value: number) => number,
  baselineY: number,
): ChartBar[] {
  const groupWidth = bandWidth * 0.8;
  // Bars tile their group by stride, and the gap is carved out of the stride rather than added to
  // it. Sizing the bar first and then adding a fixed gap (with a minimum width floor) lets a
  // crowded group — many series in a narrow chart — grow past its band and spill over both its
  // neighbour and the plot's right edge. Deriving from the stride makes containment arithmetic
  // rather than something to remember, and a group too tight for the gap degrades to bars that
  // touch instead of bars that escape.
  const stride = groupWidth / drawable.length;
  const gap = Math.min(CHART_BAR_GAP, stride / 4);
  const barWidth = Math.min(stride, Math.max(MIN_BAR_WIDTH, stride - gap));
  const bars: ChartBar[] = [];
  data.labels.forEach((_, labelIndex) => {
    const groupLeft = plot.x + labelIndex * bandWidth + (bandWidth - groupWidth) / 2;
    drawable.forEach((series, seriesIndex) => {
      const value = valueAt(series, labelIndex);
      if (value === null) {
        return;
      }
      const valueY = valueToY(value);
      bars.push({
        seriesId: series.id,
        color: colors[seriesIndex],
        value,
        x: groupLeft + seriesIndex * stride,
        y: Math.min(valueY, baselineY),
        w: barWidth,
        h: Math.abs(valueY - baselineY),
      });
    });
  });
  return bars;
}

function layoutLines(
  data: SigmaChartData,
  drawable: SigmaChartSeries[],
  colors: string[],
  plot: ChartRect,
  bandWidth: number,
  valueToY: (value: number) => number,
): ChartLine[] {
  return drawable.flatMap((series, seriesIndex) => {
    const commands: string[] = [];
    const markers: { x: number; y: number }[] = [];
    let penDown = false;
    data.labels.forEach((_, labelIndex) => {
      const value = valueAt(series, labelIndex);
      if (value === null) {
        // A gap breaks the stroke: bridging it would draw a measurement nobody recorded.
        penDown = false;
        return;
      }
      const x = plot.x + (labelIndex + 0.5) * bandWidth;
      const y = valueToY(value);
      commands.push(`${penDown ? "L" : "M"}${round(x)} ${round(y)}`);
      markers.push({ x, y });
      penDown = true;
    });
    if (markers.length === 0) {
      return [];
    }
    return [{ seriesId: series.id, color: colors[seriesIndex], d: commands.join(" "), markers }];
  });
}

interface ScatterPlan {
  xValues: readonly (number | null)[];
  series: SigmaChartSeries[];
  colors: string[];
}

/**
 * Which series a scatter plots, and what it uses for x.
 *
 * `xValues` is present when the data was derived for a scatter. A snapshot instead holds the
 * table's full reading (so a later kind change keeps every series), so the same choice is made
 * here: numeric labels are the x axis, otherwise the first series is spent on it.
 *
 * Data only, no colours, because the colour targets are derived from the result — a series spent
 * on the x axis is not drawn, so it takes no legend entry, no swatch and no palette slot.
 */
function getScatterSplit(data: SigmaChartData): {
  xValues: readonly (number | null)[];
  series: SigmaChartSeries[];
} {
  const drawable = data.series.filter(hasValue);
  if (data.xValues) {
    return { xValues: data.xValues, series: drawable };
  }
  const labelNumbers = data.labels.map((label) => Number(label.trim()));
  if (data.labels.length > 0 && labelNumbers.every((value) => Number.isFinite(value))) {
    return { xValues: labelNumbers, series: drawable };
  }
  if (drawable.length > 0) {
    return { xValues: drawable[0].values, series: drawable.slice(1) };
  }
  return { xValues: data.labels.map((_, index) => index), series: [] };
}

function layoutScatter(
  plan: ScatterPlan | null,
  plot: ChartRect,
  valueToY: (value: number) => number,
): { points: ChartPoint[]; ticks: ChartTick[] } {
  if (!plan) {
    return { points: [], ticks: [] };
  }
  const numericX = plan.xValues.filter((value): value is number => value !== null && Number.isFinite(value));
  if (numericX.length === 0) {
    return { points: [], ticks: [] };
  }
  const xScale = getChartScale(Math.min(...numericX), Math.max(...numericX));
  const xToPx = (value: number): number => (
    plot.x + ((value - xScale.min) / (xScale.max - xScale.min)) * plot.w
  );
  const points: ChartPoint[] = [];
  plan.series.forEach((entry, seriesIndex) => {
    plan.xValues.forEach((rawX, index) => {
      const y = valueAt(entry, index);
      if (rawX === null || !Number.isFinite(rawX) || y === null) {
        return;
      }
      points.push({ seriesId: entry.id, color: plan.colors[seriesIndex], x: xToPx(rawX), y: valueToY(y) });
    });
  });
  const ticks = xScale.values.map((value) => ({
    value,
    position: xToPx(value),
    label: formatChartTickLabel(value),
  }));
  return { points, ticks };
}

function layoutPie(
  data: SigmaChartData,
  spec: SigmaChartSpec,
  base: Omit<ChartRenderLayout, "plot" | "baselineY" | "empty">,
  drawable: SigmaChartSeries[],
  resolveSeriesColor: ChartSeriesColorResolver,
  frame: { width: number; height: number; title: boolean },
): ChartRenderLayout {
  const series = drawable[0];
  const slices: ChartSlice[] = [];
  const entries = series
    ? data.labels.map((label, index) => ({ label, value: valueAt(series, index) }))
        .filter((entry): entry is { label: string; value: number } => entry.value !== null && entry.value >= 0)
    : [];
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  // Same list the settings panel colours, so a swatch always names the slice it paints.
  const targets = getChartColorTargets(data, spec);

  const legendEntries = spec.legend && targets.length >= 2
    ? targets.map((target) => ({
        id: target.key,
        label: target.name,
        color: resolveSeriesColor(target.key, target.index),
      }))
    : [];
  const legendRows = countLegendRows(legendEntries, frame.width);
  const legendHeight = legendRows * LEGEND_ROW_HEIGHT;

  const plot: ChartRect = {
    x: PADDING,
    y: PADDING + (frame.title ? TITLE_BLOCK_HEIGHT : 0),
    w: Math.max(1, frame.width - PADDING * 2),
    h: Math.max(1, frame.height - PADDING * 2 - (frame.title ? TITLE_BLOCK_HEIGHT : 0) - legendHeight),
  };
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const radius = Math.max(1, Math.min(plot.w, plot.h) / 2);

  // Total 0 means every slice would be 0/0: there is no whole to divide, so nothing is drawn.
  if (total > 0) {
    let angle = -Math.PI / 2;
    entries.forEach((entry, index) => {
      const sweep = (entry.value / total) * Math.PI * 2;
      const startAngle = angle;
      const endAngle = angle + sweep;
      const target = targets[index];
      const key = target?.key ?? pieSliceKey(series?.id ?? "series", entry.label, index);
      slices.push({
        id: key,
        label: entry.label,
        color: resolveSeriesColor(key, target?.index ?? index),
        value: entry.value,
        startAngle,
        endAngle,
        d: describeSlicePath(cx, cy, radius, startAngle, endAngle),
      });
      angle = endAngle;
    });
  }

  // No slices means no whole to divide, so there is nothing for a legend to name either — a colour
  // key floating over blank paper reads as a rendering failure rather than as "no data".
  const empty = slices.length === 0;
  return {
    ...base,
    plot,
    valueTicks: [],
    categoryTicks: [],
    baselineY: cy,
    slices,
    legend: empty ? [] : layoutLegend(legendEntries, frame.width, plot.y + plot.h),
    empty,
  };
}

/**
 * One slice as a wedge. A slice covering the whole circle is drawn as two arcs: a single arc whose
 * start and end coincide renders as nothing at all.
 */
function describeSlicePath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  if (sweep >= Math.PI * 2 - 1e-9) {
    const top = `${round(cx)} ${round(cy - radius)}`;
    const bottom = `${round(cx)} ${round(cy + radius)}`;
    return `M${top} A${round(radius)} ${round(radius)} 0 1 1 ${bottom} A${round(radius)} ${round(radius)} 0 1 1 ${top} Z`;
  }
  const start = pointOnCircle(cx, cy, radius, startAngle);
  const end = pointOnCircle(cx, cy, radius, endAngle);
  const largeArc = sweep > Math.PI ? 1 : 0;
  return [
    `M${round(cx)} ${round(cy)}`,
    `L${round(start.x)} ${round(start.y)}`,
    `A${round(radius)} ${round(radius)} 0 ${largeArc} 1 ${round(end.x)} ${round(end.y)}`,
    "Z",
  ].join(" ");
}

function pointOnCircle(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/** Full-width scripts (CJK, kana, full-width forms) advance about twice as far as Latin. */
function isWideGlyph(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6);
}

export function estimateChartLabelWidth(label: string): number {
  let width = 0;
  for (const glyph of label) {
    const codePoint = glyph.codePointAt(0) ?? 0;
    width += CHART_LABEL_FONT_SIZE * (isWideGlyph(codePoint) ? LEGEND_WIDE_ADVANCE : LEGEND_LATIN_ADVANCE);
  }
  return width;
}

function legendEntryWidth(label: string): number {
  return LEGEND_SWATCH + 4 + estimateChartLabelWidth(label) + LEGEND_GAP;
}

function countLegendRows(
  entries: readonly { label: string }[],
  width: number,
): number {
  if (entries.length === 0) {
    return 0;
  }
  const available = Math.max(1, width - PADDING * 2);
  let rows = 1;
  let cursor = 0;
  for (const entry of entries) {
    const entryWidth = legendEntryWidth(entry.label);
    if (cursor > 0 && cursor + entryWidth > available) {
      rows += 1;
      cursor = 0;
    }
    cursor += entryWidth;
  }
  return rows;
}

function layoutLegend(
  entries: readonly { id: string; label: string; color: string }[],
  width: number,
  top: number,
): ChartLegendEntry[] {
  const available = Math.max(1, width - PADDING * 2);
  const placed: ChartLegendEntry[] = [];
  let cursor = 0;
  let row = 0;
  for (const entry of entries) {
    const entryWidth = legendEntryWidth(entry.label);
    if (cursor > 0 && cursor + entryWidth > available) {
      row += 1;
      cursor = 0;
    }
    placed.push({
      id: entry.id,
      label: entry.label,
      color: entry.color,
      x: PADDING + cursor,
      y: top + row * LEGEND_ROW_HEIGHT + LEGEND_ROW_HEIGHT / 2,
    });
    cursor += entryWidth;
  }
  return placed;
}

/** Path data is compared as strings across three renderers, so it must round identically. */
function round(value: number): number {
  return Number(value.toFixed(2));
}
