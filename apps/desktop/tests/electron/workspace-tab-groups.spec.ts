import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const passive = page.locator(".workspace-tab-group:not([data-focused]) .editor-canvas .page-canvas").first();
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
    await page.locator(`[data-group-id="${activeId}"] .editor-canvas`).click({ position: { x: 30, y: 30 } });
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
    await page.getByRole("dialog", { name: /を作成しました$/ }).getByRole("button", { name: "閉じる" }).click();
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
    await page.getByRole("dialog", { name: /を作成しました$/ }).getByRole("button", { name: "閉じる" }).click();
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
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0);
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

test("visible panes edit without reloads and retain their editor, history and saved content", async ({}, testInfo) => {
  test.skip(!PREPARED, "Build Electron and the static renderer first.");
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-tab-passive-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = path.join(root, "profile");
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", error => console.error("renderer:", error.message));
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0);
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
        content: [paragraph("same_lead", lead), ...Array.from({ length: 40 }, (_, index) => paragraph(`same_p${index}`, `${title} ${index + 1}行目の本文`))],
      });
      const a = await api.createFileFromDocument({ document: make("doc_passive_a", "左の教材", "左の先頭") } as never);
      const b = await api.createFileFromDocument({ document: make("doc_passive_b", "右の教材", "右の先頭") } as never);
      const ids = [a.file.fileId, b.file.fileId];
      await api.saveWorkspace({ openFileIds: ids, activeFileId: ids[0] });
      return ids;
    });
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    const memoryBefore = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === "Tab").map(metric => metric.memory.workingSetSize));
    await dragTabToEdge(page, "右の教材", 0, "right");
    await expect(page.locator(".workspace-tab-group")).toHaveCount(2).catch(async error => {
      console.log(await page.evaluate(() => ({ text: document.body.innerText.slice(0, 800), shells: [...document.querySelectorAll(".app-shell")].map(el => ({ hidden: el.hasAttribute("hidden"), file: el.getAttribute("data-workspace-editor-file"), html: el.querySelector(".workspace-persistent-grid-slot")?.innerHTML.slice(0, 200) })) })));
      throw error;
    });

    const groups = page.locator(".workspace-tab-group");
    const left = groups.filter({ hasText: "左の先頭" });
    const right = groups.filter({ hasText: "右の先頭" });
    await expect(left.locator('.page-flow [contenteditable="true"]')).not.toHaveCount(0);
    await expect(right.locator('.page-flow [contenteditable="true"]')).not.toHaveCount(0);
    await expect(page.locator(".workspace-passive-editor")).toHaveCount(0);
    await expect(page.locator(".workspace-tab-loading-preview")).toHaveCount(0);
    await page.evaluate(() => {
      const state = window as typeof window & { paneNodes: Element[] };
      state.paneNodes = Array.from(document.querySelectorAll('.workspace-tab-group .page-flow .ProseMirror'));
    });
    // Count real main/preload document reads. Focusing visible panes must not reload either file.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { paneLoads: number };
      state.paneLoads = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      for (const channel of ["storage:load-document", "storage:load-document-with-recovery"]) {
        const original = handlers.get(channel)!;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => { state.paneLoads++; return original(...args); });
      }
    });
    const a = left.locator('[data-sigma-doc-id="same_p11"]');
    const b = right.locator('[data-sigma-doc-id="same_p11"]');
    const putAtEnd = async (line: typeof a, text: string) => {
      await line.click({ position: { x: 120, y: 12 } });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
      await page.keyboard.insertText(text);
    };
    await putAtEnd(a, "★左");
    await expect(a).toContainText("左の教材 12行目の本文★左");
    await putAtEnd(b, "★右");
    await expect(b).toContainText("右の教材 12行目の本文★右");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+z`);
    await expect(b).not.toContainText("★右");
    await expect(a).toContainText("★左");
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect(b).toContainText("★右");
    for (let index = 0; index < 8; index++) {
      await a.click({ position: { x: 100, y: 12 } });
      await b.click({ position: { x: 100, y: 12 } });
    }
    await page.locator(`[data-tab-id="document:${fileIds[0]}"]`).getByRole("tab").click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".workspace-document-editor")?.textContent?.includes("左の先頭"))).toBe(true);
    await page.keyboard.insertText("タブ入力");
    await expect(a).toContainText("タブ入力");
    await page.keyboard.press(`${modifier}+z`);
    await expect(a).not.toContainText("タブ入力");
    await expect(b).toContainText("★右");
    await b.click({ position: { x: 100, y: 12 } });
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { paneLoads: number }).paneLoads)).toBe(0);
    expect(await page.evaluate(() => (window as typeof window & { paneNodes: Element[] }).paneNodes.every(node => node.isConnected))).toBe(true);
    const memoryAfter = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === "Tab").map(metric => metric.memory.workingSetSize));
    const memoryPath = testInfo.outputPath("renderer-memory-KiB.json");
    writeFileSync(memoryPath, JSON.stringify({ single: memoryBefore, splitAfter16Switches: memoryAfter }));
    await testInfo.attach("renderer-memory-KiB", { path: memoryPath, contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("seamless-split.png") });
    await expect.poll(() => page.evaluate((ids) => Promise.all(ids.map(id => window.desktopAPI!.storage.loadDocument(id))).then(docs => docs.map(doc => JSON.stringify(doc))), fileIds))
      .toEqual([expect.stringContaining("12行目の本文★左"), expect.stringContaining("12行目の本文★右")]);
    // A dirty background pane must block close if its save fails, even when the focused pane is clean.
    await app.evaluate(({ ipcMain }, blockedFileId) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("storage:save-document")!;
      const state = globalThis as typeof globalThis & { restorePaneSave: () => void };
      state.restorePaneSave = () => { ipcMain.removeHandler("storage:save-document"); ipcMain.handle("storage:save-document", original); };
      ipcMain.removeHandler("storage:save-document");
      ipcMain.handle("storage:save-document", (...args) => args[1] === blockedFileId ? { ok: false, error: "BACKGROUND_SAVE_FAILED" } : original(...args));
    }, fileIds[0]);
    await putAtEnd(a, "保存待ち");
    await b.click({ position: { x: 100, y: 12 } });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const failedClose = page.getByRole("dialog", { name: "保存できませんでした" });
    await expect(failedClose).toBeVisible();
    await expect(failedClose).toContainText("BACKGROUND_SAVE_FAILED");
    await expect(a).toContainText("保存待ち");
    await failedClose.getByRole("button", { name: "キャンセル", exact: true }).click();
    await app.evaluate(() => (globalThis as typeof globalThis & { restorePaneSave: () => void }).restorePaneSave());
    // Close while both editors are mounted, then verify a real app restart, not just DOM state.
    await app.close();
    const reopenedApp = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    try {
      const reopened = await reopenedApp.firstWindow();
      await reopened.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      await expect(reopened.locator(".workspace-tab-group")).toHaveCount(2, { timeout: 60_000 });
      await expect(reopened.locator(".workspace-tab-group").filter({ hasText: "左の先頭" }).locator('[data-sigma-doc-id="same_p11"]')).toContainText("★左");
      await expect(reopened.locator(".workspace-tab-group").filter({ hasText: "右の先頭" }).locator('[data-sigma-doc-id="same_p11"]')).toContainText("★右");
      for (const group of await reopened.locator(".workspace-tab-group").all()) {
        await expect(group.locator(".workspace-document-editor")).toHaveCount(1);
        await expect(group.locator('.page-flow [contenteditable="true"]')).not.toHaveCount(0);
      }
    } finally { await reopenedApp.close(); }

  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
