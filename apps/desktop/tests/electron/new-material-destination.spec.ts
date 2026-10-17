import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const PREPARED = Boolean(devUrl) || (existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) && existsSync(path.join(APP_ROOT, "out/index.html")));

type FileRow = { fileId: string; workspaceId: string; folderId: string | null };

async function launch(env: Record<string, string>) {
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
  return { app, page };
}

async function listFiles(page: Page): Promise<FileRow[]> {
  return page.evaluate(() => window.desktopAPI!.storage.listFiles()) as Promise<FileRow[]>;
}

/** `action` の後に増えた教材 1 件 (作成先の確認は、画面ではなく保存先の台帳で行う)。 */
async function createdBy(page: Page, action: () => Promise<void>): Promise<FileRow> {
  const before = new Set((await listFiles(page)).map((file) => file.fileId));
  await action();
  let created: FileRow | undefined;
  await expect.poll(async () => {
    created = (await listFiles(page)).find((file) => !before.has(file.fileId));
    return Boolean(created);
  }).toBe(true);
  return created!;
}

function createdDialog(page: Page) {
  return page.getByRole("dialog", { name: /を作成しました$/ });
}

async function expectLocation(page: Page, location: { workspace: string; folder: string; storage?: string }) {
  const dialog = createdDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-new-material-workspace]")).toHaveText(location.workspace);
  await expect(dialog.locator("[data-new-material-folder]")).toHaveText(location.folder);
  await expect(dialog.locator("[data-new-material-storage]")).toHaveText(location.storage ?? "このPC");
}

async function closeCreatedDialog(page: Page) {
  await page.keyboard.press("Escape");
  await expect(createdDialog(page)).toHaveCount(0);
}

/** 作った教材に1語打つ (何も書かずに閉じた新規教材は終了時に片付けられるので、残す教材だけ書く)。 */
async function typeIntoActiveMaterial(page: Page, fileId: string, text: string) {
  const editor = page.locator(".page-flow .ProseMirror").first();
  await editor.click();
  await page.keyboard.type(text);
  await expect.poll(() => page.evaluate(
    (id) => window.desktopAPI!.storage.loadDocument(id).then((document) => JSON.stringify(document)),
    fileId,
  ), { timeout: 30_000 }).toContain(text);
}

function workspaceUrl(page: Page, workspaceId: string, folderId: string | null) {
  const url = new URL(page.url());
  url.pathname = devUrl ? "/workspace" : url.pathname.replace(/index\.html$/, "workspace.html");
  url.search = "";
  url.searchParams.set("workspaceId", workspaceId);
  if (folderId) url.searchParams.set("folderId", folderId);
  return url.href;
}

/**
 * Issue #211: 新規教材は、そのまま押すと直前の教材と同じワークスペース (同じフォルダ) に、
 * ホバー (または ↓) で開くメニューから選ぶとそのワークスペースに作り、作った場所をダイアログで示す。
 * 保存・IPC・台帳は本物。共有の権限だけは、サーバーなしで確かめるために一覧の応答へ被せる。
 */
