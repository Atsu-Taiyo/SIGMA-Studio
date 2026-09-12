import { describe, expect, it } from "vitest";

import { resolveChartSeriesColor, type SigmaChartData, type SigmaChartSpec } from "@/features/document";
import { getChartRenderLayout } from "@/features/drawing";

/**
 * Properties that must hold for ANY document-shaped input, checked over pseudo-random cases.
 *
 * The example-based tests next door pin the behaviour we designed; this pins the behaviour we did
 * not think of. It earned its place by catching a real one: grouped bars escaped their band and the
 * plot's right edge whenever a crowded group hit the old minimum-bar-width floor, which no
 * hand-written case had covered.
 *
 * The generator leans on the awkward values — gaps, zero, negatives, denormals, huge magnitudes,
 * empty labels, zero-sized boxes — because those are where geometry breaks.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const KINDS = ["bar", "line", "pie", "scatter"] as const;

function randomCase(r: () => number): { data: SigmaChartData; spec: SigmaChartSpec; w: number; h: number } {
  const labelCount = Math.floor(r() * 6);
  const seriesCount = Math.floor(r() * 5);
  const valueCount = Math.floor(r() * 8);
  const pick = () => {
    const t = r();
    if (t < 0.2) return null;
    if (t < 0.3) return 0;
    if (t < 0.5) return -Math.floor(r() * 1000);
    if (t < 0.7) return Math.floor(r() * 1e6);
    return (r() - 0.5) * 1e-6;
  };
  return {
    data: {
      labels: Array.from({ length: labelCount }, (_, i) => (r() < 0.2 ? "" : `L${i}`)),
      series: Array.from({ length: seriesCount }, (_, s) => ({
        id: `c${s}`,
        name: `S${s}`,
        values: Array.from({ length: valueCount }, pick),
      })),
      ...(r() < 0.5 ? { xValues: Array.from({ length: valueCount }, pick) } : {}),
    },
    spec: {
      version: 1,
      kind: KINDS[Math.floor(r() * KINDS.length)],
      orientation: r() < 0.5 ? "columns" : "rows",
      headerRow: r() < 0.5,
      labelColumn: r() < 0.5,
      legend: r() < 0.5,
      ...(r() < 0.3 ? { title: "T".repeat(Math.floor(r() * 80)) } : {}),
      seriesColors: {},
    },
    w: Math.floor(r() * 900),
    h: Math.floor(r() * 700),
  };
}

function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (typeof value === "string") {
    for (const m of value.matchAll(/-?\d+(?:\.\d+)?|NaN|Infinity/g)) {
      out.push(Number(m[0]));
    }
  } else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

describe("chart layout invariants", () => {
  it("never emits a non-finite number anywhere in the layout", () => {
    const r = rng(12345);
    const bad: unknown[] = [];
    for (let i = 0; i < 20000; i += 1) {
      const c = randomCase(r);
      const layout = getChartRenderLayout(c.data, c.spec, { w: c.w, h: c.h }, (id, idx) => resolveChartSeriesColor(c.spec, id, idx));
      if (numbersIn(layout).some((n) => !Number.isFinite(n))) bad.push({ case: c, layout });
      if (bad.length > 2) break;
    }
    expect(bad).toEqual([]);
  });

  it("keeps every bar standing on the baseline and inside the plot", () => {
    const r = rng(999);
    const bad: unknown[] = [];
    for (let i = 0; i < 20000; i += 1) {
      const c = randomCase(r);
      if (c.spec.kind !== "bar") continue;
      const layout = getChartRenderLayout(c.data, c.spec, { w: c.w, h: c.h }, (id, idx) => resolveChartSeriesColor(c.spec, id, idx));
      for (const bar of layout.bars) {
        const standsOnBaseline = Math.abs(bar.y + bar.h - layout.baselineY) < 0.01 || Math.abs(bar.y - layout.baselineY) < 0.01;
        const insideX = bar.x >= layout.plot.x - 0.01 && bar.x + bar.w <= layout.plot.x + layout.plot.w + 0.01;
        const insideY = bar.y >= layout.plot.y - 0.01 && bar.y + bar.h <= layout.plot.y + layout.plot.h + 0.01;
        if (!standsOnBaseline || !insideX || !insideY) { bad.push({ bar, plot: layout.plot, baselineY: layout.baselineY, case: c }); break; }
      }
      if (bad.length > 2) break;
    }
    expect(bad).toEqual([]);
  });

  it("sweeps exactly one turn whenever a pie has slices", () => {
    const r = rng(4242);
    const bad: unknown[] = [];
    for (let i = 0; i < 20000; i += 1) {
      const c = randomCase(r);
      if (c.spec.kind !== "pie") continue;
      const layout = getChartRenderLayout(c.data, c.spec, { w: c.w, h: c.h }, (id, idx) => resolveChartSeriesColor(c.spec, id, idx));
      if (layout.slices.length === 0) continue;
      const swept = layout.slices.reduce((s, sl) => s + (sl.endAngle - sl.startAngle), 0);
      if (Math.abs(swept - Math.PI * 2) > 1e-6) bad.push({ swept, slices: layout.slices.length, case: c });
      if (bad.length > 2) break;
    }
    expect(bad).toEqual([]);
  });

  it("keeps the value scale containing every plotted value", () => {
    const r = rng(777);
    const bad: unknown[] = [];
    for (let i = 0; i < 20000; i += 1) {
      const c = randomCase(r);
      if (c.spec.kind === "pie") continue;
      const layout = getChartRenderLayout(c.data, c.spec, { w: c.w, h: c.h }, (id, idx) => resolveChartSeriesColor(c.spec, id, idx));
      if (layout.empty || layout.valueTicks.length === 0) continue;
      const ys = layout.valueTicks.map((t) => t.position);
      const top = Math.min(...ys); const bottom = Math.max(...ys);
      for (const bar of layout.bars) {
        if (bar.y < top - 0.01 || bar.y + bar.h > bottom + 0.01) { bad.push({ bar, top, bottom, case: c }); break; }
      }
      if (bad.length > 2) break;
    }
    expect(bad).toEqual([]);
  });
});
