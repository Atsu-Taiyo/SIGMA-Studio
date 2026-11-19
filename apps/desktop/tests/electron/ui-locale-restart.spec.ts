import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function findSettingsFile(root: string): Promise<string> {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === "settings.json") {
      const file = path.join(entry.parentPath, entry.name);
      if ("uiLocale" in (JSON.parse(await readFile(file, "utf8")) as object)) return file;
    }
  }
  throw new Error("No settings file with a language");
}

async function open(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  return page;
}

async function expectJapanese(page: Page): Promise<void> {
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  // Whichever screen opens (the library or a new material), its labels are the Japanese ones.
  await expect(page.getByPlaceholder("すべてのワークスペースを検索", { exact: true })
    .or(page.getByRole("button", { name: "ワークスペース", exact: true })).first()).toBeVisible();
  await expect(page.getByPlaceholder("Search all workspaces", { exact: true })).toHaveCount(0);
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
        localStorage.setItem("sigma-studio:ui-locale", "ja");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
      });
      for (let round = 0; round < 3; round++) {
        await page.reload();
        await expectJapanese(page);
      }

      // Make the race certain, as on a first launch: no language in the settings file yet and the detected
      // English on screen. The settings are read, then the answer is held back while Japanese is chosen.
      // The late answer (no language yet) must not put English back.
      const settingsFile = await findSettingsFile(profile);
      const raw = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
      delete raw.uiLocale;
      await writeFile(settingsFile, JSON.stringify(raw));
      await page.evaluate(() => localStorage.setItem("sigma-studio:ui-locale", "en"));
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get("settings:get");
        if (!original) throw new Error("settings:get is not registered");
        let held = false;
        handlers.set("settings:get", async (...args: unknown[]) => {
          const answer = await original(...args);
          if (!held) { held = true; await new Promise(resolve => setTimeout(resolve, 3000)); }
          return answer;
        });
      });
      await page.reload();
      await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      await page.evaluate(async () => {
        localStorage.setItem("sigma-studio:ui-locale", "ja");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
      });
      // Past the held answer.
      await page.waitForTimeout(4000);
      expect(await page.evaluate(() => localStorage.getItem("sigma-studio:ui-locale"))).toBe("ja");
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
      await page.reload();
      await expectJapanese(page);
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
