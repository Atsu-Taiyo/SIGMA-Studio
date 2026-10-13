// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import type { Graph2DSpec, GraphAxes } from "@/features/document";
import { createGraph2DSpecPreset } from "@/lib/graph2d";

/** `vitest.setup.ts` と同じキー。表示言語をここでも ja に固定するために持つ。 */
const UI_LOCALE_STORAGE_KEY = "sigma-studio:ui-locale";

vi.mock("mathlive", () => ({}));
vi.mock("@/features/rendering/adapters/react", () => ({
  InlineMathPreview: ({ tex, className }: { tex: string; className?: string }) => (
    <span className={`inline-math-node ${className ?? ""}`}>
      <span className="math-preview math-preview-inline">{tex}</span>
    </span>
  ),
  MathPreview: ({ tex, className }: { tex: string; className?: string }) => <span className={`math-preview ${className ?? ""}`}>{tex}</span>,
  useMathEnvironment: () => ({ macroSet: { mathLiveMacros: {} }, typesetStyle: "displaystyle" }),
}));

let OverlayGraphSettings: typeof import("@/components/editor/EditorSettings").OverlayGraphSettings;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map<string, string>([[UI_LOCALE_STORAGE_KEY, "ja"]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  OverlayGraphSettings = (await import("@/components/editor/EditorSettings")).OverlayGraphSettings;
});

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, "ja");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function selectedGraph(axes: Partial<GraphAxes>, onSpecChange = vi.fn()): SelectedOverlayGraph {
  const base = createGraph2DSpecPreset("line");
  return {
    shapeId: "graph_test",
    spec: { ...base, axes: { ...base.axes, ...axes } },
    axisLabelShapeIdsByKey: {},
    axisLabelTextsByKey: {},
    formulaLabelShapeIds: [],
    formulaLabelShapeIdsByCurveId: {},
    pickingOrigin: false,
    pickingFill: false,
    onSpecChange,
    onAxisLabelChange: () => {},
    onAxisLabelTextChange: () => {},
    onFormulaLabelChange: () => {},
    onStartCrop: () => {},
    onStartOriginPick: () => {},
    onStartFillPick: () => {},
    onClose: () => {},
  };
}

/** 軸の先端は「表示範囲」の中にある (既定で畳まれている)。 */
async function renderOpen(graph: SelectedOverlayGraph) {
  await act(async () => {
    root.render(<OverlayGraphSettings selectedOverlayGraph={graph} />);
  });
  const section = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-settings-accordion-header"))
    .find((button) => button.textContent?.includes("表示範囲"));
  await act(async () => {
    section?.click();
  });
}

const AXIS_NAME = { x: "x軸の先端", y: "y軸の先端" } as const;

function axisEndButton(axis: "x" | "y"): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label^="${AXIS_NAME[axis]}（現在: "]`);
}

function axisEndMenu(axis: "x" | "y"): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="menu"][aria-label="${AXIS_NAME[axis]}"]`);
}

async function pick(axis: "x" | "y", label: string) {
  await act(async () => {
    axisEndButton(axis)?.click();
  });
  await act(async () => {
    axisEndMenu(axis)?.querySelector<HTMLButtonElement>(`[role="menuitemradio"][aria-label="${label}"]`)?.click();
  });
}

describe("2D graph axis end pickers", () => {
  it("shows the default arrow on both axes for a graph that never chose an end", async () => {
    await renderOpen(selectedGraph({}));

    expect(axisEndButton("x")?.getAttribute("aria-label")).toBe("x軸の先端（現在: 矢印）");
    expect(axisEndButton("y")?.getAttribute("aria-label")).toBe("y軸の先端（現在: 矢印）");
  });

  it("writes the end chosen for the x axis to the x axis only, and closes the menu", async () => {
    const onSpecChange = vi.fn();
    await renderOpen(selectedGraph({}, onSpecChange));

    await act(async () => {
      axisEndButton("x")?.click();
    });
    const menu = axisEndMenu("x");
    expect(menu).not.toBeNull();
    // Every head a line can carry, plus なし: the axis end and the line end are one table.
    expect(menu?.querySelectorAll('[role="menuitemradio"]').length).toBe(15);
    expect(menu?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.getAttribute("aria-label")).toBe("矢印");

    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-label="ひし形（小）"]')?.click();
    });

    const lastSpec = onSpecChange.mock.calls.at(-1)?.[0] as Graph2DSpec | undefined;
    expect(lastSpec?.axes.xAxisEndStyle).toBe("diamondSmall");
    expect(lastSpec?.axes.yAxisEndStyle).toBeUndefined();
    // The rest of the axes stay as they were.
    expect(lastSpec?.axes.showX).toBe(true);
    expect(lastSpec?.axes.showY).toBe(true);
    expect(axisEndMenu("x")).toBeNull();
  });

  it("writes the end chosen for the y axis to the y axis only", async () => {
    const onSpecChange = vi.fn();
    await renderOpen(selectedGraph({ xAxisEndStyle: "bar" }, onSpecChange));

    await pick("y", "丸");

    const lastSpec = onSpecChange.mock.calls.at(-1)?.[0] as Graph2DSpec;
    expect(lastSpec.axes.yAxisEndStyle).toBe("dot");
    expect(lastSpec.axes.xAxisEndStyle).toBe("bar");
  });

  it("opens one axis's menu at a time", async () => {
    await renderOpen(selectedGraph({}));

    await act(async () => {
      axisEndButton("x")?.click();
    });
    await act(async () => {
      axisEndButton("y")?.click();
    });

    expect(axisEndMenu("x")).toBeNull();
    expect(axisEndMenu("y")).not.toBeNull();
  });

  it("can take the end off one axis", async () => {
    const onSpecChange = vi.fn();
    await renderOpen(selectedGraph({ xAxisEndStyle: "triangle" }, onSpecChange));
    expect(axisEndButton("x")?.getAttribute("aria-label")).toBe("x軸の先端（現在: 三角）");

    await pick("x", "なし");

    expect((onSpecChange.mock.calls.at(-1)?.[0] as Graph2DSpec).axes.xAxisEndStyle).toBe("none");
  });

  it("makes each picker unavailable while its axis is not drawn", async () => {
    await renderOpen(selectedGraph({ showX: false, showY: true }));
    expect(axisEndButton("x")?.disabled).toBe(true);
    expect(axisEndButton("y")?.disabled).toBe(false);
  });

  it("has no y axis end to choose on a number line", async () => {
    const base = createGraph2DSpecPreset("numberLine");
    await renderOpen({ ...selectedGraph({}), spec: base });
    expect(axisEndButton("x")?.disabled).toBe(false);
    expect(axisEndButton("y")?.disabled).toBe(true);
  });
});
