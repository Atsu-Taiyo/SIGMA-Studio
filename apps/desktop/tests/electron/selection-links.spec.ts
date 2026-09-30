import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/features/document";
import { parseShareLink } from "@/features/collaboration/model/share-link";

async function selectText(page: Page) {
  await page.evaluate(() => {
    const block = document.querySelector('[data-sigma-doc-id="linked-paragraph"]')!;
    block.closest<HTMLElement>(".ProseMirror")!.focus();
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 6);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("shared selections copy rich links, paste, and reopen the exact range without changing the saved material", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-selection-links-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const source = ensurePageLayout({ ...sampleDocument, version: "2.0", docId: "selection-link-document", metadata: { title: "選択リンク検証" }, content: [
      { type: "paragraph", id: "linked-paragraph", children: [{ type: "text", text: "前 選択箇所 後" }] },
    ] });
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [] } };
    const created = await page.evaluate(document => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const url = new URL(page.url()); url.searchParams.set("fileId", created.file.fileId);
    await page.goto(url.href);
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('[data-sigma-doc-id="linked-paragraph"]')).toBeVisible({ timeout: 60_000 });
    await selectText(page);
    await expect(page.locator(".selection-action-popover")).toBeVisible();
    const copy = page.getByRole("button", { name: "選択箇所へのリンクをコピー", exact: true });
    await expect(copy).toHaveCount(0);
    const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    // Only the server/catalog boundary is a fixture. Storage, renderer, preload,
    // OS clipboard, link events, navigation and saved/reloaded material are real.
    await app.evaluate(({ ipcMain }, data) => {
      const target = { kind: "document", catalogNodeId: "12345678-1234-4234-8234-123456789012" };
      const sharing = { target, state: "active", role: "owner", capabilities: { read: true, editDocument: true } };
      ipcMain.removeHandler("storage:list-files");
      ipcMain.handle("storage:list-files", () => data.files.map(file => file.fileId === data.file.fileId ? { ...file, sharing } : file));
      ipcMain.removeHandler("shared-catalog:details");
      ipcMain.handle("shared-catalog:details", () => ({ target, sharing, members: [], invitations: [] }));
      ipcMain.removeHandler("collaboration:info");
      ipcMain.handle("collaboration:info", () => ({ configured: true, user: { actorId: "test" }, sessions: [], restrictedFileIds: [] }));
      ipcMain.removeHandler("shared-catalog:refresh");
      ipcMain.handle("shared-catalog:refresh", () => ({ state: "ready", actorId: "test", revision: 1 }));
      ipcMain.removeHandler("shared-catalog:open-link");
      ipcMain.handle("shared-catalog:open-link", () => ({ target, workspaceId: data.file.workspaceId, fileId: data.file.fileId }));
    }, { files, file: created.file });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('[data-sigma-doc-id="linked-paragraph"]')).toBeVisible();
    await selectText(page); await expect(copy).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("selection-link-button.png") });
    await copy.click();
    const clipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
    expect(parseShareLink(clipboard.text)).toMatchObject({ target: { kind: "document" }, location: { type: "textRange", start: { blockId: "linked-paragraph", offset: 2 }, end: { blockId: "linked-paragraph", offset: 6 } } });
    expect(clipboard.html).toContain("選択箇所</a>");

    // Paste into an independent native window with an ordinary rich-text field.
    const newWindow = app.waitForEvent("window");
    const pastedWindow = await app.evaluateHandle(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({ width: 500, height: 250, webPreferences: { contextIsolation: true, nodeIntegration: false } });
      await window.loadURL('data:text/html,<div contenteditable="true" id="paste" style="height:200px"></div>');
      return window;
    });
    const external = await newWindow;
    await external.locator("#paste").focus(); await external.keyboard.press("ControlOrMeta+v");
    await expect(external.locator("#paste a")).toHaveText("選択箇所");
    await expect(external.locator("#paste a")).toHaveAttribute("href", clipboard.text);
    await pastedWindow.evaluate(window => window.close());
    await page.bringToFront();
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      app.evaluate(({ app }, link) => app.emit("open-url", { preventDefault() {} }, link), clipboard.text),
    ]);
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".external-text-range-highlight")).toHaveText("選択箇所");
    expect(new URL(page.url()).searchParams.has("location")).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("selection-link-target.png") });
    expect(await page.evaluate(() => window.desktopAPI!.shareLinks!.pending())).toBeNull();
    await page.reload();
    await expect(page.locator('[data-sigma-doc-id="linked-paragraph"]')).toBeVisible();
    await expect(page.locator(".external-text-range-highlight")).toHaveCount(0);
    const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), created.file.fileId);
    expect(saved?.content).toEqual(source.content);
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
