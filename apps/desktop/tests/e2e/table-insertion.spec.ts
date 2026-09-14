import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-startup-splash]")).toHaveCount(0);
  await page.getByRole("button", { name: "表", exact: true }).first().click();
});

test("previews rows and columns and focuses the first cell after insertion", async ({ page }) => {
  const picker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(picker.getByRole("status")).toHaveText("3行 × 4列");
  const target = picker.getByRole("button", { name: "5列 2行の表を挿入", exact: true });
  await target.hover();
  await expect(picker.getByRole("status")).toHaveText("2行 × 5列");
  await expect(picker.locator(".table-insert-grid button.selected")).toHaveCount(10);
  await expect(picker.getByRole("spinbutton", { name: "行数" })).toHaveValue("2");
  await expect(picker.getByRole("spinbutton", { name: "列数" })).toHaveValue("5");
  await target.click();
  await expect(picker).toHaveCount(0);
  const table = page.locator(".overlay-table-shape").first();
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(5);
  const firstCell = table.locator("[contenteditable=true]").first();
  await expect(firstCell).toBeFocused();
  await page.keyboard.type("First cell");
  await expect(table.locator("td").first()).toContainText("First cell");
});

test("arrow keys select a size, Tab reaches the numeric fields, and Escape restores focus", async ({ page }) => {
  const picker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(picker.getByRole("button", { name: "4列 3行の表を挿入", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(picker.getByRole("status")).toHaveText("4行 × 5列");
  await page.keyboard.press("Tab");
  await expect(picker.getByRole("spinbutton", { name: "行数" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("button", { name: "表", exact: true }).first()).toBeFocused();
  await expect(page.locator(".overlay-shape-tableShape")).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  const table = page.locator(".overlay-table-shape").first();
  await expect(table.locator("tr")).toHaveCount(2);
  await expect(table.locator("td")).toHaveCount(2);
});

test("accepts a numeric size beyond the grid and rejects invalid sizes", async ({ page }) => {
  const picker = page.getByRole("dialog", { name: "表を挿入" });
  const rows = picker.getByRole("spinbutton", { name: "行数" });
  const columns = picker.getByRole("spinbutton", { name: "列数" });
  const insert = picker.getByRole("button", { name: "表を挿入", exact: true });
  for (const value of ["", "0", "-1", "2.5", "21"]) {
    await rows.fill(value);
    await expect(rows).toHaveAttribute("aria-invalid", "true");
    await expect(insert).toBeDisabled();
  }
  await rows.fill("9");
  await columns.fill("11");
  await expect(picker.getByRole("status")).toHaveText("9行 × 11列");
  await expect(insert).toBeEnabled();
  await columns.press("Enter");
  await expect(picker).toHaveCount(0);
  const table = page.locator(".overlay-table-shape").first();
  await expect(table.locator("tr")).toHaveCount(9);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(11);
  await expect(table.locator("[contenteditable=true]").first()).toBeFocused();
});

test("close button and outside click cancel without inserting; the picker fits a short viewport", async ({ page }) => {
  const picker = page.getByRole("dialog", { name: "表を挿入" });
  await picker.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(picker).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "表", exact: true }).first();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1100, height: 500 });
  await trigger.click();
  await expect(picker).toBeVisible();
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(8);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(492);
  await page.mouse.click(1000, 490);
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".overlay-shape-tableShape")).toHaveCount(0);
});
