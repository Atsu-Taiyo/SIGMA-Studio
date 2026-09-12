import { describe, expect, it } from "vitest";

import {
  resolveChartSeriesColor,
  type SigmaChartData,
  type SigmaChartSpec,
} from "@/features/document";

import {
  estimateChartLabelWidth,
  getChartColorTargets,
  formatChartTickLabel,
  getChartRenderLayout,
  getChartScale,
  niceChartStep,
} from "./chart-layout";

/** The resolver every production surface passes; the layout itself holds no palette. */
function colorFor(chart: SigmaChartSpec) {
  return (seriesId: string, index: number) => resolveChartSeriesColor(chart, seriesId, index);
}

function spec(overrides: Partial<SigmaChartSpec> = {}): SigmaChartSpec {
  return {
    version: 1,
    kind: "bar",
    orientation: "columns",
    headerRow: true,
    labelColumn: true,
    legend: true,
    seriesColors: {},
    ...overrides,
  };
}

function data(overrides: Partial<SigmaChartData> = {}): SigmaChartData {
  return {
    labels: ["a", "b", "c"],
    series: [{ id: "c2", name: "Math", values: [10, 50, 97] }],
    ...overrides,
  };
}

const SIZE = { w: 400, h: 260 };

describe("niceChartStep", () => {
  it("rounds a raw step up to a readable one", () => {
    expect(niceChartStep(24.25)).toBe(25);
  });

  it("keeps an already-round step", () => {
    expect(niceChartStep(10)).toBe(10);
  });

  it("handles sub-unit steps", () => {
    expect(niceChartStep(0.021)).toBe(0.025);
  });

  it("falls back for a non-positive step", () => {
    expect(niceChartStep(0)).toBe(1);
  });
});

describe("getChartScale", () => {
  it("gives 0..97 the readable ticks 0/25/50/75/100", () => {
    expect(getChartScale(0, 97).values).toEqual([0, 25, 50, 75, 100]);
  });

  it("does not collapse when every value is the same", () => {
    expect(getChartScale(5, 5).values.length).toBeGreaterThan(1);
  });

  it("does not collapse when every value is zero", () => {
    const scale = getChartScale(0, 0);

    expect(scale.max).toBeGreaterThan(scale.min);
  });

  it("spans zero when the data is negative", () => {
    const scale = getChartScale(-40, 60);

    expect(scale.min).toBeLessThanOrEqual(0);
    expect(scale.max).toBeGreaterThanOrEqual(0);
  });

  it("keeps tick values free of floating point drift", () => {
    expect(getChartScale(0, 1).values).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe("formatChartTickLabel", () => {
  it("writes an integer without a decimal point", () => {
    expect(formatChartTickLabel(50)).toBe("50");
  });

  it("keeps a fractional tick readable", () => {
    expect(formatChartTickLabel(0.25)).toBe("0.25");
  });
});

describe("getChartRenderLayout: bar", () => {
  it("stands every bar on the baseline", () => {
    const layout = getChartRenderLayout(data(), spec(), SIZE, colorFor(spec()));

    expect(layout.bars.every((bar) => Math.abs(bar.y + bar.h - layout.baselineY) < 0.001)).toBe(true);
  });

  it("draws one bar per value", () => {
    expect(getChartRenderLayout(data(), spec(), SIZE, colorFor(spec())).bars).toHaveLength(3);
  });

  it("skips a gap instead of drawing a zero-height bar for it", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [10, null, 97] }] }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.bars).toHaveLength(2);
  });

  it("puts the baseline at zero when the data goes negative", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [-40, 20, 60] }] }),
      spec(),
      SIZE,
      colorFor(spec()));
    const zeroTick = layout.valueTicks.find((tick) => tick.value === 0);

    expect(zeroTick?.position).toBeCloseTo(layout.baselineY, 6);
  });

  it("hangs a negative bar below the baseline", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [-40, 20, 60] }] }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.bars[0].y).toBeCloseTo(layout.baselineY, 6);
  });

  it("leaves a paper gap between two adjacent bars of a group", () => {
    const layout = getChartRenderLayout(
      data({
        series: [
          { id: "c2", name: "Math", values: [10, 50, 97] },
          { id: "c3", name: "Science", values: [20, 40, 60] },
        ],
      }),
      spec(),
      SIZE,
      colorFor(spec()));
    const first = layout.bars.find((bar) => bar.seriesId === "c2");
    const second = layout.bars.find((bar) => bar.seriesId === "c3");

    expect((second?.x ?? 0) - ((first?.x ?? 0) + (first?.w ?? 0))).toBeCloseTo(2, 6);
  });

  it("keeps an all-zero series on a scale that has not collapsed", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [0, 0, 0] }] }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.plot.h).toBeGreaterThan(0);
    expect(layout.valueTicks.length).toBeGreaterThan(1);
  });

  it("keeps every bar inside the plot rectangle", () => {
    const layout = getChartRenderLayout(data(), spec(), SIZE, colorFor(spec()));

    expect(layout.bars.every((bar) => (
      bar.x >= layout.plot.x - 0.001 &&
      bar.x + bar.w <= layout.plot.x + layout.plot.w + 0.001 &&
      bar.y >= layout.plot.y - 0.001
    ))).toBe(true);
  });
});

