import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * The chart authoring flow end to end: create one from a table, watch it follow an edit to that
 * table, change its type, and confirm it survives the table being deleted.
 *
 * The table is seeded into the overlay rather than built through the UI — this spec is about the
 * chart, and building a table by hand would make it fail for unrelated reasons.
 */

function cell(rowId: string, columnId: string, text: string) {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    content: [{
      type: "paragraph" as const,
      id: `${rowId}-${columnId}-p`,
      children: [{ type: "text" as const, text }],
    }],
  };
}

const CHART_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_chart_shape",
  metadata: { title: "表からグラフ" },
  content: [],
  pageLayout: {
    preset: "whiteboard",
    orientation: "portrait",
    pageSize: { widthMm: 210, heightMm: 297 },
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: "chart_source_table",
          type: "tableShape",
          x: 80,
          y: 80,
          rotation: 0,
          props: {
            w: 320,
            h: 120,
            table: {
              version: 1,
              kind: "plain",
              columns: [
                { id: "col_label", width: { mode: "auto" } },
                { id: "col_math", width: { mode: "auto" } },
              ],
              rows: [
                { id: "row_head", height: { mode: "auto" } },
                { id: "row_a", height: { mode: "auto" } },
                { id: "row_b", height: { mode: "auto" } },
              ],
              cells: [
                cell("row_head", "col_label", ""),
                cell("row_head", "col_math", "点数"),
                cell("row_a", "col_label", "A組"),
                cell("row_a", "col_math", "10"),
                cell("row_b", "col_label", "B組"),
                cell("row_b", "col_math", "50"),
              ],
              grid: { borderColor: "#111827", borderWidth: 1 },
              defaultCellStyle: {},
            },
          },
        }],
        assets: {},
      },
    },
  },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

/** Heights of the drawn bars, rounded — the visible proof that the chart read the table. */
async function barHeights(page: Page): Promise<number[]> {
  return page.locator('[data-testid="overlay-chart"] rect[rx]').evaluateAll((nodes) => (
    nodes.map((node) => Math.round(Number(node.getAttribute("height") ?? "0")))
  ));
}

/** The persisted chart, read the way the other overlay specs read saved state. */
async function savedChartKind(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }
    const shapes = (JSON.parse(raw) as {
      pageLayout?: { overlay?: { overlaySnapshot?: { shapes?: Array<Record<string, unknown>> } } };
    }).pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const chart = shapes.find((shape) => shape.type === "chartShape");
    return ((chart?.props as { spec?: { kind?: string } } | undefined)?.spec?.kind) ?? null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, CHART_DOCUMENT);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
});

test("creates a chart from a table, follows its edits, and survives losing it", async ({ page }) => {
  const table = page.locator('[data-overlay-shape-id="chart_source_table"]');
  await expect(table).toBeVisible();

  // 表を選んだだけの状態から作れること (表の右クリックメニューは編集中しか出ない)。
  await table.click();
  await table.click({ button: "right" });
  await page.getByRole("menuitem", { name: "グラフを作成" }).click();

  const chart = page.locator('[data-testid="overlay-chart"]');
  await expect(chart).toBeVisible();
  await expect.poll(() => barHeights(page)).toHaveLength(2);

  // 棒の高さは表の値どおり (10 と 50 なので 5 倍差)。
  const initial = await barHeights(page);
  expect(initial[1]).toBeGreaterThan(initial[0]);

  // セルを編集するとグラフが即時追従する。
  await table.dblclick();
  const editedCell = page.locator('[data-overlay-shape-id="chart_source_table"] td').nth(3);
  await editedCell.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("50");
  await page.keyboard.press("Escape");

  await expect.poll(async () => {
    const heights = await barHeights(page);
    return heights.length === 2 && heights[0] === heights[1];
  }).toBe(true);
});

