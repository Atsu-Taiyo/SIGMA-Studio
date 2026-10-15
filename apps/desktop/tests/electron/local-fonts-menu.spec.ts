import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

test("the font menu offers the fonts installed on this PC, and falls back to the fixed menu when they cannot be read", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) || !existsSync(path.join(APP_ROOT, "out/index.html")), "Build the static renderer and Electron first.");
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-local-fonts-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env, chromiumSandbox: true });
    const page = await app.firstWindow();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 90_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI && (window as Window & { sigmaLocalFonts?: unknown }).sigmaLocalFonts));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    await page.reload();
    await page.waitForFunction(() => Boolean((window as Window & { sigmaLocalFonts?: unknown }).sigmaLocalFonts));

    // The bridge returns names only: a list of faces, or null when the runtime cannot read them. Never an empty list.
    const catalog = await page.evaluate(() => (window as unknown as { sigmaLocalFonts: { list(): Promise<{ ok: boolean; systemFonts: unknown; fonts: unknown }> } }).sigmaLocalFonts.list());
    expect(catalog.ok).toBe(true);
    expect(Array.isArray(catalog.fonts)).toBe(true);
    const faces = catalog.systemFonts as Array<Record<string, unknown>> | null;
    if (faces !== null) {
      expect(faces.length).toBeGreaterThan(0);
      expect(Object.keys(faces[0]).sort()).toEqual(["family", "fullName", "postscriptName", "style"]);
    }

    // The font menu: fixed choices stay, and the PC's fonts get their own group when they could be read.
    const body = page.locator(".page-flow .ProseMirror").first();
    await expect(body).toBeVisible();
    await body.click();
    await page.locator('button[aria-label^="フォント:"]').first().click({ timeout: 15_000 });
    const menu = page.getByRole("menu", { name: "フォント", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByText("M PLUS 1p").first()).toBeVisible();
    const pcGroup = menu.getByRole("group", { name: "このPCのフォント" });
    if (faces === null) {
      await expect(pcGroup).toHaveCount(0);
    } else if (await pcGroup.count()) {
      // The group lists the installed families the fixed groups do not already offer; it is searchable.
      await expect(pcGroup).toBeVisible();
      const family = (await pcGroup.locator("button").first().innerText()).trim();
      expect(faces.map((face) => face.family)).toContain(family);
      await menu.getByPlaceholder("フォントを検索").fill(family);
      await expect(pcGroup.getByText(family, { exact: true }).first()).toBeVisible();
    }
    await page.screenshot({ path: "test-results/local-fonts-menu.png" });
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
