import { expect, test } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { installDocumentTabMock } from "./document-tab-mock";

test.beforeEach(async ({ page }) => {
  await installDocumentTabMock(page, createBlankDocument("残す教材"), createBlankDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
});

test("closing an untouched new material removes its file", async ({ page }) => {
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await page.getByLabel("無題の教材 のタブを閉じる").click();
  await expect(page.locator(".document-tab")).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length)).toBe(1);
});

test("renaming a new material retains it and saves the name immediately", async ({ page }) => {
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await page.getByLabel("教材タイトル").fill("残す教材");
  await page.getByLabel("教材タイトル").press("Tab");
  await expect(page.getByLabel("教材タイトル")).toHaveValue("残す教材 2");
  await page.getByLabel("残す教材 2 のタブを閉じる").click();
  await expect(page.locator(".document-tab")).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).map((file) => file.title))).toEqual(["残す教材", "残す教材 2"]);
});

test("a material remains after writing and undoing its content", async ({ page }) => {
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await page.locator(".page-flow .tiptap").first().click();
  await page.keyboard.insertText("朝");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".page-flow .tiptap").first()).toHaveText("");
  await page.locator(".document-tab.active .document-tab-close").click();
  await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length)).toBe(2);
});

test("closing an inactive untouched tab leaves the current material active", async ({ page }) => {
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "残す教材", exact: true }).click();
  await page.getByLabel("無題の教材 のタブを閉じる").click();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("残す教材");
  await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length)).toBe(1);
});

test("closing the last untouched tab returns to the workspace", async ({ page }) => {
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await page.getByLabel("残す教材 のタブを閉じる").click();
  await expect(page.locator(".document-tab")).toHaveCount(1);
  await page.getByLabel("無題の教材 のタブを閉じる").click();
  await page.waitForURL(/\/workspace/);
  await expect(page.locator(".workspace-sidebar")).toBeVisible();
});
