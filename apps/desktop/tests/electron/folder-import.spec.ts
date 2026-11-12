import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
const GROUPS = [{ extensionId: "sample-tool", name: "サンプル変換", sections: [{ entries: [
  { type: "button", id: "folder", label: "フォルダを変換", icon: "folder-open" },
] }] }];

test("folder progress and paged results cross the real preload without importing a document", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "out/index.html")), "Build renderer and Electron first");
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-folder-ui-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
    const page = await app.firstWindow();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 90_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI && window.sigmaExtensions));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    await app.evaluate(({ ipcMain }, groups) => {
      ipcMain.removeHandler("extensions:menu"); ipcMain.handle("extensions:menu", () => groups);
      ipcMain.removeHandler("extensions:run");
      ipcMain.handle("extensions:run", (event, ...ids) => {
        (globalThis as { folderIds?: unknown[] }).folderIds = ids;
        event.sender.send("extensions:folder-progress", { phase: "converting", completed: 1, total: 3, currentPath: "数学/教材.smp", counts: { success: 1, skipped: 0, failed: 0 } });
        return new Promise(resolve => { (globalThis as { finishFolder?: (result: unknown) => void }).finishFolder = resolve; });
      });
    }, GROUPS);
    await page.reload();
    const before = await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length);
    await page.getByRole("navigation", { name: "メニュー" }).getByRole("button", { name: "拡張機能", exact: true }).click();
    await page.getByRole("menuitem", { name: "フォルダを変換" }).click();
    const running = page.getByRole("dialog", { name: "フォルダを変換中…" });
    await expect(running).toBeVisible();
    await expect(running).toContainText("数学/教材.smp");
    await expect(running.getByRole("progressbar")).toHaveAttribute("value", "1");
    await page.keyboard.press("Escape"); await expect(running).toBeVisible();
    await app.evaluate(() => {
      (globalThis as { finishFolder?: (result: unknown) => void }).finishFolder!({
        ok: true, kind: "folder", jobId: "job", outputDirectory: "/chosen/SIGMA-import-test", truncated: true, reportError: "write-failed",
        counts: { success: 1, skipped: 100, failed: 1 }, entries: [
          { relativePath: "数学/教材.smp", status: "success", reason: "converted", scope: "file", issueCount: 2 },
          { relativePath: ".hidden", status: "skipped", reason: "hidden", scope: "subtree" },
          { relativePath: "失敗.smp", status: "failed", reason: "timeout", scope: "file" },
          ...Array.from({ length: 99 }, (_, i) => ({ relativePath: `skip-${i}.png`, status: "skipped", reason: "unsupported", scope: "file" })),
        ],
      });
    });
    const result = page.getByRole("dialog", { name: "フォルダの変換結果" });
    await expect(result).toBeVisible();
    await expect(result).toContainText("成功 1件 / スキップ 100件 / 失敗 1件");
    await expect(result).toContainText("配下全体を1項目として集計");
    await expect(result).toContainText("未走査の項目があります");
    await expect(result).toContainText("結果レポートを保存できませんでした");
    await expect(result).toContainText("所見 2件");
    await expect(result.getByRole("button", { name: "レポートを開く" })).toBeDisabled();
    await result.getByRole("button", { name: "次へ" }).click();
    await expect(result).toContainText("skip-98.png");
    await result.getByRole("button", { name: "前へ" }).click();
    await page.screenshot({ path: "test-results/folder-import-results.png" });
    expect(await app.evaluate(() => (globalThis as { folderIds?: unknown[] }).folderIds)).toEqual(["sample-tool", "folder"]);
    expect(await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length)).toBe(before);
    await result.getByRole("button", { name: "閉じる", exact: true }).last().click();
    await expect(result).toHaveCount(0);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    expect(await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).length)).toBe(before);
  } finally {
    await app?.close(); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