describe("getChartRenderLayout: legend", () => {
  it("omits the legend for a single series", () => {
    expect(getChartRenderLayout(data(), spec(), SIZE, colorFor(spec())).legend).toEqual([]);
  });

  it("shows one entry per series once there are two", () => {
    const layout = getChartRenderLayout(
      data({
        series: [
          { id: "c2", name: "Math", values: [10, 50, 97] },
          { id: "c3", name: "Science", values: [20, 40, 60] },
        ],
      }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.legend.map((entry) => entry.label)).toEqual(["Math", "Science"]);
  });

  it("omits the legend when the author turned it off", () => {
    const layout = getChartRenderLayout(
      data({
        series: [
          { id: "c2", name: "Math", values: [10, 50, 97] },
          { id: "c3", name: "Science", values: [20, 40, 60] },
        ],
      }),
      spec({ legend: false }),
      SIZE,
      colorFor(spec({ legend: false })));

    expect(layout.legend).toEqual([]);
  });
});

describe("getChartRenderLayout: line", () => {
  it("draws one path per series", () => {
    const layout = getChartRenderLayout(data(), spec({ kind: "line" }), SIZE, colorFor(spec({ kind: "line" })));

    expect(layout.lines).toHaveLength(1);
  });

  it("breaks the stroke at a gap rather than bridging it", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [10, null, 97] }] }),
      spec({ kind: "line" }),
      SIZE,
      colorFor(spec({ kind: "line" })));

    expect(layout.lines[0].d.match(/M/g)).toHaveLength(2);
  });

  it("draws no line for a series that holds no value", () => {
    const layout = getChartRenderLayout(
      data({
        series: [
          { id: "c2", name: "Math", values: [10, 50, 97] },
          { id: "c3", name: "Empty", values: [null, null, null] },
        ],
      }),
      spec({ kind: "line" }),
      SIZE,
      colorFor(spec({ kind: "line" })));

    expect(layout.lines.map((line) => line.seriesId)).toEqual(["c2"]);
  });

  it("puts a marker on every recorded point", () => {
    const layout = getChartRenderLayout(data(), spec({ kind: "line" }), SIZE, colorFor(spec({ kind: "line" })));

    expect(layout.lines[0].markers).toHaveLength(3);
  });
});

describe("getChartRenderLayout: pie", () => {
  it("sweeps a full turn across all slices", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [1, 2, 3] }] }),
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })));
    const swept = layout.slices.reduce((sum, slice) => sum + (slice.endAngle - slice.startAngle), 0);

    expect(swept).toBeCloseTo(Math.PI * 2, 9);
  });

  it("sizes each slice by its share", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [1, 1, 2] }] }),
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })));

    expect(layout.slices[2].endAngle - layout.slices[2].startAngle).toBeCloseTo(Math.PI, 9);
  });

  it("draws nothing when the slices total zero", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [0, 0, 0] }] }),
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })));

    expect(layout.slices).toEqual([]);
    expect(layout.empty).toBe(true);
  });

  it("draws a whole-circle slice as a closed path rather than a degenerate arc", () => {
    const layout = getChartRenderLayout(
      { labels: ["only"], series: [{ id: "c2", name: "Math", values: [5] }] },
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })));

    expect(layout.slices[0].d.match(/A/g)).toHaveLength(2);
  });

  it("gives the legend one entry per slice", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [1, 2, 3] }] }),
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })));

    expect(layout.legend.map((entry) => entry.label)).toEqual(["a", "b", "c"]);
  });

  it("has no value axis", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [1, 2, 3] }] }),
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })));

    expect(layout.valueTicks).toEqual([]);
  });
});

