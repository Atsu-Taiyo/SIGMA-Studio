import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

function cell(rowId: string, columnId: string, text: string) {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    content: [{
      type: "paragraph" as const,
      id: `${rowId}-${columnId}-p`,
      align: "center" as const,
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


test("cell alignment survives editing, blur and reopening the saved document", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, FORMULA_DOCUMENT);
  await page.goto("/");
  const table = page.locator(TABLE_SELECTOR);
  await expect(table).toBeVisible();
  await table.dblclick();
  const target = table.locator("td").first();
  await target.click();
  for (const [label, align] of [["左揃え", "left"], ["右揃え", "right"]]) {
    await page.locator(".overlay-table-floating-toolbar").getByRole("button", { name: /文字の配置/ }).click();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await expect(target.locator("p")).toHaveCSS("text-align", align);
  }
  await target.click();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await page.keyboard.press("Escape");
  await expect(target.locator("p")).toHaveCSS("text-align", "right");
  await expect.poll(async () => page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    return doc?.pageLayout?.overlay?.overlaySnapshot?.shapes?.[0]?.props.table.cells[0].content[0];
  })).toMatchObject({ align: "right", children: [{ type: "text", text: "月X" }] });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!));
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(page.locator(TABLE_SELECTOR).locator("td").first().locator("p")).toHaveCSS("text-align", "right");
});
