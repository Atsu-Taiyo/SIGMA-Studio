import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * Formula cells, end to end: the value is what the document shows, the source is what the cell
 * being edited shows, and a chart reading the table reads the values.
 *
 * The table is seeded into the overlay rather than built through the UI — building one by hand
 * would make this spec fail for reasons that have nothing to do with formulas.
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

const TABLE_SELECTOR = '[data-overlay-shape-id="formula_table"]';

const FORMULA_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_table_formula",
  metadata: { title: "セル数式" },
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
          id: "formula_table",
          type: "tableShape",
          x: 80,
          y: 80,
          rotation: 0,
          props: {
            w: 360,
            h: 200,
            table: {
              version: 1,
              kind: "plain",
              columns: [
                { id: "col_label", width: { mode: "auto" } },
                { id: "col_score", width: { mode: "auto" } },
              ],
              rows: [
                { id: "row_head", height: { mode: "auto" } },
                { id: "row_a", height: { mode: "auto" } },
                { id: "row_b", height: { mode: "auto" } },
                { id: "row_sum", height: { mode: "auto" } },
                { id: "row_err", height: { mode: "auto" } },
              ],
              cells: [
                cell("row_head", "col_label", "月"),
                cell("row_head", "col_score", "点数"),
                cell("row_a", "col_label", "1月"),
                cell("row_a", "col_score", "10"),
                cell("row_b", "col_label", "2月"),
                cell("row_b", "col_score", "20"),
                cell("row_sum", "col_label", "合計"),
                cell("row_sum", "col_score", "=SUM(B2:B3)"),
                cell("row_err", "col_label", "エラー"),
                cell("row_err", "col_score", "=1/0"),
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

/** The visible text of every cell in the seeded table, in DOM order. */
async function cellTexts(page: Page): Promise<string[]> {
  return page.locator(`${TABLE_SELECTOR} td`).evaluateAll((nodes) => (
    nodes.map((node) => (node.textContent ?? "").trim())
  ));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, FORMULA_DOCUMENT);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
});

test("shows the value, the source while editing that cell, and the value again after", async ({ page }) => {
  const table = page.locator(TABLE_SELECTOR);
  await expect(table).toBeVisible();

  // Idle canvas: the sum and the error value, never the source text.
  await expect.poll(() => cellTexts(page)).toEqual([
    "月", "点数", "1月", "10", "2月", "20", "合計", "30", "エラー", "#DIV/0!",
  ]);

  await table.dblclick();
  const formulaCell = page.locator(`${TABLE_SELECTOR} td`).nth(7);
  // The other formula keeps showing its value while a sibling is edited.
  await expect(page.locator(`${TABLE_SELECTOR} td`).nth(9)).toHaveText("#DIV/0!");

  await formulaCell.click();
  await expect(formulaCell).toHaveText("=SUM(B2:B3)");

  // Moving to another cell hands it back to the value.
  await page.locator(`${TABLE_SELECTOR} td`).nth(6).click();
  await expect(formulaCell).toHaveText("30");
});

test("recomputes when a cell the formula reads is edited", async ({ page }) => {
  const table = page.locator(TABLE_SELECTOR);
  await table.dblclick();

  const sourceCell = page.locator(`${TABLE_SELECTOR} td`).nth(5);
  await sourceCell.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("40");
  await page.keyboard.press("Escape");

  await expect(page.locator(`${TABLE_SELECTOR} td`).nth(7)).toHaveText("50");
});

test("lets the arrow keys walk into a formula cell instead of skipping it", async ({ page }) => {
  const table = page.locator(TABLE_SELECTOR);
  await table.dblclick();

  // Start in the cell above the formula and walk down into it. A formula cell showing its value has
  // no editor to find, so navigation used to step straight past it.
  const above = page.locator(`${TABLE_SELECTOR} td`).nth(5);
  await above.click();
  await page.keyboard.press("ArrowDown");

  const formulaCell = page.locator(`${TABLE_SELECTOR} td`).nth(7);
  await expect(formulaCell).toHaveText("=SUM(B2:B3)");
  await expect(formulaCell.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
});

test("keeps the value identical between the idle canvas and the interactive surface", async ({ page }) => {
  const table = page.locator(TABLE_SELECTOR);
  await expect(table).toBeVisible();
  const idle = await cellTexts(page);

  await table.dblclick();
  // The editor-only table element: `<table>` alone is what the static view renders too, so waiting
  // on that would compare the idle surface with itself.
  await expect(page.locator(`${TABLE_SELECTOR} .overlay-table-shape-table`)).toBeVisible();
  // Click a cell holding no formula, so every formula cell is still showing its value.
  await page.locator(`${TABLE_SELECTOR} td`).nth(0).click();

  expect(await cellTexts(page)).toEqual(idle);
});

test("draws a chart from the evaluated values", async ({ page }) => {
  const table = page.locator(TABLE_SELECTOR);
  await table.click();
  await table.click({ button: "right" });
  await page.getByRole("menuitem", { name: "グラフを作成" }).click();

  const chart = page.locator('[data-testid="overlay-chart"]');
  await expect(chart).toBeVisible();

  // 10, 20, 30 (the sum) and a gap for the error row: the tallest bar is the formula's value, so the
  // chart is reading what the cell evaluates to rather than the text `=SUM(B2:B3)`.
  const heights = await chart.locator("rect[rx]").evaluateAll((nodes) => (
    nodes.map((node) => Math.round(Number(node.getAttribute("height") ?? "0")))
  ));
  expect(heights).toHaveLength(3);
  expect(heights[2]).toBeGreaterThan(heights[1]);
  expect(heights[1]).toBeGreaterThan(heights[0]);
});

test("keeps a formula showing its value while a range is dragged out from it", async ({ page }) => {
  const table = page.locator(TABLE_SELECTOR);
  await table.dblclick();

  // Press on the sum and drag down onto the error row. Selecting a range is not editing the anchor
  // cell, so it must not flip to its source text under the pointer.
  const sumCell = page.locator(`${TABLE_SELECTOR} td`).nth(7);
  const errorCell = page.locator(`${TABLE_SELECTOR} td`).nth(9);
  const from = await sumCell.boundingBox();
  const to = await errorCell.boundingBox();
  if (!from || !to) {
    throw new Error("cells are not laid out");
  }

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(sumCell).toHaveText("30");
  await expect(errorCell).toHaveText("#DIV/0!");
});
