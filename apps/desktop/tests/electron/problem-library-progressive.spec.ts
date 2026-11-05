import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Control remote responses at IPC; exercise the real preload, renderer and dialog. */
test("library pages remain usable while counts are pending or fail", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const appRoot = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-library-progressive-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  env.SIGMA_COLLABORATION_URL = ""; env.SIGMA_SUPABASE_URL = ""; env.SIGMA_SUPABASE_ANON_KEY = "";
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  else delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  const app = await electron.launch({ args: [appRoot], cwd: appRoot, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.problems?.library?.searchPage));
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers;
      if (!handlers.has("problems:library-page") || !handlers.has("problems:library-counts")) throw new Error("Missing real handler");
      const state = { pending: [] as Array<(value: unknown) => void>, failCounts: false, countCalls: 0 };
      (globalThis as unknown as { progressiveFixture: typeof state }).progressiveFixture = state;
      ipcMain.removeHandler("problems:search");
      ipcMain.handle("problems:search", () => ({ ok: true, search: { ok: true, results: [] } }));
      ipcMain.removeHandler("problems:library-access");
      ipcMain.handle("problems:library-access", () => ({ available: true, label: "Example library" }));
      ipcMain.removeHandler("problems:library-facets");
      ipcMain.handle("problems:library-facets", () => ({ ok: true, facets: [{ key: "db|unit|algebra", group: "db", type: "unit", label: "Algebra", count: 25, hasChildren: false }] }));
      ipcMain.removeHandler("problems:library-page");
      ipcMain.handle("problems:library-page", (_event, request: { offset?: number; limit?: number }) => {
        const offset = request.offset ?? 0, limit = request.limit ?? 20;
        return { ok: true, page: { hasMore: offset + limit < 25, results: Array.from({ length: Math.min(limit, 25 - offset) }, (_, i) => ({
          id: `lib_${offset + i}`, title: `Example problem ${offset + i}`, has_solution: false, tags: [],
          preview: [{ type: "paragraph", id: `p_${i}`, children: [{ type: "text", text: "Find the value of x." }] }],
        })) } };
      });
      ipcMain.removeHandler("problems:library-counts");
      ipcMain.handle("problems:library-counts", () => {
        state.countCalls++;
        return state.failCounts ? { ok: false, error: "counts unavailable" } : new Promise(resolve => state.pending.push(resolve));
      });
    });
    await page.evaluate(async () => { await window.desktopAPI!.settings!.setUiLocale!("ja"); });
    await expect(page.locator(".text-flow-editor").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.getByRole("button", { name: "問題", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "問題ライブラリ" });
    await dialog.getByRole("radio", { name: "Example library", exact: true }).click();
    await expect(dialog.locator("article")).toHaveCount(24);
    await expect(dialog.getByText("件数を集計中…").first()).toBeVisible();
    await expect(dialog.locator('[data-facet-key="db|unit|algebra"]')).not.toHaveAttribute("data-empty", "true");
    const calls = await app.evaluate(() => (globalThis as unknown as { progressiveFixture: { countCalls: number } }).progressiveFixture.countCalls);
    await dialog.getByRole("button", { name: "もっと見る", exact: true }).click();
    await expect(dialog.locator("article")).toHaveCount(25);
    expect(await app.evaluate(() => (globalThis as unknown as { progressiveFixture: { countCalls: number } }).progressiveFixture.countCalls)).toBe(calls);
    await expect(dialog.locator("article").first().getByRole("button", { name: /^取り込む/ })).toBeEnabled();
    await dialog.getByText("件数を集計中…").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("results-before-counts.png") });
    await app.evaluate(() => {
      const state = (globalThis as unknown as { progressiveFixture: { pending: Array<(value: unknown) => void>; failCounts: boolean } }).progressiveFixture;
      state.pending.forEach(resolve => resolve({ ok: true, counts: { total: 25, facetCounts: { "db|unit|algebra": 25 } } }));
      state.failCounts = true;
    });
    await expect(dialog.getByText("25件中 25件を表示")).toBeVisible();
    await dialog.getByRole("searchbox").fill("algebra");
    await dialog.getByRole("searchbox").press("Enter");
    await expect(dialog.getByText("件数を取得できませんでした。問題は選択できます。")).toBeVisible();
    await expect(dialog.locator("article")).toHaveCount(24);
    await expect(dialog.locator("article").first().getByRole("button", { name: /^取り込む/ })).toBeEnabled();
    await dialog.getByText("件数を取得できませんでした。問題は選択できます。").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("count-failure-keeps-results.png") });
  } finally {
    await app.close(); await rm(profile, { recursive: true, force: true });
  }
});