describe("getChartRenderLayout: scatter", () => {
  it("places a point per x/y pair", () => {
    const layout = getChartRenderLayout(
      { labels: ["1", "2", "3"], series: [{ id: "c3", name: "y", values: [10, 20, 30] }], xValues: [1, 2, 3] },
      spec({ kind: "scatter" }),
      SIZE,
      colorFor(spec({ kind: "scatter" })));

    expect(layout.points).toHaveLength(3);
  });

  it("spreads the points along x in the order of their coordinates", () => {
    const layout = getChartRenderLayout(
      { labels: ["1", "2", "3"], series: [{ id: "c3", name: "y", values: [10, 20, 30] }], xValues: [1, 2, 3] },
      spec({ kind: "scatter" }),
      SIZE,
      colorFor(spec({ kind: "scatter" })));

    expect(layout.points[0].x).toBeLessThan(layout.points[2].x);
  });

  it("skips a pair whose x is missing", () => {
    const layout = getChartRenderLayout(
      { labels: ["1", "2"], series: [{ id: "c3", name: "y", values: [10, 20] }], xValues: [1, null] },
      spec({ kind: "scatter" }),
      SIZE,
      colorFor(spec({ kind: "scatter" })));

    expect(layout.points).toHaveLength(1);
  });

  it("spends its only series on x when the labels are prose, leaving nothing to plot", () => {
    // Matches what `deriveChartData` does for the same input: with no numeric labels the first
    // series becomes the x axis, so a lone series leaves no y. The layout used to invent a
    // different answer (label indices), which made live and snapshot data draw different charts.
    const chart = spec({ kind: "scatter" });
    const layout = getChartRenderLayout(
      { labels: ["a", "b"], series: [{ id: "c3", name: "y", values: [10, 20] }] },
      chart,
      SIZE,
      colorFor(chart));

    expect({ points: layout.points.length, empty: layout.empty }).toEqual({ points: 0, empty: true });
  });
});

describe("getChartRenderLayout: nothing to draw", () => {
  it("reports empty when there are no series", () => {
    expect(getChartRenderLayout({ labels: ["a"], series: [] }, spec(), SIZE, colorFor(spec())).empty).toBe(true);
  });

  it("reports empty when there are no labels", () => {
    expect(getChartRenderLayout({ labels: [], series: [] }, spec(), SIZE, colorFor(spec())).empty).toBe(true);
  });

  it("reports empty when every series is a gap", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [null, null, null] }] }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.empty).toBe(true);
  });

  it("still returns a usable box when empty", () => {
    const layout = getChartRenderLayout({ labels: [], series: [] }, spec(), SIZE, colorFor(spec()));

    expect(layout.plot.w).toBeGreaterThan(0);
    expect(layout.plot.h).toBeGreaterThan(0);
  });
});

describe("getChartRenderLayout: robustness", () => {
  it("tolerates a series with fewer values than labels", () => {
    // The model deliberately does not force these lengths to match for hand-written documents.
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [10] }] }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.bars).toHaveLength(1);
  });

  it("tolerates a series with more values than labels", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [10, 20, 30, 40, 50] }] }),
      spec(),
      SIZE,
      colorFor(spec()));

    expect(layout.bars).toHaveLength(3);
  });

  it("survives a degenerate box", () => {
    const layout = getChartRenderLayout(data(), spec(), { w: 0, h: 0 }, colorFor(spec()));

    expect(layout.plot.w).toBeGreaterThan(0);
    expect(layout.plot.h).toBeGreaterThan(0);
  });

  it("reserves room for the title when there is one", () => {
    const withTitle = getChartRenderLayout(data(), spec({ title: "Scores" }), SIZE, colorFor(spec({ title: "Scores" })));
    const without = getChartRenderLayout(data(), spec(), SIZE, colorFor(spec()));

    expect(withTitle.plot.y).toBeGreaterThan(without.plot.y);
  });

  it("ignores a title that is only whitespace", () => {
    expect(getChartRenderLayout(data(), spec({ title: "   " }), SIZE, colorFor(spec({ title: "   " }))).title).toBeNull();
  });
});

