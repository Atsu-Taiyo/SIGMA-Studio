// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import type { Graph2DSpec } from "@/features/document";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import { ensurePageLayout } from "@/lib/page-layout";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { SigmaDocument } from "@/types/sigma-doc";
import { createTranslator } from "@/lib/i18n";

/**
 * 2D グラフ設定パネルの「統一レイアウト」。
 *
 * 以前は、関数の線 (色・線種・太さ) が hover の `⋯`、関数の種類と定義域が「詳細」の中、
 * 値域・目盛・軸が畳まれた「表示範囲」、軸名がさらに別の節、と4か所に分かれていた。
 * いまは関数カードと「座標軸と範囲」の節が同じ「ラベル | 操作」の行 (`GraphFieldRow`) で
 * 並ぶ。ここでは、その並び・名前付け・操作の結果・保存済み spec の往復を固定する。
 */

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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  document.body.innerHTML = "";
});

function quadraticSpec(): Graph2DSpec {
  const base = createGraph2DSpecPreset("line");
  return {
    ...base,
    curves: [{ ...base.curves[0], id: "curve_quadratic", expr: "x^2-2*x-1", exprTex: "x^2-2x-1" }],
  };
}

function selectedGraph(
  spec: Graph2DSpec,
  overrides: Partial<SelectedOverlayGraph> = {},
): SelectedOverlayGraph {
  return {
    shapeId: "graph_test",
    spec,
    axisLabelShapeIdsByKey: {},
    axisLabelTextsByKey: {},
    formulaLabelShapeIds: [],
    formulaLabelShapeIdsByCurveId: {},
    pickingOrigin: false,
    pickingFill: false,
    onSpecChange: vi.fn(),
    onAxisLabelChange: vi.fn(),
    onAxisLabelTextChange: vi.fn(),
    onFormulaLabelChange: vi.fn(),
    onStartCrop: () => {},
    onStartOriginPick: () => {},
    onStartFillPick: () => {},
    onClose: () => {},
    ...overrides,
  };
}

async function render(graph: SelectedOverlayGraph) {
  await act(async () => {
    root.render(<OverlayGraphSettings selectedOverlayGraph={graph} />);
  });
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function sectionHeaders(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-settings-accordion-header"));
}

function curveCard(): HTMLElement {
  const card = container.querySelector<HTMLElement>('[data-testid="overlay-graph-curve-card"]');
  expect(card).toBeTruthy();
  return card!;
}

/** `GraphFieldRow` の見出し (行の頭の語) を上から順に返す。 */
function rowLabels(scope: Element): string[] {
  return Array.from(scope.querySelectorAll<HTMLElement>("[data-graph-field-row]"))
    .map((row) => row.firstElementChild?.textContent?.trim() ?? "");
}

/** 行のグループ名。`aria-label` か、`aria-labelledby` が指す見出しの文字。 */
function accessibleRowName(row: HTMLElement): string {
  const labelledBy = row.getAttribute("aria-labelledby");
  if (labelledBy) {
    return document.getElementById(labelledBy)?.textContent?.trim() ?? "";
  }
  if (row.tagName === "DIV" && row.querySelector(":scope > label[for]")) {
    return row.querySelector(":scope > label[for]")?.textContent?.trim() ?? "";
  }
  return row.getAttribute("aria-label") ?? "";
}

function documentWithGraph(spec: unknown): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "doc_legacy_graph",
    metadata: { title: "旧グラフ" },
    content: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "二次関数" }] }],
    outputProfiles: { student: {}, teacher: { showSolutions: true, showHints: true }, answerBook: { includeAnswers: true, onlySolutions: true } },
    pageLayout: {
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [{ id: "graph_legacy", type: "graph2dShape", x: 40, y: 60, props: { w: 320, h: 240, spec } }],
          assets: {},
        },
      },
    },
  } as unknown as SigmaDocument);
}

function graphSpecOf(document: SigmaDocument): Graph2DSpec {
  const shapes = (document.pageLayout?.overlay?.overlaySnapshot as { shapes?: Array<{ type: string; props: { spec: Graph2DSpec } }> } | undefined)?.shapes ?? [];
  const graphShape = shapes.find((shape) => shape.type === "graph2dShape");
  expect(graphShape).toBeTruthy();
  return graphShape!.props.spec;
}

