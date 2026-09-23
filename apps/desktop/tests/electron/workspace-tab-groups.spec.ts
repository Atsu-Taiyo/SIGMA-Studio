import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");
const MAIN_ENTRY = path.join(APP_ROOT, "dist-electron/main.cjs");
const PREPARED = existsSync(MAIN_ENTRY) && existsSync(path.join(APP_ROOT, "out/index.html"));

async function dragTabToEdge(page: Page, tabName: string, targetGroupIndex: number, edge: "right" | "bottom") {
  const source = page.getByRole("tab", { name: tabName, exact: true });
  const target = page.locator(".workspace-tab-group").nth(targetGroupIndex);
  const bounds = (await target.boundingBox())!;
  const point = edge === "right"
    ? { clientX: bounds.x + bounds.width - 12, clientY: bounds.y + bounds.height / 2 }
    : { clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height - 12 };
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer, ...point });
  await expect(target.locator(`.workspace-tab-drop-preview[data-edge="${edge}"]`)).toBeVisible();
  await target.dispatchEvent("drop", { dataTransfer, ...point });
  await source.dispatchEvent("dragend", { dataTransfer });
}

test("real Electron supports persisted three-way tab groups and untouched-draft cleanup", async () => {
  test.skip(!PREPARED, "Build Electron and the static renderer first.");
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-tab-groups-"));
  const profile = path.join(root, "profile");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  let app: ElectronApplication | undefined = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    const created = await page.evaluate(async () => {
      // The CI Mac uses an English OS locale; this fixture asserts Japanese labels.
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const records = await Promise.all([
        api.createDocument({ title: "分割教材A" }),
        api.createDocument({ title: "分割教材B" }),
        api.createDocument({ title: "分割教材C" }),
      ]);
      const fileIds = records.map((record) => record.file.fileId);
      await api.saveWorkspace({ openFileIds: fileIds, activeFileId: fileIds[0] });
      return fileIds;
    });
    await page.reload();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator(".editor-menubar .workspace-tabs-row .workspace-tab")).toHaveCount(3);
    await expect(page.locator(".editor-menubar")).toHaveCount(1);

    await dragTabToEdge(page, "分割教材B", 0, "right");
    await expect(page.locator(".workspace-tab-group")).toHaveCount(2);
    await dragTabToEdge(page, "分割教材C", 0, "bottom");
    await expect(page.locator(".workspace-tab-group")).toHaveCount(3);
    await expect(page.locator(".workspace-tab-drop-preview")).toHaveCount(0);
    const evidence = path.resolve(APP_ROOT, "../../tmp/collaboration-fixes-evidence");
    mkdirSync(evidence, { recursive: true });
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    await page.screenshot({ path: path.join(evidence, "three-tab-groups.png"), animations: "disabled" });

    const splitter = page.locator(".workspace-tab-splitter").first();
    await splitter.focus();
    await splitter.press("ArrowRight");
    await expect.poll(async () => {
      const dataDir = await page.evaluate(() => window.desktopAPI!.storage.getDataDir());
      const workspace = JSON.parse(readFileSync(path.join(dataDir.path, "workspace.json"), "utf8"));
      return workspace.layout?.groups?.length;
    }).toBe(3);

    const beforeNewDocument = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await page.getByRole("menu", { name: "新規教材" }).getByRole("menuitem", { name: "空の教材", exact: true }).click();
    await expect.poll(async () => {
      const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
      return files.find((file) => !beforeNewDocument.some((before) => before.fileId === file.fileId))?.fileId ?? null;
    }).not.toBeNull();
    const temporary = (await page.evaluate(() => window.desktopAPI!.storage.listFiles()))
      .find((file) => !beforeNewDocument.some((before) => before.fileId === file.fileId))!.fileId;
    await page.locator(`[data-tab-id="document:${temporary}"] .document-tab-close`).click();
    await expect.poll(() => page.evaluate((fileId) => window.desktopAPI!.storage.listFiles().then((files) => files.some((file) => file.fileId === fileId)), temporary)).toBe(false);

    const beforeCloseDraft = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await page.getByRole("menu", { name: "新規教材" }).getByRole("menuitem", { name: "空の教材", exact: true }).click();
    await expect.poll(async () => {
      const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
      return files.length;
    }).toBe(beforeCloseDraft.length + 1);
    const closeDraftId = (await page.evaluate(() => window.desktopAPI!.storage.listFiles()))
      .find((file) => !beforeCloseDraft.some((before) => before.fileId === file.fileId))!.fileId;

    await app.close();
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    const reopened = await app.firstWindow();
    await reopened.setViewportSize({ width: 1500, height: 1050 });
    await reopened.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(reopened.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(() => reopened.evaluate((fileId) => window.desktopAPI!.storage.listFiles().then((files) => files.some((file) => file.fileId === fileId)), closeDraftId)).toBe(false);
    await expect(reopened.locator(".workspace-tab-group")).toHaveCount(3);
    expect(created).toHaveLength(3);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("failed save keeps the current document and pane layout when splitting a tab", async () => {
  test.skip(!PREPARED, "Build Electron and the static renderer first.");
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-tab-save-failure-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = path.join(root, "profile");
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const a = await api.createDocument({ title: "保存元A" });
      const b = await api.createDocument({ title: "移動先B" });
      await api.saveWorkspace({ openFileIds: [a.file.fileId, b.file.fileId], activeFileId: a.file.fileId });
    });
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0);
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("storage:save-document");
      ipcMain.handle("storage:save-document", () => ({ ok: false, error: "TEST_SAVE_FAILURE" }));
    });
    const body = page.locator(".page-flow .ProseMirror").first();
    await body.click();
    await page.keyboard.insertText("未保存の入力を保持");
    await expect(body).toContainText("未保存の入力を保持");
    await dragTabToEdge(page, "移動先B", 0, "right");
    await expect(page.getByText("TEST_SAVE_FAILURE", { exact: true })).toBeVisible();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    await expect(page.locator(".workspace-tab.active")).toContainText("保存元A");
    await expect(body).toContainText("未保存の入力を保持");
  } finally {
    // This isolated fixture deliberately makes all saves fail; discard only its
    // synthetic profile without waiting for the expected save-failure dialog.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