describe("getChartRenderLayout: findings from review", () => {
  it("survives a value range that overflows to Infinity", () => {
    // 1e308 and -1e308 both pass the model's finite check, but their span does not.
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [1e308, -1e308, 0] }] }),
      spec(),
      SIZE,
      colorFor(spec()),
    );

    expect(layout.valueTicks.length).toBeGreaterThan(1);
    expect(layout.valueTicks.length).toBeLessThan(100);
  });

  it("bounds the tick count for an enormous but finite range", () => {
    expect(getChartScale(-1e308, 1e308).values.length).toBeLessThan(100);
  });

  it("keeps a crowded group of bars inside the plot", () => {
    const series = Array.from({ length: 30 }, (_, index) => ({
      id: `c${index}`,
      name: `S${index}`,
      values: [10, 20, 30],
    }));
    const layout = getChartRenderLayout(data({ series }), spec(), { w: 200, h: 200 }, colorFor(spec()));

    expect(layout.bars.every((bar) => (
      bar.x >= layout.plot.x - 0.01 && bar.x + bar.w <= layout.plot.x + layout.plot.w + 0.01
    ))).toBe(true);
  });

  it("keeps two adjacent bar groups from overlapping", () => {
    const series = Array.from({ length: 12 }, (_, index) => ({
      id: `c${index}`,
      name: `S${index}`,
      values: [10, 20, 30],
    }));
    const layout = getChartRenderLayout(data({ series }), spec(), { w: 300, h: 200 }, colorFor(spec()));
    const firstGroupRight = Math.max(...layout.bars.slice(0, 12).map((bar) => bar.x + bar.w));
    const secondGroupLeft = Math.min(...layout.bars.slice(12, 24).map((bar) => bar.x));

    expect(firstGroupRight).toBeLessThanOrEqual(secondGroupLeft + 0.01);
  });

  it("measures a full-width label as wider than the same count of Latin glyphs", () => {
    expect(estimateChartLabelWidth("シリーズ0")).toBeGreaterThan(estimateChartLabelWidth("Series"));
  });

  it("wraps a legend of full-width labels instead of running off the edge", () => {
    const series = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      name: `シリーズ${index}`,
      values: [10, 20, 30],
    }));
    const layout = getChartRenderLayout(data({ series }), spec(), { w: 300, h: 260 }, colorFor(spec()));
    const rows = new Set(layout.legend.map((entry) => entry.y));

    expect(rows.size).toBeGreaterThan(1);
  });

  it("draws no legend for a pie whose slices total zero", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [0, 0, 0] }] }),
      spec({ kind: "pie" }),
      SIZE,
      colorFor(spec({ kind: "pie" })),
    );

    expect(layout.legend).toEqual([]);
  });

  it("draws no axis for an empty chart", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [null, null, null] }] }),
      spec(),
      SIZE,
      colorFor(spec()),
    );

    expect(layout.valueTicks).toEqual([]);
  });

  it("draws no ghost axis for a scatter that resolved to no points", () => {
    const chart = spec({ kind: "scatter" });
    const layout = getChartRenderLayout(
      { labels: ["a", "b"], series: [{ id: "c3", name: "y", values: [10, 20] }], xValues: [null, null] },
      chart,
      SIZE,
      colorFor(chart),
    );

    expect({ points: layout.points.length, ticks: layout.valueTicks.length, empty: layout.empty })
      .toEqual({ points: 0, ticks: 0, empty: true });
  });

  it("keeps a pie slice's colour with its label when an earlier slice disappears", () => {
    const chart = spec({ kind: "pie", seriesColors: { "c2:z": "#abcdef" } });
    const full = getChartRenderLayout(
      { labels: ["w", "x", "z"], series: [{ id: "c2", name: "M", values: [1, 1, 1] }] },
      chart,
      SIZE,
      colorFor(chart),
    );
    // Blanking `w` drops it and shifts every later index by one.
    const shifted = getChartRenderLayout(
      { labels: ["w", "x", "z"], series: [{ id: "c2", name: "M", values: [null, 1, 1] }] },
      chart,
      SIZE,
      colorFor(chart),
    );
    const colorOfZ = (layout: { slices: { label: string; color: string }[] }) => (
      layout.slices.find((slice) => slice.label === "z")?.color
    );

    expect(colorOfZ(shifted)).toBe(colorOfZ(full));
  });

  it("ignores a non-finite value when building the scale", () => {
    const layout = getChartRenderLayout(
      data({ series: [{ id: "c2", name: "Math", values: [10, Number.NaN as unknown as number, 30] }] }),
      spec(),
      SIZE,
      colorFor(spec()),
    );

    expect(layout.bars.every((bar) => (
      bar.y >= layout.plot.y - 0.01 && bar.y + bar.h <= layout.plot.y + layout.plot.h + 0.01
    ))).toBe(true);
  });
});

