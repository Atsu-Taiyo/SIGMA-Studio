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
    const passive = page.locator(".workspace-passive-editor .page-canvas").first();
    const passiveScale = () => passive.evaluate(element => getComputedStyle(element).getPropertyValue("--editor-zoom"));
    const beforeZoom = await passiveScale();
    await expect(page.locator('[title="保存済みの教材を開く"]')).toHaveCount(0);
    await page.getByRole("button", { name: "拡大", exact: true }).last().click();
    expect(await passiveScale()).toBe(beforeZoom);
    expect(beforeZoom).not.toBe("");
    const activeGroup = page.locator('.workspace-tab-group[data-focused="true"]');
    const activeId = await activeGroup.getAttribute("data-group-id");
    const zoomedScale = await activeGroup.locator(".page-canvas").first().evaluate(element => getComputedStyle(element).getPropertyValue("--editor-zoom"));
    await passive.click({ position: { x: 30, y: 30 } });
    await page.locator(`[data-group-id="${activeId}"] .workspace-passive-editor`).click({ position: { x: 30, y: 30 } });
    await expect.poll(() => page.locator(`[data-group-id="${activeId}"] .page-canvas`).first().evaluate(element => getComputedStyle(element).getPropertyValue("--editor-zoom"))).toBe(zoomedScale);
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

test("an unfocused pane stays an editing surface and a click there edits at that point", async () => {
  test.skip(!PREPARED, "Build Electron and the static renderer first.");
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-tab-passive-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = path.join(root, "profile");
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fileIds = await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const paragraph = (id: string, text: string) => ({ type: "paragraph", id, children: [{ type: "text", text }] });
      const make = (docId: string, title: string, lead: string) => ({
        version: "2.0", docId, metadata: { title },
        outputProfiles: {
          student: { showSolutions: false, showHints: false, includeAnswers: false },
          teacher: { showSolutions: true, showHints: true, includeAnswers: true },
          answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
        },
        content: [paragraph(`${docId}_lead`, lead), ...Array.from({ length: 40 }, (_, index) => paragraph(`${docId}_p${index}`, `${title} ${index + 1}行目の本文`))],
      });
      const a = await api.createFileFromDocument({ document: make("doc_passive_a", "左の教材", "左の先頭") } as never);
      const b = await api.createFileFromDocument({ document: make("doc_passive_b", "右の教材", "右の先頭") } as never);
      const ids = [a.file.fileId, b.file.fileId];
      await api.saveWorkspace({ openFileIds: ids, activeFileId: ids[0] });
      return ids;
    });
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    await dragTabToEdge(page, "右の教材", 0, "right");
    await expect(page.locator(".workspace-tab-group")).toHaveCount(2);

    // The pane that is not being edited shows the editor's own surface, read-only, not a print preview.
    const passive = page.locator(".workspace-passive-editor");
    await expect(passive).toHaveCount(1);
    await expect(passive.locator(".page-canvas")).toBeVisible();
    await expect(passive.locator(".paged-surface")).toHaveCount(0);
    await expect(passive.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(passive).toContainText("左の教材 12行目の本文");

    // Clicking a line there makes it the edited pane with the caret on that line.
    await passive.evaluate((element) => { element.scrollTop = 160; });
    const line = passive.getByText("左の教材 12行目の本文", { exact: true });
    const box = await line.evaluate(element => {
      // Independent zoom may make the block wider than its clipped pane.
      // Click the visible text, not the block's offscreen right border.
      const range = document.createRange(); range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    const live = page.locator('.workspace-tab-group[data-live="true"]');
    await expect(live.locator('[data-sigma-doc-id="doc_passive_a_p11"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[contenteditable="true"]') !== null)).toBe(true);
    await page.keyboard.insertText("★");
    await expect(live.locator('[data-sigma-doc-id="doc_passive_a_p11"]')).toContainText("左の教材 12行目の本文★");
    await expect.poll(() => page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId).then((doc) => JSON.stringify(doc)), fileIds[0]))
      .toContain("12行目の本文★");
    // The pane that was being edited is now the read-only one.
    await expect(page.locator(".workspace-passive-editor")).toContainText("右の教材 1行目の本文");
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
