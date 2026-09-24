import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("desktop header keeps the title, menus and sharing controls inside its two rows", async ({}, testInfo) => {
  const appRoot = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-header-layout-"));
  // This layout regression runs without cloud credentials or a signed-in profile.
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => (
    entry[1] !== undefined && /^(PATH|HOME|TMPDIR|USER|LOGNAME|SHELL|SystemRoot|DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|SIGMA_STUDIO_DEV_SERVER_URL)$/.test(entry[0])
  )));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [appRoot], cwd: appRoot, env });
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 60_000 });
    await page.addInitScript(() => {
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:ui-locale", "ja");
    });
    await page.evaluate(async () => { await window.desktopAPI!.settings!.setUiLocale!("ja"); });
    await page.evaluate(() => localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true })));
    await page.reload();
    for (const width of [1400, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('.app-shell[data-ui-layout="docs"]')).toBeVisible();
      const header = page.locator(".menubar-row");
      const bounds = await header.boundingBox();
      expect(bounds).not.toBeNull();
      const controls = [page.getByRole("textbox", { name: "教材タイトル" }), page.getByRole("button", { name: "共有", exact: true }), page.getByRole("button", { name: "ワークスペース", exact: true }), page.locator(".app-menu-list"), page.locator(".document-tabs-row")];
      for (const control of controls) {
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      const share = await controls[1].boundingBox();
      const workspace = await controls[2].boundingBox();
      expect(share!.x + share!.width).toBeLessThanOrEqual(workspace!.x);
      await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
      await controls[1].click();
      await expect(page.getByRole("dialog")).toContainText("共有設定");
      await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await page.reload();
    }
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
