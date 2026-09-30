import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("desktop account shows a Pro badge instead of a plan-view button", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-pro-badge-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => (
    entry[1] !== undefined && /^(PATH|HOME|TMPDIR|USER|LOGNAME|SHELL|SystemRoot|DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|SIGMA_STUDIO_DEV_SERVER_URL)$/.test(entry[0])
  )));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => window.desktopAPI!.settings!.setUiLocale!("ja"));
    // Account status is a fixture; the UI, Electron preload, and IPC path are real.
    await app.evaluate(({ ipcMain }) => {
      const capabilities = {
        hierarchySharingEnabled: true, canStartDocumentShare: true, documentShareSource: "entitlement",
        canStartHierarchyShare: true, hierarchyShareSource: "entitlement", participantLimit: 15,
      };
      const status = { state: "ready", actorId: "owner", revision: 1, capabilities };
      for (const [route, value] of [
        ["collaboration:info", { configured: true, user: { actorId: "owner", displayName: "Owner" }, sessions: [], restrictedFileIds: [] }],
        ["shared-catalog:status", status], ["shared-catalog:refresh", status],
        ["shared-catalog:locked-document-count", 0], ["shared-catalog:visible", undefined],
      ] as const) {
        ipcMain.removeHandler(route);
        ipcMain.handle(route, () => value);
      }
    });
    const url = new URL(page.url());
    url.pathname = process.env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : url.pathname.replace(/index\.html$/, "workspace.html");
    await page.goto(url.href);
    const account = page.getByRole("button", { name: "Owner のアカウント", exact: true });
    await expect(account.getByText("Pro", { exact: true })).toBeVisible();
    await account.click();
    const menu = page.getByRole("dialog", { name: "Owner のアカウント" });
    await expect(menu.getByText("Pro", { exact: true })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Proプランを見る" })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: "Proにアップグレード" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("pro-account-badge.png") });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
