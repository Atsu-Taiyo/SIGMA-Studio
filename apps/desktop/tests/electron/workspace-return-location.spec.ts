import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 編集画面からワークスペース画面へ戻ると、編集中の教材のワークスペースではなく
 * 直前までワークスペース画面で選んでいたワークスペースが開く。開いている教材を
 * 削除したときも、別の教材へ切り替えずにそのワークスペースへ戻る。
 */
test("returns from the editor to the workspace that was last selected, including after deleting the open material", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-workspace-return-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.addInitScript(() => {
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:ui-locale", "ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });
    const fixture = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const homeId = initial.overview.activeWorkspaceId;
      const home = await api.createDocument({ workspaceId: homeId, title: "ホームの教材" });
      const created = await api.createWorkspace("戻り先テスト");
      if (created.state !== "ready") throw new Error("No workspace");
      const targetId = created.overview.workspaces.find(w => w.name === "戻り先テスト")!.id;
      const first = await api.createDocument({ workspaceId: targetId, title: "消す教材" });
      const second = await api.createDocument({ workspaceId: targetId, title: "残る教材" });
      // 編集画面は「ホームの教材」を開いた状態から始める (戻り先が編集中の教材に引っ張られる条件)。
      await api.saveWorkspace({ openFileIds: [home.file.fileId], activeFileId: home.file.fileId });
      return { homeId, targetId, home: home.file.fileId, first: first.file.fileId, second: second.file.fileId };
    });
    const workspaceUrl = new URL(page.url());
    workspaceUrl.pathname = process.env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : workspaceUrl.pathname.replace(/index\.html$/, "workspace.html");
    workspaceUrl.search = "";
    await page.goto(workspaceUrl.href);
    await expect(page.locator(".workspace-nav-item", { hasText: "戻り先テスト" })).toBeVisible({ timeout: 30_000 });

    const shownWorkspaceId = () => page.evaluate(() => new URL(window.location.href).searchParams.get("workspaceId"));
    const openFromWorkspace = async (fileId: string) => {
      await page.locator(`[data-item-key="file:${fileId}"]`).dblclick();
      await page.waitForURL(url => !/\/workspace(?:\.html)?\/?$/.test(url.pathname), { timeout: 30_000 });
      await expect(page.getByRole("textbox", { name: "教材タイトル" })).toBeVisible({ timeout: 60_000 });
    };
    const expectWorkspaceScreen = async (page: Page, workspaceId: string) => {
      await page.waitForURL(url => /\/workspace(?:\.html)?\/?$/.test(url.pathname), { timeout: 30_000 });
      await expect(page.locator(".workspace-nav-item.active", { hasText: "戻り先テスト" })).toBeVisible({ timeout: 30_000 });
      await expect.poll(shownWorkspaceId).toBe(workspaceId);
    };

    // 1. ワークスペース画面で「戻り先テスト」を選び、その中の教材を開く。
    await page.locator(".workspace-nav-item", { hasText: "戻り先テスト" }).click();
    await expect.poll(shownWorkspaceId).toBe(fixture.targetId);
    await openFromWorkspace(fixture.first);

    // 2. 開いている教材を削除すると、ホームの教材へ切り替わらずに選んでいたワークスペースへ戻る。
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "現在の教材を削除" }).click();
    await expectWorkspaceScreen(page, fixture.targetId);
    await page.screenshot({ path: testInfo.outputPath("after-delete.png") });
    await expect(page.locator(`[data-item-key="file:${fixture.first}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-item-key="file:${fixture.second}"]`)).toBeVisible();
    const afterDelete = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    expect((afterDelete as { fileId: string }[]).map(file => file.fileId)).not.toContain(fixture.first);
    // ホームの教材のタブが残っているので、戻るボタンが出る。
    await expect(page.getByRole("button", { name: "編集画面に戻る", exact: true })).toBeVisible();

    // 3. 残る教材を開き、編集画面で別のワークスペースの教材のタブへ移ってからワークスペースボタンで戻る。
    await openFromWorkspace(fixture.second);
    await page.locator(".document-tabs-row").getByText("ホームの教材").click();
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("ホームの教材");
    await page.getByRole("button", { name: "ワークスペース", exact: true }).click();
    await expectWorkspaceScreen(page, fixture.targetId);
    await page.screenshot({ path: testInfo.outputPath("after-workspace-button.png") });
    // 開いている教材 (残る教材) に「編集中」が付き、開いていない教材には付かない。
    const secondCard = page.locator(`[data-item-key="file:${fixture.second}"]`);
    await expect(secondCard.locator(".workspace-open-in-editor-badge")).toHaveText("編集中");

    // 4. 「編集画面に戻る」で、開いていたタブのまま編集画面へ戻る。
    await page.getByRole("button", { name: "編集画面に戻る", exact: true }).click();
    await page.waitForURL(url => !/\/workspace(?:\.html)?\/?$/.test(url.pathname), { timeout: 30_000 });
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".document-tabs-row").getByText("残る教材")).toBeVisible();
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("deleting the only open tab returns to the workspace without a back button, and the last library material can be deleted", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-workspace-last-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.addInitScript(() => {
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      localStorage.setItem("sigma-studio:ui-locale", "ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });
    const fixture = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const workspaceId = initial.overview.activeWorkspaceId;
      const x = await api.createDocument({ workspaceId, title: "教材X" });
      const y = await api.createDocument({ workspaceId, title: "教材Y" });
      const z = await api.createDocument({ workspaceId, title: "教材Z" });
      const keep = new Set([x.file.fileId, y.file.fileId, z.file.fileId]);
      for (const file of await api.listFiles() as { fileId: string }[]) {
        if (!keep.has(file.fileId)) await api.deleteFile(file.fileId);
      }
      await api.saveWorkspace({ openFileIds: [x.file.fileId], activeFileId: x.file.fileId });
      return { x: x.file.fileId, y: y.file.fileId, z: z.file.fileId };
    });
    const title = page.getByRole("textbox", { name: "教材タイトル" });
    const tabs = page.locator(".document-tabs-row");
    const deleteOpenMaterial = async () => {
      await page.getByRole("button", { name: "ファイル", exact: true }).click();
      const item = page.getByRole("menuitem", { name: "現在の教材を削除" });
      await expect(item).toBeEnabled();
      await item.click();
      await page.waitForURL(url => /\/workspace(?:\.html)?\/?$/.test(url.pathname), { timeout: 30_000 });
      await expect(page.locator(".workspace-view-toggle")).toBeVisible({ timeout: 30_000 });
    };
    const openFromWorkspace = async (fileId: string, name: string) => {
      await page.locator(`[data-item-key="file:${fileId}"]`).dblclick();
      await expect(title).toHaveValue(name, { timeout: 60_000 });
    };
    await page.reload();
    await expect(title).toHaveValue("教材X", { timeout: 60_000 });

    // 1. 唯一のタブ (教材X) を消す → ワークスペースへ。開いている教材が無いので戻るボタンも編集中も出ない。
    await deleteOpenMaterial();
    await expect(page.locator(`[data-item-key="file:${fixture.x}"]`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "編集画面に戻る", exact: true })).toHaveCount(0);
    await expect(page.locator(".workspace-open-in-editor-badge")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("after-only-tab-delete.png") });

    // 2. 教材Zを開くと、保存処理が埋めた代わりのタブ (教材Y) は混ざらず、Zだけで始まる。
    await openFromWorkspace(fixture.z, "教材Z");
    await expect(tabs.getByText("教材Y")).toHaveCount(0);

    // 3. Zを消して、残った教材Yを開き、ライブラリ最後の1件のYも消せる。
    await deleteOpenMaterial();
    await openFromWorkspace(fixture.y, "教材Y");
    await expect(tabs.getByText("教材Z")).toHaveCount(0);
    await deleteOpenMaterial();
    await expect(page.getByRole("button", { name: "編集画面に戻る", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("after-last-library-delete.png") });
    expect(await page.evaluate(() => window.desktopAPI!.storage.listFiles())).toEqual([]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
