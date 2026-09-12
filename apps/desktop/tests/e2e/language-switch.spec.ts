import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const UI_LOCALE_STORAGE_KEY = "sigma-studio:ui-locale";

/**
 * 設定ダイアログを開く導線。アプリメニュー (WI-2) もダイアログの accessible name (WI-3)
 * も i18n 済みなので、その時点の表示言語のラベルで引く。
 */
async function openAppSettings(page: Page, menu: string, item: string, dialogName: string): Promise<Locator> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
  const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function documentLanguage(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.lang);
}

test.describe("UI language", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await installDesktopRuntimeMock(page, sampleDocument, {
      // モックは読み込みのたびに localStorage を消すので、再起動をまたぐ検証は
      // 対象キーを明示的に持ち越す。
      preserveStorageKeys: [UI_LOCALE_STORAGE_KEY],
    });
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
  });

  test("switches to English in place and keeps the choice across a restart", async ({ page }) => {
    const dialog = await openAppSettings(page, "設定", "アプリ設定", "設定");
    await expect(dialog.getByRole("heading", { name: "言語" })).toBeVisible();

    const select = dialog.getByLabel("表示言語");
    await expect(select).toHaveValue("ja");
    await select.selectOption("en");

    // 再読み込みなしでその場で切り替わる。ダイアログ自身の accessible name も英語に
    // なるので (WI-3)、開いたときの locator は使い回せない。取り直して確かめる。
    const switched = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(switched.getByRole("heading", { name: "Language" })).toBeVisible();
    await expect(switched.getByLabel("Display language")).toHaveValue("en");
    expect(await documentLanguage(page)).toBe("en");

    await page.keyboard.press("Escape");
    await expect(switched).toBeHidden();

    await expect(page.getByTestId("app-crash-screen")).toHaveCount(0);
    await expect(page.locator(".text-flow-editor").first()).toBeVisible();

    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    expect(await documentLanguage(page)).toBe("en");

    const reopened = await openAppSettings(page, "Settings", "App settings", "Settings");
    await expect(reopened.getByRole("heading", { name: "Language" })).toBeVisible();
    await expect(reopened.getByLabel("Display language")).toHaveValue("en");

    // 日本語へ戻すと、その場で日本語に戻る。
    await reopened.getByLabel("Display language").selectOption("ja");
    const restored = page.getByRole("dialog", { name: "設定", exact: true });
    await expect(restored.getByRole("heading", { name: "言語" })).toBeVisible();
    expect(await documentLanguage(page)).toBe("ja");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app-crash-screen")).toHaveCount(0);
    await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  });
});
