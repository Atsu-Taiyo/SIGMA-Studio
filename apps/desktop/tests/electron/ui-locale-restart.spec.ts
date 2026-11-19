import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
// The POSIX locale variables alone do not make the renderer English on every platform (macOS keeps its own list).
const LAUNCH_ARGS = ["--lang=en-US", APP_ROOT];

/** An English system, so that a lost choice shows up as the detected English instead of the default Japanese. */
function launchEnv(profile: string): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "",
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", LANGUAGE: "en_US",
    // No AI agent: an installed Codex would otherwise write into the throwaway profile while it is being removed.
    SIGMA_STUDIO_CODEX_BIN: path.join(profile, "no-codex"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

/** Quits, but does not let a slow shutdown of this throwaway profile use up the test's time. Returns once the process is gone. */
async function close(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>(resolve => child.once("exit", () => resolve()));
  const quit = app.close().then(() => true, () => false);
  const closed = await Promise.race([quit, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000))]);
  if (!closed) child.kill("SIGKILL");
  await exited;
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

async function holdSettingsReads(app: ElectronApplication, holdInit = false): Promise<void> {
  await app.evaluate(({ ipcMain }, holdInit) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const state = globalThis as unknown as {
      heldSettingsRead?: { released: boolean; commandSavesAfter: number };
      releaseSettingsRead?: () => void;
      originalSettingsHandlers?: { read: (...args: unknown[]) => Promise<unknown>; saveCommands: (...args: unknown[]) => Promise<unknown>; init: (...args: unknown[]) => Promise<unknown> };
      heldInit?: { pending: boolean; release: () => void };
    };
    // Armed again for a later round: wrap the original handlers, not the earlier wrappers.
    if (!state.originalSettingsHandlers) {
      const read = handlers.get("settings:get");
      const saveCommands = handlers.get("settings:set-command-config");
      const init = handlers.get("settings:init-ui-locale");
      if (!read || !saveCommands || !init) throw new Error("The settings handlers are not registered");
      state.originalSettingsHandlers = { read, saveCommands, init };
    }
    const { read, saveCommands, init } = state.originalSettingsHandlers;
    // Optionally the reply about the first-launch language is held too: it is computed at once, and handed back late.
    let releaseInit!: () => void;
    const initReleased = new Promise<void>(resolve => { releaseInit = resolve; });
    state.heldInit = { pending: false, release: releaseInit };
    handlers.set("settings:init-ui-locale", async (...args: unknown[]) => {
      const answer = await init(...args);
      if (!holdInit) return answer;
      state.heldInit!.pending = true;
      await initReleased;
      return answer;
    });
    state.heldSettingsRead = undefined;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    state.releaseSettingsRead = release;
    // Every read until the release is held, so the one the screen goes by is among them (React's development
    // Strict Mode starts a second one and drops the first).
    handlers.set("settings:get", async (...args: unknown[]) => {
      const answer = await read(...args) as Record<string, unknown>;
      if (state.heldSettingsRead?.released) return answer;
      state.heldSettingsRead ??= { released: false, commandSavesAfter: 0 };
      // Let go only once the test has chosen the language; if that never happens the test times out.
      await released;
      state.heldSettingsRead.released = true;
      return { ...answer, uiLocale: null };
    });
    // The renderer saves the shortcuts once it has taken up that first answer: proof the late answer was handled.
    handlers.set("settings:set-command-config", async (...args: unknown[]) => {
      if (state.heldSettingsRead?.released) state.heldSettingsRead.commandSavesAfter++;
      return saveCommands(...args);
    });
  }, holdInit);
}

