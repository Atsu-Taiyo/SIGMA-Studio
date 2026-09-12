import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 英語ロケールでのクローム。`playwright.config.ts` はブラウザロケールを ja-JP に固定して
 * いるので、ここだけ en-US を明示して「保存値が無いときは OS/ブラウザロケールに従う」
 * 経路ごと英語にする (localStorage を仕込むより実際の初回起動に近い)。
 */
test.use({ locale: "en-US" });

/** UI の面に日本語が残っていないか。教材の中身 (タイトル等) は対象外なのでスコープを絞る。 */
const JAPANESE = /[぀-ゟ゠-ヿ一-鿿]/u;

/**
 * まだ日本語のまま残ることが分かっている文言。図形ギャラリー
 * (`overlay-canvas/shape-gallery.tsx`) は `shape` namespace = WI-6 の担当で、
 * クロームのツールバーにはその選択中ラベルが出てくる。
 *
 * 判定は「この集合の**部分集合**であること」。WI-6 がここを英語にしても赤くならず、
 * 逆にクローム側で新しい日本語が生えたら必ず落ちる。
 */
const DEFERRED_TO_LATER_WI = ["線"];

async function japaneseTextIn(page: Page, scope: string): Promise<string[]> {
  return page.$$eval(scope, (roots) => {
    const found: string[] = [];
    for (const root of roots) {
      for (const element of [root, ...root.querySelectorAll("*")]) {
        const label = element.getAttribute("aria-label") ?? "";
        const title = element.getAttribute("title") ?? "";
        // テキストは葉だけ見る (親を辿ると同じ文字列を何度も拾う)。
        const text = element.children.length === 0 ? (element.textContent ?? "").trim() : "";
        for (const value of [label, title, text]) {
          if (value) {
            found.push(value);
          }
        }
      }
    }
    return found;
  }).then((values) => values.filter((value) => JAPANESE.test(value)));
}

/**
 * Word風リボン (`.ribbon-*`) はいま **アプリから到達できない** — `EditorShell.tsx` が
 * 保存済みの設定に関わらず表示を docs へ倒しているため (「Word風リボンは再検討まで露出しない」)。
 * したがってリボン / Backstage / QAT / ステータスバーの英語化は e2e では踏めず、
 * 辞書の網羅 (`dictionaries/parity.test.ts`)・キーの使用 (`chrome-i18n.test.ts`)・
 * ラベル解決 (`ribbon-tabs.test.ts` / `ribbon-backstage.test.ts`) の3点で固定してある。
 * 露出が戻ったらこのファイルへリボンの巡回を足すこと。
 */

test.describe("Google-Docs-style chrome in English", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await installDesktopRuntimeMock(page, sampleDocument);
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });
  });

  test("names the app menus and the quick toolbar in English", async ({ page }) => {
    await expect(page.locator(".app-menu-list button")).toHaveText(["File", "Insert", "AI", "Settings"]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeVisible();
  });

  test("leaves no Japanese in the quick toolbar", async ({ page }) => {
    const found = await japaneseTextIn(page, '.editor-menubar [data-editor-toolbar="quick"]');
    expect(found.filter((value) => !DEFERRED_TO_LATER_WI.includes(value))).toEqual([]);
  });

  test("leaves no Japanese in the app menus", async ({ page }) => {
    for (const menuName of ["File", "Insert", "AI", "Settings"]) {
      await page.locator(".app-menu-list").getByRole("button", { name: menuName, exact: true }).click();
      const menu = page.getByRole("menu", { name: menuName });
      await expect(menu).toBeVisible();
      expect(await japaneseTextIn(page, `[role="menu"][aria-label="${menuName}"]`), `${menuName} メニュー`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  });
});
