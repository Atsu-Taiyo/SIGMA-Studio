import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("search spans workspaces and shared links open the specific file or folder", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-search-links-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fixture = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const firstId = initial.overview.activeWorkspaceId;
      await api.createDocument({ workspaceId: firstId, title: "横断テスト A" });
      const next = await api.createWorkspace("検索先 B");
      if (next.state !== "ready") throw new Error("No workspace");
      const secondId = next.overview.activeWorkspaceId;
      const folder = await api.createFolder(secondId, "横断テストフォルダ");
      if (folder.state !== "ready") throw new Error("No folder");
      const folderId = folder.overview.folders[0].id;
      const file = await api.createDocument({ workspaceId: secondId, folderId, title: "横断テスト B" });
      await api.getWorkspaceOverview(firstId);
      return { firstId, secondId, folderId, fileId: file.file.fileId };
    });
    const workspaceUrl = new URL(page.url());
    workspaceUrl.pathname = env.SIGMA_STUDIO_DEV_SERVER_URL ? "/workspace" : workspaceUrl.pathname.replace(/index\.html$/, "workspace.html");
    workspaceUrl.searchParams.set("workspaceId", fixture.firstId);
    await page.goto(workspaceUrl.href);
    const search = page.getByPlaceholder("すべてのワークスペースを検索", { exact: true });
    await search.fill("横断テスト");
    const remoteFile = page.locator(`[data-item-key="file:${fixture.fileId}"]`);
    const remoteFolder = page.locator(`[data-item-key="folder:${fixture.folderId}"]`);
    await expect(remoteFile).toBeVisible(); await expect(remoteFolder).toBeVisible();
    await expect(remoteFile).toContainText("検索先 B");
    await expect(remoteFolder).toContainText("検索先 B");
    const active = await page.evaluate(() => window.desktopAPI!.storage.getWorkspaceOverview());
    expect(active.state === "ready" && active.overview.activeWorkspaceId).toBe(fixture.firstId);
    await page.screenshot({ path: testInfo.outputPath("search-all-workspaces.png") });
    await remoteFolder.dblclick();
    await expect(search).toHaveValue(""); await expect(remoteFile).toBeVisible();
    const afterFolder = await page.evaluate(() => window.desktopAPI!.storage.getWorkspaceOverview());
    expect(afterFolder.state === "ready" && afterFolder.overview.activeWorkspaceId).toBe(fixture.secondId);
    await page.reload(); await search.fill("横断テスト"); await expect(remoteFile).toBeVisible();
    await remoteFile.dblclick();
    await expect(page).toHaveURL(new RegExp(`fileId=${fixture.fileId}`));
    await expect(page.locator(".tiptap").first()).toBeVisible({ timeout: 60_000 });

    // Replace only the remote auth/catalog responses. OS events, main queue,
    // preload, dialogs, real local storage and page navigation remain real.
    await app.evaluate(({ ipcMain }, data) => {
      ipcMain.removeHandler("collaboration:info");
      ipcMain.handle("collaboration:info", () => ({ configured: true, user: { actorId: "test" }, sessions: [], restrictedFileIds: [] }));
      ipcMain.removeHandler("shared-catalog:refresh");
      ipcMain.handle("shared-catalog:refresh", () => ({ state: "ready", actorId: "test", revision: 1 }));
      ipcMain.removeHandler("shared-catalog:open-link");
      ipcMain.handle("shared-catalog:open-link", (_event, target) => {
        if (target.catalogNodeId !== "12345678-1234-4234-8234-123456789012") throw new Error("TARGET_UNAVAILABLE");
        return { target, workspaceId: data.secondId, ...(target.kind === "document" ? { fileId: data.fileId } : { folderId: data.folderId }) };
      });
    }, fixture);
    await app.evaluate(({ app }) => app.emit("open-url", { preventDefault() {} }, "sigma-studio://share/folder/12345678-1234-4234-8234-123456789012"));
    await expect(page).toHaveURL(new RegExp(`folderId=${fixture.folderId}`));
    await expect(remoteFile).toBeVisible();
    await page.reload(); await expect(remoteFile).toBeVisible();
    expect(await page.evaluate(() => window.desktopAPI!.shareLinks!.pending())).toBeNull();
    await app.evaluate(({ app }) => app.emit("second-instance", {}, ["app", "sigma-studio://share/document/12345678-1234-4234-8234-123456789012"], process.cwd(), {}));
    await expect(page).toHaveURL(new RegExp(`fileId=${fixture.fileId}`));
    await expect(page.locator(".tiptap").first()).toBeVisible({ timeout: 60_000 });
    await app.evaluate(({ app }) => app.emit("open-url", { preventDefault() {} }, "sigma-studio://share/folder/00000000-0000-4000-8000-000000000000"));
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("tab", { name: "横断テスト B", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