test("Japanese chosen on an English system stays Japanese after reloads and restarts, even when chosen while the first settings read is under way", async () => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-ui-locale-"));
  try {
    let app = await electron.launch({ args: LAUNCH_ARGS, cwd: APP_ROOT, env: launchEnv(profile) });
    try {
      const page = await open(app);
      // The renderer would fall back to English: losing the choice below shows as English.
      expect(await page.evaluate(() => navigator.language)).toMatch(/^en/);
      // The first launch has written the detected English to the settings file; the race is left to the gated part below.
      await expect.poll(() => page.evaluate(async () => (await window.desktopAPI!.settings!.get()).uiLocale)).toBe("en");
      // Japanese is chosen.
      await page.evaluate(async () => {
        localStorage.setItem("sigma-studio:ui-locale", "ja");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
      });
      for (let round = 0; round < 3; round++) {
        await page.reload();
        await expectJapanese(page);
      }

      // Make the race certain, as on a first launch: English on screen, the renderer's first read of the settings is
      // answered as from a file without a language yet, and that answer is held back while Japanese is chosen.
      // The late answer must not put English back.
      await page.evaluate(async () => {
        await window.desktopAPI!.settings!.setUiLocale!("en");
        localStorage.setItem("sigma-studio:ui-locale", "en");
      });
      await holdSettingsReads(app);
      await page.reload();
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldSettingsRead?: unknown }).heldSettingsRead ?? null))
        .toEqual({ released: false, commandSavesAfter: 0 });
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      // Japanese is chosen meanwhile the way the Electron specs seed it before a reload: written to the settings
      // file and to this window's storage directly, without the running screen being told. This is what raced the
      // late first read in CI and left the app English after the reload.
      await page.evaluate(async () => {
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        localStorage.setItem("sigma-studio:ui-locale", "ja");
      });
      await app.evaluate(() => (globalThis as unknown as { releaseSettingsRead: () => void }).releaseSettingsRead());
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldSettingsRead: { commandSavesAfter: number } }).heldSettingsRead.commandSavesAfter))
        .toBeGreaterThan(0);
      // The late answer (no language yet) does not put English back into either store.
      expect(await page.evaluate(() => localStorage.getItem("sigma-studio:ui-locale"))).toBe("ja");
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
      // The running screen follows the newer choice right away, without waiting for a reload.
      await expectJapanese(page);
      await page.reload();
      await expectJapanese(page);
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");

      // Again, but Japanese reaches only the settings file (as the language setting of another window would): the
      // late answer, which says "no language yet", must not write this window's English over it.
      await page.evaluate(async () => {
        await window.desktopAPI!.settings!.setUiLocale!("en");
        localStorage.setItem("sigma-studio:ui-locale", "en");
      });
      await holdSettingsReads(app);
      await page.reload();
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldSettingsRead?: unknown }).heldSettingsRead ?? null))
        .toEqual({ released: false, commandSavesAfter: 0 });
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      expect((await page.evaluate(() => window.desktopAPI!.settings!.setUiLocale!("ja"))).ok).toBe(true);
      await app.evaluate(() => (globalThis as unknown as { releaseSettingsRead: () => void }).releaseSettingsRead());
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldSettingsRead: { commandSavesAfter: number } }).heldSettingsRead.commandSavesAfter))
        .toBeGreaterThan(0);
      await expectJapanese(page);
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
      await page.reload();
      await expectJapanese(page);

      // And once more with the reply about the first-launch language late: English is what the settings file held
      // when it was asked, Japanese is chosen before the reply arrives, and the reply must not switch back.
      await page.evaluate(async () => {
        await window.desktopAPI!.settings!.setUiLocale!("en");
        localStorage.setItem("sigma-studio:ui-locale", "en");
      });
      await holdSettingsReads(app, true);
      await page.reload();
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldSettingsRead?: unknown }).heldSettingsRead ?? null))
        .toEqual({ released: false, commandSavesAfter: 0 });
      await app.evaluate(() => (globalThis as unknown as { releaseSettingsRead: () => void }).releaseSettingsRead());
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldInit: { pending: boolean } }).heldInit.pending)).toBe(true);
      // Chosen the way the settings dialog does it: both stores, and the running screen is told.
      await page.evaluate(async () => {
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        localStorage.setItem("sigma-studio:ui-locale", "ja");
        window.dispatchEvent(new CustomEvent("sigma-studio:ui-locale-change"));
      });
      await expectJapanese(page);
      await app.evaluate(() => (globalThis as unknown as { heldInit: { release: () => void } }).heldInit.release());
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldSettingsRead: { commandSavesAfter: number } }).heldSettingsRead.commandSavesAfter))
        .toBeGreaterThan(0);
      // Give the late reply its turn in the renderer before looking.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
      expect(await page.evaluate(() => localStorage.getItem("sigma-studio:ui-locale"))).toBe("ja");
      await expectJapanese(page);
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
      await page.reload();
      await expectJapanese(page);

      // The window's own copy says English; the settings file, which is the one that counts, says Japanese.
      await page.evaluate(() => localStorage.setItem("sigma-studio:ui-locale", "en"));
    } finally { await close(app); }

    // A real restart with the same profile takes the language from the settings file.
    app = await electron.launch({ args: LAUNCH_ARGS, cwd: APP_ROOT, env: launchEnv(profile) });
    try {
      const page = await open(app);
      await expectJapanese(page);
      expect(await page.evaluate(() => localStorage.getItem("sigma-studio:ui-locale"))).toBe("ja");
      expect((await page.evaluate(() => window.desktopAPI!.settings!.get())).uiLocale).toBe("ja");
    } finally { await close(app); }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
