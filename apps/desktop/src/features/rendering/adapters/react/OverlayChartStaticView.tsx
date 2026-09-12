"use client";

import { resolveChartSeriesColor, type SigmaChartData, type SigmaChartSpec } from "@/features/document";
import {
  CHART_AXIS_COLOR,
  CHART_BAR_RADIUS,
  CHART_FONT_FAMILY,
  CHART_GRID_COLOR,
  CHART_LABEL_FONT_SIZE,
  CHART_LINE_WIDTH,
  CHART_MARKER_RADIUS,
  CHART_SURFACE_COLOR,
  CHART_TEXT_COLOR,
  CHART_TITLE_FONT_SIZE,
  getChartRenderLayout,
  type ChartRenderLayout,
} from "@/features/drawing";

export interface OverlayChartStaticViewProps {
  data: SigmaChartData;
  spec: SigmaChartSpec;
  width: number;
  height: number;
}

/**
 * The one chart renderer. The editor canvas, the static React tree and the SVG export all mount this
 * component, so "the print looks like the screen" is true by construction rather than by review.
 *
 * Every colour, font and size is a presentation attribute: the exported SVG travels without the
 * document stylesheet (`AiEditPanel` re-parses it as `image/svg+xml`), so anything left to CSS would
 * simply be missing there. Geometry is never computed here — it all comes from
 * `getChartRenderLayout`, which is what keeps the three surfaces on identical coordinates.
 */
export function OverlayChartStaticView({ data, spec, width, height }: OverlayChartStaticViewProps) {
  const layout = getChartRenderLayout(
    data,
    spec,
    { w: width, h: height },
    (seriesId, index) => resolveChartSeriesColor(spec, seriesId, index),
  );

  return (
    <svg
      className="chart-shape-svg"
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
    >
      {layout.title ? (
        <text
          fill={CHART_TEXT_COLOR}
          fontFamily={CHART_FONT_FAMILY}
          fontSize={CHART_TITLE_FONT_SIZE}
          fontWeight="bold"
          textAnchor="middle"
          x={layout.title.x}
          y={layout.title.y}
        >
          {layout.title.text}
        </text>
      ) : null}
      <ChartAxes layout={layout} />
      <ChartMarks layout={layout} />
      <ChartLegend layout={layout} />
    </svg>
  );
}

/** Horizontal gridlines only, plus the baseline drawn a shade darker so zero reads as the floor. */
function ChartAxes({ layout }: { layout: ChartRenderLayout }) {
  if (layout.valueTicks.length === 0) {
    return null;
  }
  return (
    <g>
      {layout.valueTicks.map((tick) => (
        <g key={`value-${tick.value}`}>
          <line
            stroke={tick.value === 0 ? CHART_AXIS_COLOR : CHART_GRID_COLOR}
            strokeWidth={1}
            x1={layout.plot.x}
            x2={layout.plot.x + layout.plot.w}
            y1={tick.position}
            y2={tick.position}
          />
          <text
            dominantBaseline="middle"
            fill={CHART_TEXT_COLOR}
            fontFamily={CHART_FONT_FAMILY}
            fontSize={CHART_LABEL_FONT_SIZE}
            textAnchor="end"
            x={layout.plot.x - 6}
            y={tick.position}
          >
            {tick.label}
          </text>
        </g>
      ))}
      {layout.categoryTicks.map((tick) => (
        <text
          dominantBaseline="hanging"
          fill={CHART_TEXT_COLOR}
          fontFamily={CHART_FONT_FAMILY}
          fontSize={CHART_LABEL_FONT_SIZE}
          key={`category-${tick.value}-${tick.label}`}
          textAnchor="middle"
          x={tick.position}
          y={layout.plot.y + layout.plot.h + 6}
        >
          {tick.label}
        </text>
      ))}
    </g>
  );
}

function ChartMarks({ layout }: { layout: ChartRenderLayout }) {
  return (
    <g>
      {/* The 2px gap between adjacent bars is geometry, not a stroke: `layout.bars` already
          subtracted it, so a stroke here would eat into the bar's own width. */}
      {layout.bars.map((bar, index) => (
        <rect
          fill={bar.color}
          height={bar.h}
          key={`bar-${bar.seriesId}-${index}`}
          rx={Math.min(CHART_BAR_RADIUS, bar.w / 2, bar.h)}
          width={bar.w}
          x={bar.x}
          y={bar.y}
        />
      ))}
      {layout.lines.map((line) => (
        <g key={`line-${line.seriesId}`}>
          <path
            d={line.d}
            fill="none"
            stroke={line.color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={CHART_LINE_WIDTH}
          />
          {line.markers.map((marker, index) => (
            <circle
              cx={marker.x}
              cy={marker.y}
              fill={line.color}
              key={`marker-${line.seriesId}-${index}`}
              r={CHART_MARKER_RADIUS}
            />
          ))}
        </g>
      ))}
      {layout.slices.map((slice) => (
        <path
          d={slice.d}
          fill={slice.color}
          key={`slice-${slice.id}`}
          stroke={CHART_SURFACE_COLOR}
          strokeWidth={1}
        />
      ))}
      {layout.points.map((point, index) => (
        <circle
          cx={point.x}
          cy={point.y}
          fill={point.color}
          key={`point-${point.seriesId}-${index}`}
          r={CHART_MARKER_RADIUS}
        />
      ))}
    </g>
  );
}

/** Swatch plus label. The label is body ink, never the series colour — colour is the swatch's job. */
function ChartLegend({ layout }: { layout: ChartRenderLayout }) {
  if (layout.legend.length === 0) {
    return null;
  }
  return (
    <g>
      {layout.legend.map((entry) => (
        <g key={`legend-${entry.id}`}>
          <rect
            fill={entry.color}
            height={10}
            rx={2}
            width={10}
            x={entry.x}
            y={entry.y - 5}
          />
          <text
            dominantBaseline="middle"
            fill={CHART_TEXT_COLOR}
            fontFamily={CHART_FONT_FAMILY}
            fontSize={CHART_LABEL_FONT_SIZE}
            x={entry.x + 14}
            y={entry.y}
          >
            {entry.label}
          </text>
        </g>
      ))}
    </g>
  );
}