test("new materials follow the previous material's workspace, can be placed from the menu, and say where they went", async ({}, testInfo) => {
  test.skip(!PREPARED, "Build Electron and the static renderer first, or point SIGMA_STUDIO_E2E_BASE_URL at a dev server.");
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-new-material-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  Object.assign(env, { SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" });
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  let session: { app: ElectronApplication; page: Page } | undefined = await launch(env);
  try {
    let page = session.page;
    const fixture = await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const initial = await api.getWorkspaceOverview();
      if (initial.state !== "ready") throw new Error("No library");
      const home = initial.overview.activeWorkspaceId;
      // 既定のワークスペース名は初回起動時の OS の言語で決まるので、名前を固定する。
      await api.renameWorkspace(home, "マイ教材");
      const grade = await api.createFolder(home, "2年");
      if (grade.state !== "ready") throw new Error("No folder");
      const gradeId = grade.overview.folders.find((folder) => folder.name === "2年")!.id;
      const unit = await api.createFolder(home, "関数", gradeId);
      if (unit.state !== "ready") throw new Error("No sub-folder");
      const unitId = unit.overview.folders.find((folder) => folder.name === "関数")!.id;
      const previous = await api.createDocument({ workspaceId: home, folderId: unitId, title: "二次関数の演習" });
      const team = await api.createWorkspace("数学科");
      if (team.state !== "ready") throw new Error("No workspace");
      await api.saveWorkspace({ openFileIds: [previous.file.fileId], activeFileId: previous.file.fileId });
      return { home, unitId, team: team.overview.activeWorkspaceId, previous: previous.file.fileId };
    });
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: /二次関数の演習/ })).toBeVisible();
    const newMaterial = page.getByRole("button", { name: "新規教材", exact: true });
    const menu = page.getByRole("menu", { name: "新規教材" });

    // 1. そのまま押す → 直前の教材と同じワークスペース・同じフォルダ。ダイアログは階層ごと示す。
    const direct = await createdBy(page, () => newMaterial.click());
    expect(direct).toMatchObject({ workspaceId: fixture.home, folderId: fixture.unitId });
    await expectLocation(page, { workspace: "マイ教材", folder: "2年 / 関数" });
    await page.screenshot({ path: testInfo.outputPath("01-direct-click-dialog.png"), animations: "disabled" });
    await closeCreatedDialog(page);
    await typeIntoActiveMaterial(page, direct.fileId, "直接作成");

    // 2. ホバーで開くメニュー: 作れるワークスペースが並び、押したときの作成先に印がある。
    await newMaterial.hover();
    await expect(menu).toBeVisible();
    const home = menu.getByRole("menuitem", { name: "マイ教材に作成", exact: true });
    const team = menu.getByRole("menuitem", { name: "数学科に作成", exact: true });
    await expect(home).toHaveAttribute("data-default", "true");
    await expect(team).not.toHaveAttribute("data-default", "true");
    await page.screenshot({ path: testInfo.outputPath("02-hover-menu.png"), animations: "disabled" });
    const chosen = await createdBy(page, () => team.click());
    expect(chosen).toMatchObject({ workspaceId: fixture.team, folderId: null });
    await expectLocation(page, { workspace: "数学科", folder: "ワークスペースの直下" });
    await page.screenshot({ path: testInfo.outputPath("03-chosen-workspace-dialog.png"), animations: "disabled" });
    await closeCreatedDialog(page);
    await typeIntoActiveMaterial(page, chosen.fileId, "選んで作成");

    // 3. 直前の教材が「数学科」になったので、そのまま押すと数学科に作る。
    await page.mouse.move(700, 600);
    const inherited = await createdBy(page, () => newMaterial.click());
    expect(inherited).toMatchObject({ workspaceId: fixture.team, folderId: null });
    await expectLocation(page, { workspace: "数学科", folder: "ワークスペースの直下" });
    await closeCreatedDialog(page);

    // 4. キーボードだけで作成先を選ぶ: ↓ でメニューを開き、矢印で選んで Enter。
    await page.mouse.move(700, 600);
    await newMaterial.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "空の教材", exact: true })).toBeFocused();
    await expect(team).toHaveAttribute("data-default", "true");
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowDown");
    await expect(home).toBeFocused();
    const byKeyboard = await createdBy(page, () => page.keyboard.press("Enter"));
    expect(byKeyboard).toMatchObject({ workspaceId: fixture.home, folderId: null });
    await expectLocation(page, { workspace: "マイ教材", folder: "ワークスペースの直下" });
    await closeCreatedDialog(page);

    // 5. 直前の教材のワークスペースが読み取り専用の共有なら、選択肢から外し、そのまま押すと既定の作成先 (このPC) に作って、その旨を書く。
    //    サーバーなしで確かめるため、一覧の応答だけで「マイ教材」を閲覧だけの共有に見せる。
    await session.app.evaluate(({ ipcMain }, workspaceId) => {
      const channel = "storage:get-workspace-overview";
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ state: string; overview: { catalog?: unknown; workspaces: { id: string; sharing?: unknown }[] } }>> })._invokeHandlers;
      const original = handlers.get(channel)!;
      (globalThis as { __originalOverview?: unknown }).__originalOverview = original;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        const result = await original(event, ...args);
        if (result?.state !== "ready") return result;
        result.overview.catalog = { state: "ready", actorId: "actor-me", revision: 1 };
        const capabilities = { read: true, editDocument: false, createChildren: false, rename: false, move: false, deleteDescendants: false, invite: false, manageEditorViewer: false, appointAdmin: false, stopRootShare: false, deleteRootShare: false, restoreDocument: false, startHierarchyShare: false };
        for (const workspace of result.overview.workspaces) {
          if (workspace.id === workspaceId) workspace.sharing = { target: { kind: "workspace", catalogNodeId: "catalog_readonly" }, ownerId: "someone", createdBy: "someone", role: "viewer", capabilities, state: "active", placement: "incoming", isShareRoot: true };
        }
        return result;
      });
    }, fixture.home);
    await newMaterial.hover();
    await expect(team).toBeVisible();
    await expect(home).toHaveCount(0);
    await expect(team).toHaveAttribute("data-default", "true");
    await page.mouse.move(700, 600);
    await expect(menu).toHaveCount(0);
    const fallback = await createdBy(page, () => newMaterial.click());
    expect(fallback).toMatchObject({ workspaceId: fixture.team, folderId: null });
    await expectLocation(page, { workspace: "数学科", folder: "ワークスペースの直下" });
    await expect(createdDialog(page)).toContainText("直前の教材のワークスペースには作成できないため、既定の作成先に作成しました。");
    await page.screenshot({ path: testInfo.outputPath("04-read-only-fallback-dialog.png"), animations: "disabled" });
    await closeCreatedDialog(page);
    await session.app.evaluate(({ ipcMain }) => {
      const channel = "storage:get-workspace-overview";
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (globalThis as { __originalOverview?: Parameters<typeof ipcMain.handle>[1] }).__originalOverview!);
    });

    // 6. 再起動しても、書いた教材は作った場所にある (ワークスペース画面でも同じ場所に見える)。
    await session.app.close();
    session = await launch(env);
    page = session.page;
    const files = await listFiles(page);
    expect(files.find((file) => file.fileId === direct.fileId)).toMatchObject({ workspaceId: fixture.home, folderId: fixture.unitId });
    expect(files.find((file) => file.fileId === chosen.fileId)).toMatchObject({ workspaceId: fixture.team, folderId: null });
    await page.goto(workspaceUrl(page, fixture.home, fixture.unitId));
    await expect(page.locator(`[data-item-key="file:${direct.fileId}"]`)).toBeVisible({ timeout: 60_000 });
    await page.goto(workspaceUrl(page, fixture.team, null));
    await expect(page.locator(`[data-item-key="file:${chosen.fileId}"]`)).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath("05-after-restart-workspace.png"), animations: "disabled" });
  } finally {
    await session?.app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
