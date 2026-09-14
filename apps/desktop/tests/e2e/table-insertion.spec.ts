import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { createPlainTableSpec } from "@/components/editor/overlay-canvas/shapes/table";
import { grabShapeFromBody } from "./body-overlay-entry";

async function armTable(page: Page) {
  await page.getByRole("button", { name: "表", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "表を挿入" })).toHaveCount(0);
  const canvas = page.locator(".overlay-canvas-editor").first();
  await expect(canvas).toHaveAttribute("data-overlay-insert-command", "table");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas is missing");
  return { x: bounds.x + 80, y: bounds.y + 180 };
}

test.beforeEach(async ({ page }, testInfo) => {
  const document = structuredClone(sampleDocument);
  if (testInfo.title.includes("later paragraph")) {
    const table = createPlainTableSpec(2, 2);
    table.cells[3].content = [
      { type: "paragraph", id: "paragraph_first", children: [{ type: "text", text: "First" }] },
      { type: "paragraph", id: "paragraph_second", children: [{ type: "text", text: "Second" }] },
    ];
    document.pageLayout = { ...document.pageLayout!, overlay: { overlaySnapshot: {
      version: 1, assets: {}, shapes: [{ id: "table_multi", type: "tableShape", x: 100, y: 220,
        rotation: 0, props: { w: 320, h: 200, table } }],
    } } };
  }
  await installDesktopRuntimeMock(page, document);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-startup-splash]")).toHaveCount(0);
});

test("2 by 2 preview follows the pointer and a click places it with first-cell focus", async ({ page }) => {
  const start = await armTable(page);
  await page.mouse.move(start.x, start.y);
  const preview = page.locator("[data-table-placement-preview] .overlay-insert-preview-shape");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-table-preview-rows", "2");
  await expect(preview).toHaveAttribute("data-table-preview-columns", "2");
  await expect(preview.locator("svg")).toHaveCSS("stroke-dasharray", "3px, 3px");
  await expect(preview.locator(".table-placement-hint")).toHaveText("ドラッグで行・列を増やす");
  await expect(preview.locator("td, [contenteditable]")).toHaveCount(0);
  const gridPath = await preview.locator("path").elementHandle();
  const first = await preview.boundingBox();
  await page.mouse.move(start.x + 60, start.y + 40);
  await expect.poll(async () => (await preview.boundingBox())?.x).toBeCloseTo(first!.x + 60, 0);
  expect(await gridPath!.evaluate((node) => node.isConnected)).toBe(true);
  const last = await preview.boundingBox();
  expect(last!.y).toBeCloseTo(first!.y + 40, 0);
  await page.mouse.click(start.x + 60, start.y + 40);
  await expect(preview).toHaveCount(0);
  const table = page.locator(".overlay-table-shape");
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("td")).toHaveCount(4);
  const placed = await table.boundingBox();
  expect(placed!.width).toBeCloseTo(last!.width, 0);
  expect(placed!.height).toBeCloseTo(last!.height, 0);
  await expect(table.locator("[contenteditable=true]").first()).toBeFocused();
  await page.keyboard.type("Click table");
  await expect(table.locator("td").first()).toContainText("Click table");
});

test("dragging adds rows and columns and preview matches the placed grid", async ({ page }) => {
  const start = await armTable(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 300, start.y + 180, { steps: 8 });
  const preview = page.locator(".overlay-insert-preview-shape");
  await expect(preview).toHaveAttribute("data-table-preview-rows", "5");
  await expect(preview).toHaveAttribute("data-table-preview-columns", "5");
  await expect(preview.locator("td, [contenteditable]")).toHaveCount(0);
  const expected = await preview.boundingBox();
  expect(expected!.width).toBeCloseTo(320, 0);
  expect(expected!.height).toBeCloseTo(180, 0);
  await page.mouse.up();
  const table = page.locator(".overlay-table-shape");
  await expect(table).toBeVisible();
  const placed = await table.boundingBox();
  expect(placed!.width).toBeCloseTo(expected!.width, 0);
  expect(placed!.height).toBeCloseTo(expected!.height, 0);
  await expect(table.locator("tr")).toHaveCount(5);
  await expect(table.locator("td")).toHaveCount(25);
  await expect(table.locator("td").first()).toHaveCSS("border-top-style", "solid");
  await expect(table.locator("[contenteditable=true]").first()).toBeFocused();
  await expect(table.locator("[contenteditable=true]")).toHaveCount(1);
  await page.keyboard.type("A");
  await page.keyboard.press("ArrowRight");
  await expect(table.locator("td").nth(1).locator("[contenteditable=true]")).toBeFocused();
  await page.keyboard.type("B");
  await page.keyboard.press("ArrowDown");
  await expect(table.locator("td").nth(6).locator("[contenteditable=true]")).toBeFocused();
  await page.keyboard.type("C");
  await table.locator("td").nth(24).click();
  await expect(table.locator("td").nth(24).locator("[contenteditable=true]")).toBeFocused();
  await page.keyboard.type("=1+2");
  await table.locator("td").first().click();
  await expect(table.locator("td").nth(24)).toHaveText("3");
  await expect(table.locator("[contenteditable=true]")).toHaveCount(1);
  await expect(table.locator("td").first()).toContainText("A");
  await expect(table.locator("td").nth(1)).toContainText("B");
  await expect(table.locator("td").nth(6)).toContainText("C");
});