test("changes the chart type from its settings panel", async ({ page }) => {
  const table = page.locator('[data-overlay-shape-id="chart_source_table"]');
  await table.click();
  await table.click({ button: "right" });
  await page.getByRole("menuitem", { name: "グラフを作成" }).click();

  const chart = page.locator('[data-testid="overlay-chart"]');
  await expect(chart).toBeVisible();
  await expect(page.locator('[data-testid="overlay-chart"] rect[rx]')).toHaveCount(2);

  // ダブルクリックで設定パネルが開く (グラフに編集モードは無い)。
  await chart.dblclick();
  const panel = page.getByRole("dialog", { name: "グラフ設定" });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("chart-settings-source")).toContainText("表と連動しています");

  await panel.getByRole("radio", { name: "折れ線グラフ" }).click();

  // 折れ線になったので棒は消え、線とマーカーが出る。
  await expect(page.locator('[data-testid="overlay-chart"] rect[rx]')).toHaveCount(0);
  await expect(page.locator('[data-testid="overlay-chart"] path')).toHaveCount(1);

  // 設定は永続化される (パネルを閉じても、開き直しても折れ線のまま)。
  await expect.poll(() => savedChartKind(page)).toBe("line");
});

test("changes the chart type from the keyboard", async ({ page }) => {
  const table = page.locator('[data-overlay-shape-id="chart_source_table"]');
  await table.click();
  await table.click({ button: "right" });
  await page.getByRole("menuitem", { name: "グラフを作成" }).click();

  const chart = page.locator('[data-testid="overlay-chart"]');
  await expect(chart).toBeVisible();
  await chart.dblclick();
  const panel = page.getByRole("dialog", { name: "グラフ設定" });
  await expect(panel).toBeVisible();

  // 種類は radiogroup なので、選択中の項目にフォーカスして矢印キーで隣へ移ると即座に切り替わる。
  const bar = panel.getByRole("radio", { name: "棒グラフ" });
  await bar.focus();
  await expect(bar).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");

  const line = panel.getByRole("radio", { name: "折れ線グラフ" });
  await expect(line).toHaveAttribute("aria-checked", "true");
  await expect(bar).toHaveAttribute("aria-checked", "false");

  // 描画も同じ操作で線に変わる。
  await expect(page.locator('[data-testid="overlay-chart"] rect[rx]')).toHaveCount(0);
  await expect(page.locator('[data-testid="overlay-chart"] path')).toHaveCount(1);
  await expect.poll(() => savedChartKind(page)).toBe("line");
});

test("keeps drawing from its snapshot after the table is deleted", async ({ page }) => {
  const table = page.locator('[data-overlay-shape-id="chart_source_table"]');
  await table.click();
  await table.click({ button: "right" });
  await page.getByRole("menuitem", { name: "グラフを作成" }).click();

  const chart = page.locator('[data-testid="overlay-chart"]');
  await expect(chart).toBeVisible();
  const before = await barHeights(page);

  await table.click();
  await page.keyboard.press("Delete");
  await expect(table).toHaveCount(0);

  // グラフは残り、最後に読み取ったデータで同じ絵を描き続ける。
  await expect(chart).toBeVisible();
  expect(await barHeights(page)).toEqual(before);

  // 参照切れであることが UI で分かる。
  await chart.dblclick();
  const panel = page.getByRole("dialog", { name: "グラフ設定" });
  await expect(panel.getByTestId("chart-settings-source")).toContainText("元の表が見つかりません");
});

test("undoes the chart creation", async ({ page }) => {
  const table = page.locator('[data-overlay-shape-id="chart_source_table"]');
  await table.click();
  await table.click({ button: "right" });
  await page.getByRole("menuitem", { name: "グラフを作成" }).click();
  await expect(page.locator('[data-testid="overlay-chart"]')).toBeVisible();

  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator('[data-testid="overlay-chart"]')).toHaveCount(0);
  await expect(table).toBeVisible();
});
