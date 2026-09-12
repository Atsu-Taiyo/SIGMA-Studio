import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("ambiguous icon actions explain the result and show the current shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installDesktopRuntimeMock(page, sampleDocument, { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitem", { name: "ショートカット設定" }).click();
  const commandDialog = page.getByRole("dialog", { name: "ショートカット設定" });
  await commandDialog.getByRole("textbox", { name: "コマンドを検索" }).fill("元に戻す");
  await commandDialog.getByRole("button", { name: "元に戻す のキー割り当てを変更" }).click();
  await page.keyboard.press("q");
  await commandDialog.getByRole("button", { name: "元に戻す を既定に戻す" }).hover();
  const modalTooltip = page.getByRole("tooltip");
  await expect(modalTooltip.getByText("既定のキーに戻す", { exact: true })).toBeVisible();
  expect(await modalTooltip.evaluate((element) => element.parentElement?.matches("[data-modal-backdrop]") === true)).toBe(true);
  await commandDialog.getByRole("button", { name: "閉じる", exact: true }).click();

  const undoButton = page.getByRole("button", { name: "元に戻す", exact: true });
  await undoButton.hover();

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.getByText("直前の操作を戻す", { exact: true })).toBeVisible();
  await expect(tooltip.locator("kbd")).toHaveText("Q");
  await expect(tooltip.locator("kbd")).toHaveAttribute("aria-label", "ショートカット Q");
  await expect(undoButton).not.toHaveAttribute("title");
  expect(await tooltip.evaluate((element) => element.parentElement === document.body)).toBe(true);

  await page.mouse.move(900, 700);
  await expect(tooltip).toBeHidden();

  await undoButton.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
});
