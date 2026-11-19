import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

/** An English system, so that a lost choice shows up as the detected English instead of the default Japanese. */
function launchEnv(profile: string): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "",
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", LANGUAGE: "en_US",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

async function open(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  return page;
}

async function expectJapanese(page: Page): Promise<void> {
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByPlaceholder("すべてのワークスペースを検索", { exact: true })).toBeVisible();
}

test("Japanese chosen on an English system stays Japanese after reloads and restarts, even when chosen while the first settings read is under way", async () => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-ui-locale-"));
  try {
    let app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env: launchEnv(profile) });
    try {
      const page = await open(app);
      // Chosen as early as the bridge exists: the renderer's first read of the settings may still be on its way back.
      await page.evaluate(async () => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        localStorage.setItem("sigma-studio:ui-locale", "ja");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
      });
      for (let round = 0; round < 3; round++) {
        await page.reload();
        await expectJapanese(page);
      }
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
    } finally { await app.close(); }

    // A real restart with the same profile.
    for (let round = 0; round < 2; round++) {
      app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env: launchEnv(profile) });
      try {
        const page = await open(app);
        await expectJapanese(page);
        expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
      } finally { await app.close(); }
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