describe("getChartColorTargets", () => {
  it("lists the drawable series for a bar chart", () => {
    const chart = spec();
    const targets = getChartColorTargets(
      data({
        series: [
          { id: "c2", name: "Math", values: [null, null, null] },
          { id: "c3", name: "Science", values: [1, 2, 3] },
        ],
      }),
      chart,
    );

    // The all-gap series is not drawn, so it is not colourable — and the palette index the panel
    // shows must be the one the chart actually uses.
    expect(targets).toEqual([{ key: "c3", name: "Science", index: 0 }]);
  });

  it("keys pie slices by the position the renderer draws them at", () => {
    const chart = spec({ kind: "pie" });
    const targets = getChartColorTargets(
      { labels: ["w", "x", "z"], series: [{ id: "c2", name: "M", values: [10, null, 20] }] },
      chart,
    );

    // `x` is dropped, so `z` is slice 1 — not slice 2 as its label position would suggest.
    expect(targets).toEqual([
      { key: "c2:w", name: "w", index: 0 },
      { key: "c2:z", name: "z", index: 1 },
    ]);
  });

  it("agrees with the keys the pie renderer emits", () => {
    const chart = spec({ kind: "pie" });
    const chartData = { labels: ["w", "x", "z"], series: [{ id: "c2", name: "M", values: [10, null, 20] }] };
    const layout = getChartRenderLayout(chartData, chart, SIZE, colorFor(chart));

    expect(layout.slices.map((slice) => slice.id))
      .toEqual(getChartColorTargets(chartData, chart).map((target) => target.key));
  });
});

describe("getChartRenderLayout: scatter from an unreduced snapshot", () => {
  it("takes x from numeric labels when the data carries no xValues", () => {
    const chart = spec({ kind: "scatter" });
    const layout = getChartRenderLayout(
      { labels: ["1", "2"], series: [{ id: "c3", name: "y", values: [10, 20] }] },
      chart,
      SIZE,
      colorFor(chart),
    );

    expect(layout.points).toHaveLength(2);
    expect(layout.points[0].x).toBeLessThan(layout.points[1].x);
  });

  it("spends the first series on x when the labels are prose", () => {
    const chart = spec({ kind: "scatter" });
    const layout = getChartRenderLayout(
      {
        labels: ["a", "b"],
        series: [
          { id: "cx", name: "x", values: [1, 2] },
          { id: "cy", name: "y", values: [10, 20] },
        ],
      },
      chart,
      SIZE,
      colorFor(chart),
    );

    expect(layout.points.map((point) => point.seriesId)).toEqual(["cy", "cy"]);
  });

  it("matches the reduced form the live path produces", () => {
    const chart = spec({ kind: "scatter" });
    const reduced = getChartRenderLayout(
      { labels: ["a", "b"], series: [{ id: "cy", name: "y", values: [10, 20] }], xValues: [1, 2] },
      chart,
      SIZE,
      colorFor(chart),
    );
    const unreduced = getChartRenderLayout(
      {
        labels: ["a", "b"],
        series: [
          { id: "cx", name: "x", values: [1, 2] },
          { id: "cy", name: "y", values: [10, 20] },
        ],
      },
      chart,
      SIZE,
      colorFor(chart),
    );

    expect(unreduced.points.map((p) => ({ x: p.x, y: p.y })))
      .toEqual(reduced.points.map((p) => ({ x: p.x, y: p.y })));
  });
});
