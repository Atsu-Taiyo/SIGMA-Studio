import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 題名と本文を持つ教材を作る (実際の保存経路を通す)。 */
async function createMaterial(page: Page, workspaceId: string, title: string, paragraphs: string[]): Promise<string> {
  return page.evaluate(async ({ workspaceId, title, paragraphs }) => {
    const api = window.desktopAPI!.storage;
    const created = await api.createDocument({ workspaceId, title });
    const loaded = await api.loadDocumentWithRecovery!(created.file.fileId);
    if (!loaded.ok) throw new Error("load failed");
    const saved = await api.saveDocument(created.file.fileId, {
      ...loaded.document,
      content: paragraphs.map((text, index) => ({ type: "paragraph", id: `p_${index}`, children: [{ type: "text", text }] })),
    }, { expectedRevision: loaded.revision });
    if (!saved.ok) throw new Error("save failed");
    return created.file.fileId;
  }, { workspaceId, title, paragraphs });
}

async function rewriteBody(page: Page, fileId: string, text: string): Promise<void> {
  await page.evaluate(async ({ fileId, text }) => {
    const api = window.desktopAPI!.storage;
    const loaded = await api.loadDocumentWithRecovery!(fileId);
    if (!loaded.ok) throw new Error("load failed");
    const saved = await api.saveDocument(fileId, {
      ...loaded.document,
      content: [{ type: "paragraph", id: "p_0", children: [{ type: "text", text }] }],
    }, { expectedRevision: loaded.revision });
    if (!saved.ok) throw new Error("save failed");
  }, { fileId, text });
}