function lastSpec(graph: SelectedOverlayGraph): Graph2DSpec {
  const calls = vi.mocked(graph.onSpecChange).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)![0];
}

describe("unified 2D graph settings panel", () => {
  it("puts every setting of a function on its card, in one labelled row each", async () => {
    await render(selectedGraph(quadraticSpec()));

    // 関数の種類・線・定義域・ラベルが同じカードの行として常に見えている (畳まれていない)。
    expect(rowLabels(curveCard())).toEqual(["式", "種類", "線", "定義域", "ラベル"]);
    expect(curveCard().querySelector('[aria-expanded="false"]:not([aria-haspopup])')).toBeNull();
    expect(curveCard().querySelector('[data-testid="overlay-graph-mode-select"]')).toBeTruthy();
    expect(curveCard().querySelector('[data-testid="overlay-graph-dash-select"]')).toBeTruthy();
    expect(curveCard().querySelector('[data-testid="overlay-graph-color-select"]')).toBeTruthy();
    expect(curveCard().querySelector('[data-testid="overlay-graph-stroke-width-select"]')).toBeTruthy();
    expect(curveCard().querySelector('[data-testid="overlay-graph-domain-input-pair"]')).toBeTruthy();
    expect(curveCard().querySelector('[data-testid="overlay-graph-formula-label"]')).toBeTruthy();
    expect(curveCard().getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("keeps ranges, ticks, axes and axis names in one open section that uses the same rows", async () => {
    await render(selectedGraph(quadraticSpec()));

    const titles = sectionHeaders().map((header) => header.textContent?.trim());
    // 「表示範囲」と「軸名」は1つの節になった。関数の節の直後に来る。
    expect(titles).not.toContain("表示範囲");
    expect(titles).not.toContain("軸名");
    expect(titles.indexOf("座標軸と範囲")).toBe(titles.indexOf("関数1") + 1);

    const axesHeader = sectionHeaders().find((header) => header.textContent?.includes("座標軸と範囲"))!;
    expect(axesHeader.getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(axesHeader.getAttribute("aria-controls")!)!;

    expect(rowLabels(body)).toEqual([
      "x軸", "y軸", "描画範囲",
      "目盛の間隔", "目盛文字サイズ",
      "軸の表示", "軸の先端", "軸名",
    ]);
    for (const testId of [
      "overlay-graph-x-range-pair",
      "overlay-graph-y-range-pair",
      "overlay-graph-x-tick-step",
      "overlay-graph-tick-font-size",
      "overlay-graph-axis-label-x",
      "overlay-graph-axis-label-text-origin",
    ]) {
      expect(body.querySelector(`[data-testid="${testId}"]`), testId).toBeTruthy();
    }
    // 1つの節に、関数カードと同じ行の部品で並ぶ。
    const cardColumns = curveCard().querySelector<HTMLElement>("[data-graph-field-row]")!.className;
    const axesColumns = body.querySelector<HTMLElement>("[data-graph-field-row]")!.className;
    expect(axesColumns).toBe(cardColumns);
  });

  it("names every row for assistive tech, and keeps the control names that e2e and users rely on", async () => {
    await render(selectedGraph(quadraticSpec()));

    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-graph-field-row]"));
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const row of rows) {
      expect(accessibleRowName(row), row.outerHTML.slice(0, 120)).not.toBe("");
    }
    expect(rows.find((row) => row.getAttribute("aria-label") === "関数 1 の線スタイル")).toBeTruthy();
    expect(rows.find((row) => row.getAttribute("aria-label") === "x軸の表示範囲")).toBeTruthy();

    // 目盛文字サイズは行の頭の `<label for>` が入力の名前になる。
    const fontSize = container.querySelector<HTMLInputElement>('[data-testid="overlay-graph-tick-font-size"]')!;
    expect(container.querySelector(`label[for="${CSS.escape(fontSize.id)}"]`)?.textContent).toBe("目盛文字サイズ");

    const checkboxNames = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .map((input) => input.closest("label")?.textContent?.trim());
    expect(checkboxNames).toEqual(expect.arrayContaining([
      "グラフ上に式を表示", "軸範囲と同じ", "x軸", "y軸", "目盛", "グリッド",
    ]));
  });

  it("changes the line type and function type from the card and keeps the rest of the spec", async () => {
    const spec = quadraticSpec();
    const graph = selectedGraph(spec);
    await render(graph);

    await click(curveCard().querySelector('[data-testid="overlay-graph-dash-select"] button'));
    const dashed = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find((item) => (item.getAttribute("aria-label") ?? item.textContent)?.trim() === "破線");
    await click(dashed);
    expect(lastSpec(graph)).toEqual({
      ...spec,
      curves: [{ ...spec.curves[0], dash: "dashed" }],
    });

    await click(curveCard().querySelector('[data-testid="overlay-graph-mode-select"]'));
    await click(document.querySelector('.graph-mode-menu button[aria-label="x=f(y)"]'));
    const afterMode = lastSpec(graph);
    expect(afterMode.curves[0].mode).toBe("xOfY");
    // 種類を変えても、直前に変えた線種は落ちない。
    expect(afterMode.curves[0].dash).toBe("dashed");
    expect(afterMode.viewBox).toEqual(spec.viewBox);
  });

  it("toggles the on-graph formula label from the card's label row", async () => {
    const graph = selectedGraph(quadraticSpec());
    await render(graph);

    await click(container.querySelector('[data-testid="overlay-graph-formula-label"]'));
    expect(graph.onFormulaLabelChange).toHaveBeenCalledWith("curve_quadratic", true);

    await render({ ...graph, formulaLabelShapeIdsByCurveId: { curve_quadratic: "text_1" } });
    const checkbox = container.querySelector<HTMLInputElement>('[data-testid="overlay-graph-formula-label"]')!;
    expect(checkbox.checked).toBe(true);
    await click(checkbox);
    expect(graph.onFormulaLabelChange).toHaveBeenLastCalledWith("curve_quadratic", false);
  });

  it("shares the card for non-quadratic functions: parametric and implicit keep their own rows", async () => {
    const base = quadraticSpec();
    await render(selectedGraph({
      ...base,
      curves: [
        { ...base.curves[0], id: "curve_param", mode: "parametric", expr: "cos(t)", yExpr: "sin(t)" },
        { ...base.curves[0], id: "curve_implicit", mode: "implicit", expr: "x^2+y^2=1" },
        { ...base.curves[0], id: "curve_exp", expr: "exp(x)" },
      ],
    }));

    const cards = Array.from(container.querySelectorAll<HTMLElement>(".graph-curve-card"));
    expect(cards).toHaveLength(3);
    expect(rowLabels(cards[0])).toEqual(["式", "種類", "線", "tの範囲", "ラベル"]);
    expect(cards[0].querySelector('[data-testid="overlay-graph-y-expr-input"]')).toBeTruthy();
    expect(rowLabels(cards[1])).toEqual(["式", "種類", "線", "xの範囲", "ラベル"]);
    expect(rowLabels(cards[2])).toEqual(["式", "種類", "線", "定義域", "ラベル"]);
  });

  it("opens a document saved before the redesign and re-saves it with only the edited field changed", async () => {
    // 古い保存形式の例: 線種・太さ・向き・先端・目盛文字サイズが無く、描画範囲と定義域だけ持つ。
    // スキーマを通る保存済み SigmaDoc として読み、パネルで1か所だけ変え、保存して読み直す。
    const legacySpec = {
      kind: "cartesian",
      title: "",
      width: 320,
      height: 240,
      viewBox: { xMin: "-3", xMax: "5", yMin: "-3", yMax: "4" },
      graphViewBox: { xMin: "-1", xMax: "3", yMin: "-2", yMax: "3" },
      axes: { showX: true, showY: true, grid: false, showTicks: true, xTickStep: "1", yTickStep: "", xLabel: "x", yLabel: "y" },
      curves: [{ id: "curve_legacy", expr: "x^2-2*x-1", color: "#374151", domain: { min: "-1", max: "3" } }],
      points: [{ id: "point_vertex", x: "1", y: "-2", label: "P", color: "#0d0d0d", fill: "solid" }],
    };
    const savedJson = JSON.stringify(documentWithGraph(legacySpec));
    const loaded = graphSpecOf(parseSigmaDocument(JSON.parse(savedJson)));
    expect(loaded).toEqual(legacySpec);

    const graph = selectedGraph(loaded);
    await render(graph);

    // 既存の設定がそのまま読める。
    expect(container.querySelector('[data-testid="overlay-graph-domain-input-min"]')?.textContent).toContain("-1");
    expect(container.querySelector('[data-testid="overlay-graph-domain-input-max"]')?.textContent).toContain("3");
    expect(container.querySelector('[data-testid="overlay-graph-display-x-range-pair"]')).toBeTruthy();
    const sameAsAxis = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.closest("label")?.textContent?.includes("軸範囲と同じ"))!;
    expect(sameAsAxis.checked).toBe(false);
    expect(container.querySelector('[data-testid="overlay-graph-tick-font-size"]')).toHaveProperty("value", "9");

    const grid = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.closest("label")?.textContent?.trim() === "グリッド")!;
    await click(grid);

    // 保存して読み直した spec は、変えた1か所以外は元の保存内容と同じ (欠落も補完もしない)。
    const resaved = graphSpecOf(parseSigmaDocument(JSON.parse(JSON.stringify(documentWithGraph(lastSpec(graph))))));
    expect(resaved).toEqual({ ...legacySpec, axes: { ...legacySpec.axes, grid: true } });
  });

  it("does not rewrite the tick font size when the field is only tabbed through", async () => {
    // 「座標軸と範囲」は既定で開いているので、キーボードで通り過ぎるだけでも blur が起きる。
    for (const tickFontSize of [undefined, 4, 60]) {
      const base = quadraticSpec();
      const axes = { ...base.axes };
      if (tickFontSize === undefined) {
        delete axes.tickFontSize;
      } else {
        axes.tickFontSize = tickFontSize;
      }
      const graph = selectedGraph({ ...base, axes });
      await render(graph);
      const input = container.querySelector<HTMLInputElement>('[data-testid="overlay-graph-tick-font-size"]')!;
      await act(async () => {
        input.focus();
        input.blur();
      });
      expect(graph.onSpecChange, `tickFontSize=${tickFontSize}`).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      root = createRoot(container);
    }

    // 実際に値を変えたときは確定する。
    const graph = selectedGraph(quadraticSpec());
    await render(graph);
    const input = container.querySelector<HTMLInputElement>('[data-testid="overlay-graph-tick-font-size"]')!;
    await act(async () => {
      input.focus();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "10.5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.blur();
    });
    expect(lastSpec(graph).axes.tickFontSize).toBe(10.5);
  });

  it("keeps an open line picker open when the delete menu's hover closes", async () => {
    vi.useFakeTimers();
    try {
      await render(selectedGraph(quadraticSpec()));
      await click(curveCard().querySelector('[data-testid="overlay-graph-dash-select"] button'));
      const dashMenuOpen = () => Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        .some((item) => (item.getAttribute("aria-label") ?? item.textContent)?.trim() === "破線");
      expect(dashMenuOpen()).toBe(true);

      const trigger = container.querySelector<HTMLElement>('[data-testid="overlay-graph-curve-actions"]')!;
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
        vi.advanceTimersByTime(1000);
      });
      expect(dashMenuOpen()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an open curve picker open when a point or fill menu's hover closes", async () => {
    const base = quadraticSpec();
    for (const testId of ["overlay-graph-point-actions", "overlay-graph-fill-actions"]) {
      vi.useFakeTimers();
      try {
        await render(selectedGraph({
          ...base,
          points: [{ id: "point_1", x: "1", y: "-2", label: "P", color: "#0d0d0d", fill: "solid" }],
          fills: [{ id: "fill_1", x: "1", y: "1" }],
        }));
        await click(curveCard().querySelector('[data-testid="overlay-graph-dash-select"] button'));
        const dashMenuOpen = () => Array.from(document.querySelectorAll('[role="menuitemradio"]'))
          .some((item) => (item.getAttribute("aria-label") ?? item.textContent)?.trim() === "破線");
        expect(dashMenuOpen(), testId).toBe(true);

        const trigger = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
        });
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
          vi.advanceTimersByTime(1000);
        });
        expect(dashMenuOpen(), testId).toBe(true);
      } finally {
        vi.useRealTimers();
        await act(async () => root.unmount());
        document.body.querySelectorAll("[data-toolbar-popover]").forEach((node) => node.remove());
        root = createRoot(container);
      }
    }
  });

  it("still shows the out-of-range warning when the axes section is collapsed", async () => {
    const base = quadraticSpec();
    const graph = selectedGraph(base);
    await render(graph);
    const axesHeader = sectionHeaders().find((header) => header.textContent?.includes("座標軸と範囲"))!;
    await click(axesHeader);
    expect(axesHeader.getAttribute("aria-expanded")).toBe("false");
    const notice = axesHeader.parentElement!.querySelector<HTMLElement>(".editor-settings-accordion-notice")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("");

    // 畳んだあとで曲線が範囲の外に出る。
    await render({
      ...graph,
      spec: {
        ...base,
        viewBox: { xMin: "-1", xMax: "1", yMin: "-1", yMax: "1" },
        curves: [{ ...base.curves[0], expr: "x^2 + 5" }],
      },
    });
    expect(notice.textContent).toContain("曲線が表示範囲の外にあります");
    expect(notice.hasAttribute("data-empty")).toBe(false);

    // 開くと一括調整がその場にあり、見出しの下の通知は空に戻る。
    await click(axesHeader);
    expect(container.querySelector('[data-testid="overlay-graph-range-group"] [data-testid="overlay-graph-fit-view-box"]')).toBeTruthy();
    expect(notice.textContent).toBe("");
  });

  it("does not let a pending item-menu close dismiss a picker opened while it waited, or one of a similarly named item", async () => {
    const base = quadraticSpec();
    vi.useFakeTimers();
    try {
      await render(selectedGraph({
        ...base,
        points: [
          { id: "vertex", x: "1", y: "-2", label: "P", color: "#0d0d0d", fill: "solid" },
          { id: "right-vertex", x: "2", y: "-1", label: "Q", color: "#0d0d0d", fill: "solid" },
        ],
      }));
      const dashMenuOpen = () => Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        .some((item) => (item.getAttribute("aria-label") ?? item.textContent)?.trim() === "破線");
      const pointTrigger = (index: number) => container.querySelector<HTMLElement>(`[aria-label="点 ${index} の操作"]`)!;
      const pointPaletteOpen = (index: number) =>
        document.querySelector(`button[aria-label="点 ${index} の色"]`)?.classList.contains("active") === true;
      const hoverIn = async (trigger: HTMLElement) => {
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
        });
      };
      const hoverOut = async (trigger: HTMLElement) => {
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
        });
      };

      // 1) 点 1 の色を開いたまま `⋯` を離れ、閉じるのを待つ間に関数の線種メニューを開く。
      await hoverIn(pointTrigger(1));
      await click(document.querySelector('button[aria-label="点 1 の色"]'));
      expect(pointPaletteOpen(1)).toBe(true);
      await hoverOut(pointTrigger(1));
      // 実際のクリックと同じく pointerdown が先に来る (外側の pointerdown で点の色は閉じる)。
      const dashTrigger = curveCard().querySelector<HTMLElement>('[data-testid="overlay-graph-dash-select"] button')!;
      await act(async () => {
        dashTrigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      await click(dashTrigger);
      expect(dashMenuOpen()).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(dashMenuOpen()).toBe(true);
      await click(curveCard().querySelector('[data-testid="overlay-graph-dash-select"] button'));
      expect(dashMenuOpen()).toBe(false);

      // 2) id の末尾が同じ別の点 (`vertex` と `right-vertex`)。点 1 の `⋯` が閉じても点 2 の色は残る。
      await hoverIn(pointTrigger(2));
      await click(document.querySelector('button[aria-label="点 2 の色"]'));
      expect(pointPaletteOpen(2)).toBe(true);
      await hoverIn(pointTrigger(1));
      await hoverOut(pointTrigger(1));
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      // 点 2 の `⋯` も hover が外れて閉じるので、開閉状態そのもの (トリガーの active) を確かめる前に
      // 点 2 の `⋯` を開き直す。状態が残っていれば色の選択肢はそのまま開いて見える。
      await hoverIn(pointTrigger(2));
      expect(pointPaletteOpen(2)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revive an open picker after its section is collapsed and re-expanded", async () => {
    await render(selectedGraph(quadraticSpec()));
    const dashMenuOpen = () => Array.from(document.querySelectorAll('[role="menuitemradio"]'))
      .some((item) => (item.getAttribute("aria-label") ?? item.textContent)?.trim() === "破線");
    const curveHeader = () => sectionHeaders().find((header) => header.textContent?.startsWith("関数"))!;

    await click(curveCard().querySelector('[data-testid="overlay-graph-dash-select"] button'));
    expect(dashMenuOpen()).toBe(true);
    await click(curveHeader());
    await click(curveHeader());
    expect(curveCard()).toBeTruthy();
    expect(dashMenuOpen()).toBe(false);
  });

  it("lets Escape in the custom colour dialog cancel only that dialog and return focus to the palette", async () => {
    await render(selectedGraph(quadraticSpec()));
    await click(curveCard().querySelector('[data-testid="overlay-graph-color-select"]'));
    const palette = () => document.querySelector<HTMLElement>(".color-popover");
    expect(palette()).toBeTruthy();
    const addCustom = palette()!.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    await act(async () => {
      addCustom.focus();
      addCustom.click();
    });
    const dialog = palette()!.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    const target = dialog!.contains(document.activeElement) ? document.activeElement! : dialog!;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(palette()).toBeTruthy();
    expect(palette()!.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(palette()!.querySelector('button[aria-haspopup="dialog"]'));
  });

  it("opens exactly one picker for saved curve ids that would collide when joined with dashes", async () => {
    // `curve-mode-` + `algebra-dash` と `curve-` + `mode-algebra` + `-dash` は同じ文字列になる。
    const base = quadraticSpec();
    await render(selectedGraph({
      ...base,
      curves: [
        { ...base.curves[0], id: "algebra-dash" },
        { ...base.curves[0], id: "mode-algebra", expr: "x" },
      ],
    }));
    const cards = Array.from(container.querySelectorAll<HTMLElement>(".graph-curve-card"));
    await click(cards[0].querySelector('[aria-label^="関数の向き"]'));
    const expanded = Array.from(container.querySelectorAll('[aria-haspopup][aria-expanded="true"]'));
    expect(expanded).toHaveLength(1);
    expect(cards[0].contains(expanded[0])).toBe(true);
    expect(document.querySelectorAll("[data-toolbar-popover]")).toHaveLength(1);
  });

  it("closes an axis-end picker when its axis is hidden, so its disabled trigger cannot hold it open", async () => {
    await render(selectedGraph(quadraticSpec()));
    const xEnd = () => container.querySelector<HTMLButtonElement>('button[aria-label^="x軸の先端（現在: "]')!;
    await click(xEnd());
    expect(document.querySelector('[role="menu"][aria-label="x軸の先端"]')).toBeTruthy();
    const xAxis = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.closest("label")?.textContent?.trim() === "x軸")!;
    await click(xAxis);
    expect(document.querySelector('[role="menu"][aria-label="x軸の先端"]')).toBeNull();
  });

  it("puts the out-of-range warning and its fit action in the range group", async () => {
    const base = quadraticSpec();
    await render(selectedGraph({
      ...base,
      viewBox: { xMin: "-1", xMax: "1", yMin: "-1", yMax: "1" },
      curves: [{ ...base.curves[0], expr: "x^2 + 5" }],
      points: [{ id: "point_1", x: "0", y: "0", label: "P", color: "#0d0d0d", fill: "solid" }],
    }));

    const rangeGroup = container.querySelector('[data-testid="overlay-graph-range-group"]')!;
    expect(rangeGroup.querySelector('[data-testid="overlay-graph-range-warning"]')?.textContent).toContain("曲線が表示範囲の外にあります");
    expect(rangeGroup.querySelector('[data-testid="overlay-graph-fit-view-box"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="overlay-graph-fit-view-box"]')).toHaveLength(1);
  });

  it("has English labels for every new row and section", () => {
    const en = createTranslator("en", "shape");
    const ja = createTranslator("ja", "shape");
    for (const key of [
      "graph.axesAndRange", "graph.rangeGroup", "graph.ticksGroup", "graph.axesGroup", "graph.drawRange",
      "graph.fieldExpression", "graph.fieldType", "graph.fieldLine", "graph.fieldLabel", "graph.showFormulaOnGraph",
    ] as const) {
      expect(en(key)).not.toBe(key);
      expect(en(key)).not.toBe(ja(key));
    }
  });
});
