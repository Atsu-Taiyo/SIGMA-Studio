import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("account recovery action appears only for existing locked documents", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-locked-menu-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => window.desktopAPI!.settings!.setUiLocale!("ja"));
    // Service results are fixtures; account menu and preload are the actual Electron code.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { lockedCount: number };
      state.lockedCount = 0;
      ipcMain.removeHandler("collaboration:info");
      ipcMain.handle("collaboration:info", () => ({ configured: true, user: { actorId: "owner", displayName: "Owner" }, sessions: [], restrictedFileIds: [] }));
      ipcMain.removeHandler("shared-catalog:locked-document-count");
      ipcMain.handle("shared-catalog:locked-document-count", () => state.lockedCount);
      ipcMain.removeHandler("shared-catalog:recover-locked");
      ipcMain.handle("shared-catalog:recover-locked", () => { state.lockedCount = 0; return { saved: 1, failed: 0 }; });
    });
    const url = new URL(page.url());
    url.pathname = process.env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : url.pathname.replace(/index\.html$/, "workspace.html");
    await page.goto(url.href);
    const account = page.getByRole("button", { name: "Owner のアカウント", exact: true });
    const recovery = page.getByRole("button", { name: "ロックされた教材を端末に移動（オンラインから削除）", exact: true });
    await account.click(); await expect(recovery).toHaveCount(0); await account.click();
    await app.evaluate(() => { (globalThis as typeof globalThis & { lockedCount: number }).lockedCount = 1; });
    await account.click(); await expect(recovery).toBeVisible();
    await recovery.click(); await expect(recovery).toHaveCount(0);
    await expect(page.getByText("1件を端末に移動しました。", { exact: false })).toBeVisible();
    await account.click(); await account.click(); await expect(recovery).toHaveCount(0);
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
