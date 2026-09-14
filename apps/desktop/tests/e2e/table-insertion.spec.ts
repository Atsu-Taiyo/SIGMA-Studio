import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

async function armTable(page: Page) {
  await page.getByRole("button", { name: "表", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "表を挿入" })).toHaveCount(0);
  const canvas = page.locator(".overlay-canvas-editor").first();
  await expect(canvas).toHaveAttribute("data-overlay-insert-command", "table");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas is missing");
  return { x: bounds.x + 80, y: bounds.y + 180 };
}

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-startup-splash]")).toHaveCount(0);
});

test("2 by 2 preview follows the pointer and a click places it with first-cell focus", async ({ page }) => {
  const start = await armTable(page);
  await page.mouse.move(start.x, start.y);
  const preview = page.locator("[data-table-placement-preview] .overlay-insert-preview-shape");
  await expect(preview).toBeVisible();
  await expect(preview.locator("tr")).toHaveCount(2);
  await expect(preview.locator("td")).toHaveCount(4);
  await expect(preview).toHaveCSS("opacity", "0.45");
  await expect(preview.locator("td").first()).toHaveCSS("border-top-style", "dashed");
  const first = await preview.boundingBox();
  await page.mouse.move(start.x + 60, start.y + 40);
  await expect.poll(async () => (await preview.boundingBox())?.x).toBeCloseTo(first!.x + 60, 0);
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
  await expect(preview.locator("tr")).toHaveCount(5);
  await expect(preview.locator("td")).toHaveCount(25);
  await expect(preview.locator("td").first()).toHaveCSS("border-top-style", "dashed");
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
