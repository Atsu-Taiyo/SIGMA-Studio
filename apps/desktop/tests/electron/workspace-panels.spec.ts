import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ME = { actorId: "actor-me", email: "me@example.test", displayName: "山田 太郎" };

/**
 * Only the identity answers are replaced (who is signed in, and that a shared catalog exists); storage,
 * preload, navigation and the editor are real. `_invokeHandlers` is Electron's own handler table: it is
 * the only way to keep the real overview handler and add the catalog status on top of it.
 */
async function signInAs(app: ElectronApplication, user: typeof ME) {
  await app.evaluate(({ ipcMain }, me) => {
    const channel = "storage:get-workspace-overview";
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ state: string; overview: Record<string, unknown> }>> })._invokeHandlers.get(channel)!;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const result = await original(event, ...args);
      if (result?.state === "ready") result.overview.catalog = { state: "ready", actorId: me.actorId, revision: 1 };
      return result;
    });
    ipcMain.removeHandler("collaboration:info");
    ipcMain.handle("collaboration:info", () => ({ configured: true, user: me, sessions: [], restrictedFileIds: [] }));
    ipcMain.removeHandler("shared-catalog:refresh");
    ipcMain.handle("shared-catalog:refresh", () => ({ state: "ready", actorId: me.actorId, revision: 1 }));
  }, user);
}

function workspaceUrl(page: Page, workspaceId: string, devServer: boolean) {
  const url = new URL(page.url());
  url.pathname = devServer ? "/workspace" : url.pathname.replace(/index\.html$/, "workspace.html");
  url.search = "";
  url.searchParams.set("workspaceId", workspaceId);
  return url.href;
}

