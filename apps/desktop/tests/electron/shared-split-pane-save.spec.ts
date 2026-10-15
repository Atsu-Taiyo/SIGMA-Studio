import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

/**
 * Issue #205: a shared document shown in the other pane of a split ("右に並べて開く") is opened
 * there first, while visible, so its first sync also opens the live connection. When that
 * connection failed, main kept the session but never told the renderer. Clicking the pane
 * then edited a JSON copy that main could only reject (SHARED_SESSION_WRITE_REQUIRED), and
 * closing the window showed "保存できませんでした".
 *
 * The backend is a loopback protocol fixture that refuses the first live connection.
 * Electron main, preload, HTTP, WebSocket, journals and the catalog cache are real.
 */
test("a shared document first opened in a split pane saves its edits through the shared session", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-split-shared-"));
  const sharedId = "77777777-7777-4777-8777-777777777777";
  const actorId = "88888888-8888-4888-8888-888888888888";
  const directory = path.join(profile, "collaboration-v1");
  const remote = new SharedDocument();
  let sequence = 0;
  let upgrades = 0;
  const server = createServer(async (request, response) => {
    const prefix = `/documents/${sharedId}`;
    const json = (value: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!request.url?.startsWith(prefix)) {
      response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"FIXTURE_OFFLINE"}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (request.url === `${prefix}/snapshot`) {
      json({ state: toBase64(remote.snapshot()), role: "editor", epoch: 1 });
    } else if (request.url === `${prefix}/sync` && body.vector) {
      json({ update: toBase64(remote.difference(fromBase64(body.vector))), role: "editor", epoch: 1, protocol: 1 });
    } else if (request.url === `${prefix}/updates` && Array.isArray(body.operations)) {
      const acks = body.operations.map((operation: { operationId: string; update: string }) => {
        remote.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: ++sequence };
      });
      json({ acks });
    } else response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    // The first live connection fails, like a dropped or refused socket.
    if (request.url !== `/documents/${sharedId}/socket` || ++upgrades === 1) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_PORT_REQUIRED");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_ENV: "development", SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_COLLABORATION_URL: endpoint, SIGMA_SUPABASE_URL: endpoint, SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  const launch = async () => {
    // Linux CI encrypts the fixture login with the real Secret Service through Electron's own binary.
    const nativeKeyring = process.platform === "linux"
      ? { executablePath: createRequire(path.join(root, "package.json"))("electron") as string }
      : {};
    app = await electron.launch({ ...nativeKeyring, args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  try {
    let page = await launch();
    const shared = { ...createBlankDocument("共有教材"), content: [{ type: "paragraph", id: "shared_p", children: [{ type: "text", text: "共有の本文" }] }] } as SigmaDocument;
    const local = { ...createBlankDocument("手元の教材"), content: [{ type: "paragraph", id: "local_p", children: [{ type: "text", text: "手元の本文" }] }] } as SigmaDocument;
    const seeded = await page.evaluate(async (input) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const s = await api.createFileFromDocument({ document: input.shared });
      const l = await api.createFileFromDocument({ document: input.local });
      return { sharedFileId: s.file.fileId, localFileId: l.file.fileId, workspaceId: s.file.workspaceId, sharedDocument: (await api.loadDocument(s.file.fileId))! };
    }, { shared, local });
    const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user: { id: actorId } });
    await app!.close(); app = undefined;

    // The shared document is listed by the catalog but has never been opened on this device.
    remote.initialize(JSON.parse(JSON.stringify(seeded.sharedDocument)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    const cache = await CatalogCache.open(directory, actorId);
    const nodeId = "99999999-9999-4999-8999-999999999999";
    cache.data.nodes[nodeId] = {
      id: nodeId as never, kind: "document", parentId: null, ownerId: actorId, createdBy: actorId,
      name: seeded.sharedDocument.metadata.title, sharedDocumentId: sharedId as never, state: "active", isShareRoot: true,
      role: "editor", titleVersion: 1, revision: 1,
      capabilities: { read: true, editDocument: true, createChildren: false, rename: true, move: true, deleteDescendants: true,
        invite: true, manageEditorViewer: true, appointAdmin: true, stopRootShare: true, deleteRootShare: true,
        restoreDocument: true, startHierarchyShare: false },
    };
    cache.data.mappings[nodeId] = { nodeId: nodeId as never, local: { kind: "document", fileId: seeded.sharedFileId },
      workspaceId: seeded.workspaceId, bodyCached: false, docId: seeded.sharedDocument.docId };
    cache.data.workspaceState = { openFileIds: [seeded.sharedFileId, seeded.localFileId], activeFileId: seeded.localFileId };
    await cache.save();

    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await (await app!.browserWindow(page)).evaluate((win) => win.setContentSize(1500, 1000));
    // Record every whole-document JSON save that reaches main.
    await app!.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { jsonSaves: { fileId: string; result: unknown }[] };
      state.jsonSaves = [];
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("storage:save-document")!;
      ipcMain.removeHandler("storage:save-document");
      ipcMain.handle("storage:save-document", async (event, fileId, ...rest) => {
        const result = await original(event, fileId, ...rest);
        state.jsonSaves.push({ fileId: String(fileId), result });
        return result;
      });
    });
    const sharedJsonSaves = () => app!.evaluate((_electron, fileId) => (globalThis as typeof globalThis & { jsonSaves: { fileId: string; result: unknown }[] })
      .jsonSaves.filter((save) => save.fileId === fileId), seeded.sharedFileId);

    // 右に並べて開く: the local document moves to a new pane; the shared one stays in the other pane.
    await page.getByRole("tab", { name: "手元の教材", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "右に並べて開く" }).click();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(2);
    const passive = page.locator(".workspace-passive-editor").filter({ hasText: "共有の本文" });
    await expect(passive).toBeVisible({ timeout: 30_000 });
    expect(upgrades).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("01-split.png") });

    // Edit the shared document from its pane.
    await passive.locator(".page-canvas").first().click({ position: { x: 120, y: 160 } });
    const paragraph = page.locator('[data-sigma-doc-id="shared_p"]').first();
    await expect(paragraph).toBeVisible();
    await expect.poll(() => page.evaluate((fileId) => window.desktopAPI!.collaboration!.info()
      .then((info) => info.sessions.some((session) => session.binding.localFileId === fileId)), seeded.sharedFileId)).toBe(true);
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.type("を追記");
    await expect(paragraph).toContainText("共有の本文を追記");
    await page.screenshot({ path: testInfo.outputPath("02-edited.png") });

    // The edit went through the shared session, never as a rejected JSON save.
    await expect.poll(async () => JSON.stringify((await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), seeded.sharedFileId))?.content))
      .toContain("共有の本文を追記");
    await page.evaluate((fileId) => window.desktopAPI!.collaboration!.flush(fileId, true), seeded.sharedFileId);
    expect(JSON.stringify(remote.project())).toContain("共有の本文を追記");
    expect(await sharedJsonSaves()).toEqual([]);
    await expect(page.getByText("SHARED_SESSION_WRITE_REQUIRED")).toHaveCount(0);

    // Closing the window saves without the "保存できませんでした" dialog, and the edit survives a restart.
    // Wait for the window: macOS keeps the app running after its last window closes.
    const fixtureProcess = app!.process();
    const exited = new Promise<void>((resolve) => fixtureProcess.once("exit", () => resolve()));
    const closed = page.waitForEvent("close", { timeout: 30_000 });
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await Promise.race([
      closed,
      // The page closing first rejects this wait; only a visible dialog is a failure.
      page.getByRole("dialog", { name: "保存できませんでした" }).waitFor({ timeout: 20_000 })
        .then(() => { throw new Error("The window close save failed"); }, () => closed),
    ]);
    // Other platforms quit with their last window.
    if (process.platform === "darwin") await app!.close();
    else await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000)).then(() => app!.close())]);
    app = undefined;
    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect.poll(async () => JSON.stringify((await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), seeded.sharedFileId))?.content))
      .toContain("共有の本文を追記");
  } finally {
    if (app) {
      const fixtureProcess = app.process();
      const timer = setTimeout(() => fixtureProcess.kill("SIGKILL"), 5000);
      try { await app.close(); } finally { clearTimeout(timer); }
    }
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    remote.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
