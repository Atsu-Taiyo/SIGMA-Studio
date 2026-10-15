import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
const FONT_FIXTURE = path.join(
  path.dirname(createRequire(path.join(APP_ROOT, "package.json")).resolve("katex/package.json")),
  "dist/fonts/KaTeX_Main-Regular.ttf",
);

async function openExtensions(page: Page) {
  await page.getByRole("button", { name: "設定", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "拡張機能" }).click();
  const dialog = page.getByRole("dialog", { name: "拡張機能" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("extensions dialog lists added fonts as a grid of samples and names, keeps details in a three-dot menu, and survives reload", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) || !existsSync(path.join(APP_ROOT, "out/index.html")), "Build the static renderer and Electron first.");
  test.skip(!existsSync(FONT_FIXTURE), "The KaTeX font fixture is unavailable.");
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-extensions-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
    const page = await app.firstWindow();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 90_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.fonts));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.fonts));
    // The OS file picker is the only native surface; answer it with the fixture font.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, FONT_FIXTURE);

    // The app settings no longer carry fonts or plugins.
    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "アプリ設定" }).click();
    const settings = page.getByRole("dialog", { name: "設定" });
    await expect(settings).toBeVisible();
    await expect(settings.getByText("追加フォント")).toHaveCount(0);
    await expect(settings.getByText("公式プラグイン")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    let dialog = await openExtensions(page);
    await expect(dialog.getByText("追加済みフォントはありません。")).toBeVisible();
    await dialog.getByRole("button", { name: "フォントを追加" }).click();
    const tiles = dialog.locator("ul > li");
    await expect(tiles).toHaveCount(1);

    // The tile shows a sample drawn in the added face and its name only.
    const tile = tiles.first();
    const fileName = readdirSync(path.join(profile, "data/fonts"))[0];
    expect(fileName).toMatch(/\.ttf$/);
    await expect(tile).not.toContainText(fileName);
    const sample = tile.locator('[aria-hidden="true"]').first();
    await expect(sample).toHaveText("Aあ");
    expect(await sample.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Sigma Custom Font");
    expect(await tile.locator("button").count()).toBe(1);

    // Details and the delete action live in the three-dot menu, which Escape closes alone.
    const trigger = tile.getByRole("button", { name: /のその他の操作$/ });
    await trigger.focus();
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("ファイル名");
    await expect(menu).toContainText(fileName);
    await expect(menu).toContainText("追加日");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();

    // The font is still there after a reload, then deleting removes it from disk too.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.fonts));
    dialog = await openExtensions(page);
    await expect(dialog.locator("ul > li")).toHaveCount(1);
    await dialog.locator("ul > li").first().getByRole("button", { name: /のその他の操作$/ }).click();
    await page.getByRole("menuitem", { name: "削除" }).click();
    await expect(dialog.getByText("追加済みフォントはありません。")).toBeVisible();
    await expect(dialog.getByText("フォントを削除しました。")).toBeVisible();
    expect(readdirSync(path.join(profile, "data/fonts"))).toEqual([]);

    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.fonts));
    dialog = await openExtensions(page);
    await expect(dialog.getByText("追加済みフォントはありません。")).toBeVisible();
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