test("comment list, bookmarks and the collapsible sidebar work in the real app", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-workspace-panels-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fixture = await page.evaluate(async (me) => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const workspaceId = initial.overview.activeWorkspaceId;
      const folder = await api.createFolder(workspaceId, "数学");
      if (folder.state !== "ready") throw new Error("No folder");
      const folderId = folder.overview.folders[0].id;
      const at = (day: number) => new Date(Date.UTC(2026, 8, day, 3)).toISOString();
      const text = (value: string, mentionUserId?: string) => ({ type: "text" as const, text: value, ...(mentionUserId ? { mentionUserId } : {}) });
      async function makeDocument(title: string, parent: string | null, threads: (blockId: string) => unknown[]) {
        const created = await api.createDocument({ workspaceId, folderId: parent, title });
        const document = await api.loadDocument(created.file.fileId);
        if (!document) throw new Error("No document");
        (document as { comments?: unknown[] }).comments = threads(document.content[0].id);
        await api.saveDocument(created.file.fileId, document, { expectedRevision: created.file.revision });
        return created.file.fileId;
      }
      const mentioned = await makeDocument("方程式の確認", folderId, (blockId) => [
        { id: "thread_mention", anchor: { type: "block", blockId, quote: "2x + 3 = 11" }, createdAt: at(20), messages: [
          { id: "m1", authorName: "佐藤 花子", createdAt: at(20), body: [text("ここ、"), text("@山田 太郎", me.actorId), text(" さんに確認してほしいです")] },
          { id: "m2", authorName: "田中", createdAt: at(21), body: [text("私も気になります")] },
        ] },
        { id: "thread_resolved", anchor: { type: "block", blockId, quote: "解決済み" }, resolved: true, createdAt: at(10), messages: [
          { id: "m3", authorName: "佐藤 花子", createdAt: at(10), body: [text("@山田 太郎", me.actorId)] },
        ] },
      ]);
      const authored = await makeDocument("図形の証明", null, (blockId) => [
        { id: "thread_mine", anchor: { type: "block", blockId, quote: "△ABC ≡ △DEF" }, createdAt: at(18), messages: [
          { id: "m4", authorName: "山田 太郎", createdAt: at(18), body: [text("この合同条件で合っていますか？")] },
          { id: "m5", authorName: "佐藤 花子", createdAt: at(19), body: [text("大丈夫です")] },
        ] },
        { id: "thread_other", anchor: { type: "block", blockId, quote: "無関係" }, createdAt: at(17), messages: [
          { id: "m6", authorName: "鈴木", createdAt: at(17), body: [text("別の人同士の会話")] },
        ] },
      ]);
      return { workspaceId, folderId, mentioned, authored };
    }, ME);
    await signInAs(app, ME);
    const devServer = Boolean(env.SIGMA_STUDIO_DEV_SERVER_URL);
    await page.goto(workspaceUrl(page, fixture.workspaceId, devServer));

    // コメント一覧: 自分宛てのメンションと自分が書いたスレッドだけ。解決済みと無関係なものは出ない。
    const panels = page.locator(".workspace-nav-panels");
    await expect(panels.getByRole("button", { name: "コメント (自分宛て 1 件)" })).toContainText("@1");
    await panels.getByRole("button", { name: /コメント/ }).click();
    const threads = page.locator(".workspace-comment-item");
    await expect(threads).toHaveCount(2);
    await expect(threads.nth(0)).toHaveAttribute("data-comment-thread-id", "thread_mention");
    await expect(threads.nth(1)).toHaveAttribute("data-comment-thread-id", "thread_mine");
    await page.getByRole("button", { name: "メンション", exact: true }).click();
    await expect(threads).toHaveCount(1);
    await page.getByRole("button", { name: "すべて", exact: true }).click();
    await page.getByLabel("解決済みを含める").check();
    await expect(threads).toHaveCount(3);
    await page.getByLabel("解決済みを含める").uncheck();

    // 走査結果はユーザーごとに端末へ残り、次に開いたときは読み直しを待たずに出せる。
    const scanKey = `sigma-studio:workspace-comment-scan:v1:${ME.actorId}`;
    await expect.poll(() => page.evaluate(
      (key) => Object.keys(JSON.parse(window.localStorage.getItem(key) ?? "{}")).length,
      scanKey,
    )).toBeGreaterThanOrEqual(3);

    // スレッドへ直接開く。URL の指定は消費され、コメント欄がそのスレッドを示す。
    await threads.nth(0).click();
    await expect(page).toHaveURL(new RegExp(`fileId=${fixture.mentioned}`));
    await expect(page.locator(".tiptap").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("さんに確認してほしいです")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => new URL(page.url()).searchParams.has("commentThreadId")).toBe(false);

    // ブックマーク: 付ける・再読み込みしても残る・一覧に出る・フォルダへ移動する・外す。
    await page.goto(workspaceUrl(page, fixture.workspaceId, devServer));
    const fileCard = page.locator(`[data-item-key="file:${fixture.authored}"]`);
    await fileCard.hover();
    await fileCard.getByRole("button", { name: "図形の証明 をブックマークに追加" }).click();
    const folderCard = page.locator(`[data-item-key="folder:${fixture.folderId}"]`);
    await folderCard.hover();
    await folderCard.getByRole("button", { name: "数学 をブックマークに追加" }).click();
    await expect(page.locator(".workspace-file-card.selected, .workspace-folder-card.selected")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(`[data-item-key="file:${fixture.authored}"]`).getByRole("button", { name: "図形の証明 のブックマークを外す" })).toHaveAttribute("aria-pressed", "true");
    await page.locator(".workspace-nav-panels").getByRole("button", { name: "ブックマーク" }).click();
    const rows = page.locator(".workspace-bookmark-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("数学");
    await expect(rows.nth(1)).toContainText("図形の証明");
    await page.getByRole("button", { name: "数学 を開く" }).click();
    await expect(page.locator(`[data-item-key="file:${fixture.mentioned}"]`)).toBeVisible();
    await expect(page.locator(".workspace-breadcrumb")).toContainText("数学");
    await page.locator(".workspace-nav-panels").getByRole("button", { name: "ブックマーク" }).click();
    await page.getByRole("button", { name: "数学 のブックマークを外す" }).click();
    await expect(rows).toHaveCount(1);
    await page.reload();
    await page.locator(".workspace-nav-panels").getByRole("button", { name: "ブックマーク" }).click();
    await expect(rows).toHaveCount(1);

    // サイドバー: アイコン列へ畳め、再読み込みしても保たれ、畳んだままコメントを開ける。
    await page.getByRole("button", { name: "サイドバーを閉じる" }).click();
    await expect.poll(() => page.locator(".workspace-sidebar").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBeLessThanOrEqual(70);
    await expect(page.locator('nav[aria-label="ワークスペース一覧"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".workspace-page-main")).toHaveAttribute("data-sidebar", "collapsed");
    await page.getByRole("button", { name: "コメント (自分宛て 1 件)" }).click();
    await expect(threads).toHaveCount(2);
    await page.getByRole("button", { name: "サイドバーを開く" }).click();
    await expect.poll(() => page.locator(".workspace-sidebar").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBeGreaterThan(200);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