test("table can be armed again after leaving a cell editor", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const start = await armTable(page);
  await page.mouse.click(start.x, start.y);
  const table = page.locator(".overlay-table-shape");
  await expect(table.locator("[contenteditable=true]").first()).toBeFocused();
  await page.keyboard.type("A");
  await page.mouse.click(start.x + 250, start.y + 250);
  await expect(table.locator("[contenteditable=true]")).toHaveCount(0);
  await armTable(page);
  await page.mouse.click(start.x + 160, start.y);
  await expect(page.locator(".overlay-table-shape")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("clicking a later paragraph in an inactive cell edits that paragraph", async ({ page }) => {
  const staticTable = page.locator('.page-overlay-preview [data-overlay-shape-id="table_multi"]').first();
  const bounds = await staticTable.boundingBox();
  if (!bounds) throw new Error("Seeded table is missing");
  await grabShapeFromBody(page, { x: bounds.x + 30, y: bounds.y + 30 });
  await page.mouse.click(bounds.x + 30, bounds.y + 30);
  const table = page.locator(".overlay-table-shape.editing");
  await expect(table).toBeVisible();
  const second = table.locator('[data-table-content-id="paragraph_second"]');
  const paragraphBounds = await second.boundingBox();
  if (!paragraphBounds) throw new Error("Second paragraph is missing");
  await page.mouse.click(paragraphBounds.x + paragraphBounds.width / 2, paragraphBounds.y + paragraphBounds.height / 2);
  await expect(second.locator("[contenteditable=true]")).toBeFocused();
  await page.keyboard.type("X");
  await expect(second).toContainText("X");
  await expect(table.locator('[data-table-content-id="paragraph_first"]')).toHaveText("First");
});

test("Escape and pointer cancellation discard placement without saving a table", async ({ page }) => {
  for (const cancellation of ["preview", "drag", "pointercancel"]) {
    const dragging = cancellation !== "preview";
    const start = await armTable(page);
    await page.mouse.move(start.x, start.y);
    await expect(page.locator("[data-table-placement-preview]")).toBeVisible();
    if (dragging) {
      await page.mouse.down();
      await page.mouse.move(start.x + 220, start.y + 110, { steps: 5 });
    }
    if (cancellation === "pointercancel") {
      await page.locator(".overlay-canvas-bleed-surface").first().dispatchEvent("pointercancel");
    } else {
      await page.keyboard.press("Escape");
    }
    if (dragging) await page.mouse.up();
    await expect(page.locator(".overlay-insert-preview-shape")).toHaveCount(0);
    await expect(page.locator(".overlay-table-shape")).toHaveCount(0);
  }
  expect(await page.evaluate(async () => {
    const file = (await window.desktopAPI!.storage.listFiles())[0];
    const document = await window.desktopAPI!.storage.loadDocument(file.fileId);
    return document?.pageLayout?.overlay?.overlaySnapshot?.shapes.filter((shape) => shape.type === "tableShape").length ?? 0;
  })).toBe(0);
});

test("preview leaves the canvas without leaving a saved shape", async ({ page }) => {
  const start = await armTable(page);
  await page.mouse.move(start.x, start.y);
  await expect(page.locator("[data-table-placement-preview]")).toBeVisible();
  await page.getByRole("button", { name: "表", exact: true }).first().hover();
  await expect(page.locator("[data-table-placement-preview]")).toHaveCount(0);
  await page.mouse.move(start.x, start.y);
  await expect(page.locator("[data-table-placement-preview]")).toBeVisible();
  await expect(page.locator(".overlay-table-shape")).toHaveCount(0);
});
