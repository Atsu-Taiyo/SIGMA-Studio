import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("real Electron IPC rejects other windows, subframes and navigation while storage and AI preview remain usable", async () => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-ipc-security-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [root], cwd: root, env, chromiumSandbox: true });
  try {
    expect(await app.evaluate(({ app }) => app.commandLine.hasSwitch("no-sandbox"))).toBe(false);
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const mainUrl = page.url();
    const created = await page.evaluate(() => window.desktopAPI!.storage.createDocument({ title: "IPC saved document" }));
    const load = await page.evaluate(id => window.desktopAPI!.storage.loadDocumentWithRecovery!(id), created.file.fileId);
    expect(load.ok).toBe(true);
    if (!load.ok) throw new Error("Document load failed");
    const saved = await page.evaluate(async ({ id, document, revision }) => window.desktopAPI!.storage.saveDocument(id, {
      ...document, metadata: { ...document.metadata, title: "IPC persistence verified" },
    }, { expectedRevision: revision }), { id: created.file.fileId, document: load.document, revision: load.revision });
    expect(saved.ok).toBe(true);
    await page.reload();
    expect((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), created.file.fileId))?.metadata.title).toBe("IPC-persistence-verified");

    // A full real preload in another window on the same renderer URL must not gain editor privileges.
    const siblingId = await app.evaluate(async ({ BrowserWindow }, { url, preload }) => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      await window.loadURL(url);
      return window.webContents.id;
    }, { url: mainUrl, preload: path.join(root, "dist-electron/preload.cjs") });
    const rejected = await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(`(async () => {
      const calls = [
        () => window.desktopAPI.storage.listFiles(),
        () => window.desktopAPI.settings.get(),
        () => window.desktopAPI.file.getPendingOpenDocument(),
        () => window.desktopAPI.collaboration.info(),
        () => window.desktopAPI.sharedCatalog.status(),
        () => window.desktopAPI.aiRender.getRenderDocument("foreign")
      ];
      return Promise.all(calls.map(async call => { try { await call(); return "allowed"; } catch(error) { return String(error); } }));
    })()`), siblingId);
    expect((rejected as string[]).slice(0, 5).every(value => value.includes("TRUSTED_RENDERER_REQUIRED"))).toBe(true);
    expect(rejected[5]).toContain("TRUSTED_PREVIEW_REQUIRED");
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromWebContents(BrowserWindow.getAllWindows().find(window => window.webContents.id === id)!.webContents)!.destroy(), siblingId);

    // Use a real child WebFrameMain against the production handler, independently of preload exposure.
    await page.evaluate(() => { const frame = document.createElement("iframe"); frame.src = "about:blank"; document.body.append(frame); });
    const childRejected = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const sender = BrowserWindow.getAllWindows()[0].webContents;
      const senderFrame = sender.mainFrame.frames[0];
      if (!senderFrame) throw new Error("No child frame");
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown) => unknown> })._invokeHandlers;
      try { await handlers.get("storage:list-files")!({ sender, senderFrame }); return "allowed"; } catch (error) { return String(error); }
    });
    expect(childRejected).toContain("TRUSTED_RENDERER_REQUIRED");

    // Main-process navigation bypasses will-navigate; the IPC guard must still reject its new page.
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadURL("data:text/html,<title>Untrusted</title>"));
    const navigationRejected = await page.evaluate(async () => {
      try { await window.desktopAPI!.storage.listFiles(); return "allowed"; } catch (error) { return String(error); }
    });
    expect(navigationRejected).toContain("TRUSTED_RENDERER_REQUIRED");
    await app.evaluate(async ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), mainUrl);
    expect((await page.evaluate(() => window.desktopAPI!.storage.listFiles())).some(file => file.fileId === created.file.fileId)).toBe(true);

    // Exercise the actual minimal sandboxed preview preload through the local AI renderer service.
    const bridgeFile = path.join(profile, "data/ai-run-context/render-bridge.json");
    await expect.poll(async () => { try { await readFile(bridgeFile); return true; } catch { return false; } }).toBe(true);
    const bridge = JSON.parse(await readFile(bridgeFile, "utf8")) as { url: string; token: string };
    const response = await fetch(new URL("/render-page-context", bridge.url), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ document: created.document, targetId: null, captureMode: "page", focus: { pageIndex: 0, overlayRect: { x: 0, y: 0, w: 100, h: 100 } }, maxLongSidePx: 300 }),
    });
    expect(response.ok).toBe(true);
    const rendered = await response.json() as { ok: boolean; pngBase64?: string; error?: string };
    expect(rendered.ok, rendered.error).toBe(true);
    expect(rendered.pngBase64?.length).toBeGreaterThan(100);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