test("workspace search finds titles at once and streams body matches across workspaces as they are read", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-body-search-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fixture = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const next = await api.createWorkspace("本文検索先");
      if (next.state !== "ready") throw new Error("No workspace");
      await api.getWorkspaceOverview(initial.overview.activeWorkspaceId);
      return { firstId: initial.overview.activeWorkspaceId, secondId: next.overview.activeWorkspaceId };
    });
    const titleHit = await createMaterial(page, fixture.firstId, "三角比の演習", ["sinとcosの値"]);
    const unrelated = await createMaterial(page, fixture.firstId, "無関係な教材", ["関係ない内容"]);
    const bodyHit = await createMaterial(page, fixture.secondId, "週末課題", ["第1問", "加法定理を使って三角関数の値を求めよ。"]);

    // 本文検索の答えを遅らせ、題名の結果が本文を待たずに出ることを確かめる。
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("workspace-search:query")!;
      (globalThis as { restoreBodySearch?: () => void }).restoreBodySearch = () => handlers.set("workspace-search:query", original);
      handlers.set("workspace-search:query", async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return original(...args);
      });
    });

    const workspaceUrl = new URL(page.url());
    workspaceUrl.pathname = env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : workspaceUrl.pathname.replace(/index\.html$/, "workspace.html");
    workspaceUrl.searchParams.set("workspaceId", fixture.firstId);
    await page.goto(workspaceUrl.href);
    const search = page.getByPlaceholder("すべてのワークスペースを検索", { exact: true });
    const titleCard = page.locator(`[data-item-key="file:${titleHit}"]`);
    const bodyCard = page.locator(`[data-item-key="file:${bodyHit}"]`);
    const unrelatedCard = page.locator(`[data-item-key="file:${unrelated}"]`);
    await expect(unrelatedCard).toBeVisible();

    await search.fill("三角");
    await expect(titleCard).toBeVisible({ timeout: 1000 });
    const progress = page.locator(".workspace-body-search-progress");
    await expect(progress).toHaveText("本文も検索中…");
    await expect(bodyCard).toBeHidden();
    await expect(unrelatedCard).toBeHidden();
    // 索引からすぐ答えが返るときに一瞬だけ出ないよう、少し遅れて現れる。
    await expect(progress).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("body-search-pending.png") });

    await expect(bodyCard).toBeVisible();
    await expect(progress).toHaveCount(0);
    await expect(bodyCard.locator(".workspace-search-excerpt mark")).toHaveText("三角");
    await expect(bodyCard.locator(".workspace-search-excerpt")).toContainText("加法定理を使って三角関数の値を求めよ。");
    await expect(bodyCard).toContainText("本文検索先");
    await expect(titleCard.locator(".workspace-search-excerpt")).toHaveCount(0);
    // 題名の一致が先、本文の一致は後ろにまとまる。
    const order = await page.locator("[data-item-key^='file:']").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-item-key")));
    expect(order).toEqual([`file:${titleHit}`, `file:${bodyHit}`]);
    await page.screenshot({ path: testInfo.outputPath("body-search-grid.png") });
    await app.evaluate(() => (globalThis as { restoreBodySearch?: () => void }).restoreBodySearch?.());

    // 語を足すと、題名だけの一致は外れ、本文の一致は残る。
    await search.fill("三角関数");
    await expect(titleCard).toBeHidden();
    await expect(bodyCard).toBeVisible();
    await page.getByRole("button", { name: "リスト表示", exact: true }).click();
    const bodyRow = page.locator(`tr[data-item-key="file:${bodyHit}"]`);
    await expect(bodyRow.locator(".workspace-search-excerpt mark")).toHaveText("三角関数");
    await page.screenshot({ path: testInfo.outputPath("body-search-list.png") });

    // 検索を開いたまま本文を書き換えたら、打ち直さなくても読み直した本文で答え直す。
    await rewriteBody(page, bodyHit, "二次関数の最大値");
    await expect(bodyRow).toBeHidden();
    await expect(page.locator(".workspace-empty-state")).toBeVisible();
    await search.fill("");
    await search.fill("三角関数");
    await expect(page.locator(".workspace-empty-state")).toBeVisible();
    await search.fill("最大値");
    await expect(bodyRow.locator(".workspace-search-excerpt mark")).toHaveText("最大値");

    // 本文で一致した教材も、ダブルクリックでそのまま開ける。
    await search.fill("");
    await expect(unrelatedCard).toBeVisible();
    // 本文の文字列は束ねた置き場に残り、次の起動でも使う。
    const indexed = await readdir(path.join(profile, "workspace-search-index"));
    expect(indexed.filter((name) => name.endsWith(".tsv")).length).toBeGreaterThan(0);

    // 再読み込みしても、端末に残した索引からすぐ答える。
    await page.reload();
    await search.fill("関係ない");
    await expect(unrelatedCard.locator(".workspace-search-excerpt mark")).toHaveText("関係ない", { timeout: 3000 });
    await search.fill("最大値");
    await bodyRow.dblclick();
    await expect(page).toHaveURL(new RegExp(`fileId=${bodyHit}`));
    await expect(page.locator(".tiptap").first()).toBeVisible({ timeout: 60_000 });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("workspace search displays cached images without generating thumbnails until the search field loses focus", async () => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-search-previews-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app = await electron.launch({ args: [root], cwd: root, env });
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const workspaces = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      const other = await api.createWorkspace("別のワークスペース");
      if (initial.state !== "ready" || other.state !== "ready") throw new Error("No library");
      await api.getWorkspaceOverview(initial.overview.activeWorkspaceId);
      return { initial: initial.overview.activeWorkspaceId, other: other.overview.activeWorkspaceId };
    });
    const cachedId = await createMaterial(page, workspaces.initial, "検索対象・画像あり", ["本文"]);
    const uncachedId = await createMaterial(page, workspaces.other, "検索対象・画像なし", ["画像化する本文"]);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.evaluate(async ({ fileId, png }) => {
      const loaded = await window.desktopAPI!.storage.loadDocumentWithRecovery!(fileId);
      if (!loaded.ok) throw new Error("load failed");
      await window.desktopAPI!.workspacePreview!.put(fileId, loaded.revision, png);
    }, { fileId: cachedId, png });

    const observeBodyReads = async () => {
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const load = handlers.get("storage:load-document")!;
        const state = globalThis as { previewBodyReads?: string[] };
        state.previewBodyReads = [];
        handlers.set("storage:load-document", (...args) => {
          state.previewBodyReads!.push(args[1] as string);
          return load(...args);
        });
      });
    };
    const openSearch = async () => {
      const url = new URL(page.url());
      url.pathname = env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : url.pathname.replace(/index\.html$/, "workspace.html");
      url.search = new URLSearchParams({ workspaceId: workspaces.initial }).toString();
      await page.goto(url.href);
      const search = page.getByPlaceholder("すべてのワークスペースを検索", { exact: true });
      await expect(page.locator(`[data-item-key="file:${cachedId}"]`).getByTestId("workspace-file-preview-image")).toBeVisible();
      await search.focus();
      await app.evaluate(() => { (globalThis as { previewBodyReads?: string[] }).previewBodyReads = []; });
      await search.fill("検索対象");
      await expect(page.locator(`[data-item-key="file:${uncachedId}"]`)).toBeVisible();
      await expect(page.locator(".workspace-body-search-progress")).toHaveCount(0);
      return search;
    };
    await observeBodyReads();
    const search = await openSearch();
    const cachedCard = page.locator(`[data-item-key="file:${cachedId}"]`);
    const uncachedCard = page.locator(`[data-item-key="file:${uncachedId}"]`);
    await expect(cachedCard.getByTestId("workspace-file-preview-image")).toHaveAttribute("src", png);
    // Wait past the typing debounce, the completed body search and thumbnail settling.
    // Cached images still show, while missing images must not start a page canvas.
    await page.waitForTimeout(2000);
    await expect(search).toBeFocused();
    expect(await app.evaluate(() => (globalThis as { previewBodyReads?: string[] }).previewBodyReads)).toEqual([]);
    await expect(page.locator(".paged-thumbnail-host")).toHaveCount(0);
    await expect(uncachedCard.getByTestId("workspace-file-preview-image")).toHaveCount(0);

    await search.press("Tab");
    await expect(uncachedCard.getByTestId("workspace-file-preview-image")).toBeVisible({ timeout: 60_000 });
    expect(await app.evaluate(() => (globalThis as { previewBodyReads?: string[] }).previewBodyReads)).toEqual([uncachedId]);
    const generatedPng = await uncachedCard.getByTestId("workspace-file-preview-image").getAttribute("src");
    await expect.poll(async () => (await readdir(path.join(profile, "workspace-previews"))).length).toBe(2);

    // Restart the real app: the generated image must survive and bypass document loading.
    await app.close();
    app = await electron.launch({ args: [root], cwd: root, env });
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await observeBodyReads();
    await openSearch();
    await expect(page.locator(`[data-item-key="file:${uncachedId}"]`).getByTestId("workspace-file-preview-image")).toHaveAttribute("src", generatedPng!);
    expect(await app.evaluate(() => (globalThis as { previewBodyReads?: string[] }).previewBodyReads)).toEqual([]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
