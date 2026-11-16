import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dismissedKey = "sigma-studio:usage-guide-dismissed:v1";

test("usage guide opens the manual through Electron and remembers opt-out after restart", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-usage-guide-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await electron.launch({ args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, shell }) => {
      // Exercise the real external-link handler without opening the user's browser.
      shell.openExternal = async (url) => { process.env.SIGMA_TEST_EXTERNAL_URL = url; };
      const win = BrowserWindow.getAllWindows()[0];
      win.show();
      win.focus();
    });
    return page;
  };
  try {
    let page = await launch();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fileId = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      return (await window.desktopAPI!.storage.createDocument({ title: "使い方案内の確認" })).file.fileId;
    });
    const targetUrl = new URL(page.url());
    targetUrl.searchParams.set("fileId", fileId);
    await page.goto(targetUrl.href);
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.clock.install();
    const ready = () => page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.dispatchEvent(new Event("sigma-studio:app-ready"));
    });
    await ready();
    await page.clock.fastForward(31_000);
    const guide = page.getByRole("dialog", { name: "使い方を見てみませんか？" });
    await expect(guide).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    const box = await guide.boundingBox();
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box!.x).toBeGreaterThan(viewport.width / 2);
    expect(box!.y).toBeGreaterThan(viewport.height / 2);
    const link = guide.getByRole("link", { name: "使い方を見る" });
    await expect(link).toHaveAttribute("data-tone", "primary");
    await page.screenshot({ path: test.info().outputPath("usage-guide.png") });
    await link.click();
    await expect(guide).toBeHidden();
    const confirmation = page.getByRole("dialog", { name: "リンク先を確認" });
    await expect(confirmation).toContainText("https://chocoschools.com/sigma-studio/manual/");
    await confirmation.getByRole("button", { name: "確認して外部アプリで開く" }).click();
    await expect.poll(() => app!.evaluate(() => process.env.SIGMA_TEST_EXTERNAL_URL)).toBe("https://chocoschools.com/sigma-studio/manual/");
    expect(await page.evaluate((key) => localStorage.getItem(key), dismissedKey)).toBeNull();
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await ready();
    await page.clock.fastForward(31_000);
    await expect(guide).toBeVisible();
    await guide.getByRole("button", { name: "もう表示しない" }).click();
    expect(await page.evaluate((key) => localStorage.getItem(key), dismissedKey)).toBe("1");
    await page.clock.resume();
    await app!.close();
    app = undefined;
    page = await launch();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.goto(targetUrl.href);
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.clock.install();
    await ready();
    await page.clock.fastForward(31_000);
    expect(await page.evaluate((key) => localStorage.getItem(key), dismissedKey)).toBe("1");
    await expect(page.getByRole("dialog", { name: "使い方を見てみませんか？" })).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
