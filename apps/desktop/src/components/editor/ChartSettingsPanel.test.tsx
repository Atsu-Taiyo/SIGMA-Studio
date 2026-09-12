// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChartSettingsPanel } from "./ChartSettingsPanel";
import type { SelectedOverlayChart } from "./EditorSettings";
import type { SigmaChartSpec } from "@/features/document";

/**
 * The chart panel is the one place a user picks what shape their data takes, so the choice is a
 * visible set of shapes rather than a closed dropdown. These tests pin the semantics that makes
 * that operable — roles, names, and the value each choice reports.
 */

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

function chart(overrides: Partial<SigmaChartSpec> = {}): SelectedOverlayChart {
  return {
    shapeId: "chart_1",
    linked: true,
    spec: spec(overrides),
    data: {
      labels: ["1月", "2月"],
      series: [{ id: "s1", name: "点数", values: [10, 20] }],
    },
  } as SelectedOverlayChart;
}

let container: HTMLDivElement;
let root: Root;
let specs: SigmaChartSpec[];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(overrides: Partial<SigmaChartSpec> = {}) {
  act(() => {
    root.render(
      <ChartSettingsPanel
        chart={chart(overrides)}
        onClose={() => {}}
        onSpecChange={(_shapeId, next) => specs.push(next)}
      />,
    );
  });
}

function kindRadios(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chart-kind-picker"] [role="radio"]'));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  specs = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the chart kind is chosen from a visible set of shapes", () => {
  it("offers every chart kind as its own choice", () => {
    render();

    expect(kindRadios().map((radio) => radio.textContent)).toEqual([
      "棒グラフ",
      "折れ線グラフ",
      "円グラフ",
      "散布図",
    ]);
  });

  it("checks the kind the chart is currently drawn as", () => {
    render({ kind: "pie" });

    expect(kindRadios().map((radio) => radio.getAttribute("aria-checked")))
      .toEqual(["false", "false", "true", "false"]);
  });

  it("reports the chosen kind", () => {
    render();
    act(() => kindRadios()[1].click());

    expect(specs.map((next) => next.kind)).toEqual(["line"]);
  });

  it("keeps every other field of the spec when the kind changes", () => {
    // Whole-object equality, not `toMatchObject`: a handler that reset `seriesColors` or the
    // orientation flags on every kind change would satisfy a partial match and silently throw away
    // the author's per-series colours the first time they switched bar → line.
    const before = spec({
      legend: false,
      title: "点数の推移",
      orientation: "rows",
      headerRow: false,
      labelColumn: false,
      seriesColors: { s1: "#123456" },
    });
    render(before);
    act(() => kindRadios()[2].click());

    expect(specs[0]).toEqual({ ...before, kind: "pie" });
  });

  it("names the group from the caption the user can see", () => {
    render();
    const group = document.querySelector('[data-testid="chart-kind-picker"]');
    const labelId = group?.getAttribute("aria-labelledby");

    expect(labelId && document.getElementById(labelId)?.textContent).toBe("種類");
  });

  it("moves between kinds with the arrow keys", () => {
    render();
    const radios = kindRadios();
    act(() => radios[0].focus());
    act(() => {
      radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(specs.map((next) => next.kind)).toEqual(["line"]);
  });
});

describe("the chart panel follows the design rules it is measured by", () => {
  // `import.meta.url` is not a file URL under the happy-dom environment this file runs in.
  const source = readFileSync(path.resolve(import.meta.dirname, "./ChartSettingsPanel.tsx"), "utf8");

  it("does not fall back to a dropdown for the kind", () => {
    // Matched precisely: a bare `Select` substring also appears inside `SelectedOverlayChart`.
    expect(source).not.toMatch(/from "@\/components\/ui\/Select"/);
    expect(source).not.toMatch(/<Select[\s/>]/);
  });

  it("chooses the kind through the shared choice component", () => {
    expect(source).toContain("ChoiceGroup");
  });

  it("gives the title field the shared control styling instead of a bare input", () => {
    expect(source).toContain("chart-settings-text-input");
  });
});
