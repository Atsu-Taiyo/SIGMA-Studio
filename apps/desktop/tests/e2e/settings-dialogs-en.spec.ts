import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 英語ロケールでの設定ダイアログ。`playwright.config.ts` はブラウザロケールを ja-JP に
 * 固定しているので、ここだけ en-US を明示して「保存値が無ければブラウザロケールに従う」
 * 経路ごと英語にする。
 */
test.use({ locale: "en-US" });

const JAPANESE = /[぀-ゟ゠-ヿ一-鿿]/u;

/**
 * 英語 UI に日本語が出ていてよい文言。判定は**部分集合**なので、担当 WI が英語化しても
 * 赤くならず、設定面に新しい日本語が生えたら必ず落ちる。
 */
const ALLOWED_JAPANESE = [
  // 言語セレクタの選択肢。言語名はその言語自身の表記 (endonym) で出すのが正しい。
  "日本語",
];

async function japaneseTextIn(page: Page, scope: string): Promise<string[]> {
  return page.$$eval(scope, (roots) => {
    const found: string[] = [];
    for (const root of roots) {
      for (const element of [root, ...root.querySelectorAll("*")]) {
        const label = element.getAttribute("aria-label") ?? "";
        const title = element.getAttribute("title") ?? "";
        const placeholder = element.getAttribute("placeholder") ?? "";
        // テキストは葉だけ見る (親を辿ると同じ文字列を何度も拾う)。
        const text = element.children.length === 0 ? (element.textContent ?? "").trim() : "";
        for (const value of [label, title, placeholder, text]) {
          if (value) {
            found.push(value);
          }
        }
      }
    }
    return found;
  }).then((values) => values.filter((value) => JAPANESE.test(value)));
}

async function expectNoJapanese(page: Page, scope: string, what: string): Promise<void> {
  const found = await japaneseTextIn(page, scope);
  expect(found.filter((value) => !ALLOWED_JAPANESE.includes(value)), `${what} に日本語が残っている`).toEqual([]);
}

test.describe("settings dialogs in English", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installDesktopRuntimeMock(page, sampleDocument, { ai: { enabled: true } });
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
  });

  test("names the app settings dialog in English", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "App settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Language" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Fonts" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Application" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Local data" })).toBeVisible();
    await expectNoJapanese(page, ".desktop-settings-modal", "アプリ設定");
  });

  test("names the keyboard shortcut dialog in English", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Search commands" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Reset all to defaults" })).toBeVisible();
    // コマンド名・カテゴリ・説明は WI-4 で `command` namespace に移した。一覧が全部
    // 英語で出ることをここで固定する (136 件あるので目視では守れない)。
    await expectNoJapanese(page, ".command-settings-dialog", "ショートカット設定");
  });

  test("names the page setup dialog in English", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Page setup" }).click();
    const dialog = page.getByRole("dialog", { name: "Page setup" });
    await expect(dialog).toBeVisible();
    await expectNoJapanese(page, ".page-settings-dialog", "ページ設定");
  });

  test("names the TeX environment dialog in English", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "TeX environment" }).click();
    const dialog = page.getByRole("dialog", { name: "TeX environment" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Preamble")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save settings" })).toBeVisible();
  });
});
