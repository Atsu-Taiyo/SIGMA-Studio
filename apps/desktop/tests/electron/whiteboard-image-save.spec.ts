import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { getDefaultPageLayout } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

test("image save retries unblock whiteboard tabs and survive cloud outage and Electron restart", async () => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-whiteboard-image-"));
  const sharedId = "11111111-1111-4111-8111-111111111111";
  const actorId = "22222222-2222-4222-8222-222222222222";
  const directory = path.join(profile, "collaboration-v1");
  const remote = new SharedDocument();
  const uploaded = new Map<string, Buffer>();
  let cloudOffline = true;
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const prefix = `/documents/${sharedId}`;
    const json = (value: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!request.url?.startsWith(prefix) || cloudOffline) {
      response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"FIXTURE_OFFLINE"}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (request.url.startsWith(`${prefix}/assets/`)) {
      const id = request.url.split("/").at(-1)!;
      if (request.method === "PUT") { uploaded.set(id, bytes); json({ ok: true }); }
      else response.writeHead(200, { "Content-Type": "image/png" }).end(uploaded.get(id));
      return;
    }
    const body = JSON.parse(bytes.toString());
    if (request.url === `${prefix}/sync`) {
      json({ update: toBase64(remote.difference(fromBase64(body.vector))), role: "editor", epoch: 1, protocol: 1 });
    } else if (request.url === `${prefix}/updates`) {
      const acks = body.operations.map((operation: { operationId: string; update: string }) => {
        remote.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: ++sequence };
      });
      json({ acks });
    } else response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/documents/${sharedId}/socket`) { socket.destroy(); return; }
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
    app = await electron.launch({ args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  try {
    let page = await launch();
    const seeded = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const board = await api.createFileFromDocument({ document });
      const other = await api.createDocument({ title: "別の教材" });
      await api.saveWorkspace({ openFileIds: [board.file.fileId, other.file.fileId], activeFileId: board.file.fileId });
      return { fileId: board.file.fileId, otherId: other.file.fileId, workspaceId: board.file.workspaceId, document: (await api.loadDocument(board.file.fileId))! };
    }, { ...createBlankDocument("画像保存のホワイトボード"), content: [], pageLayout: getDefaultPageLayout("whiteboard") });
    const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
        throw new Error("SECURE_STORAGE_REQUIRED");
      }
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, user: { id: actorId } });
    await app!.close(); app = undefined;
    remote.initialize(JSON.parse(JSON.stringify(seeded.document)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
    await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
      sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: seeded.fileId, docId: seeded.document.docId,
    }, remote);
    await writeFile(path.join(directory, "registry.json"), JSON.stringify({ version: 1, files: {
      [seeded.fileId]: { sharedDocumentId: sharedId, actorId, role: "editor", operationId: crypto.randomUUID(), initialized: true },
    } }));
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    const cache = await CatalogCache.open(directory, actorId);
    const nodeId = "33333333-3333-4333-8333-333333333333";
    cache.data.nodes[nodeId] = {
      id: nodeId as never, kind: "document", parentId: null, ownerId: actorId, createdBy: actorId,
      name: seeded.document.metadata.title, sharedDocumentId: sharedId as never, state: "active", isShareRoot: true,
      role: "editor", titleVersion: 1, revision: 1,
      capabilities: { read: true, editDocument: true, createChildren: false, rename: true, move: true, deleteDescendants: true,
        invite: true, manageEditorViewer: true, appointAdmin: true, stopRootShare: true, deleteRootShare: true,
        restoreDocument: true, startHierarchyShare: false },
    };
    cache.data.mappings[nodeId] = { nodeId: nodeId as never, local: { kind: "document", fileId: seeded.fileId },
      workspaceId: seeded.workspaceId, bodyCached: true, docId: seeded.document.docId };
    cache.data.workspaceState = { openFileIds: [seeded.fileId, seeded.otherId], activeFileId: seeded.fileId };
    await cache.save();
    // Make the real durable asset cache fail once, without mocking IPC or saves.
    const assetFolder = path.join(directory, "assets", sharedId);
    await mkdir(path.dirname(assetFolder), { recursive: true });
    await writeFile(assetFolder, "temporarily unavailable asset directory");
    page = await launch();
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 100;
      const context = canvas.getContext("2d")!; context.fillStyle = "#2563eb"; context.fillRect(0, 0, 160, 100);
      return canvas.toDataURL("image/png");
    });
    const pixels = Buffer.from(dataUrl.split(",")[1]!, "base64");
    await page.locator('header input[type="file"][multiple][accept*="image/"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: pixels });
    await expect(page.locator(".overlay-shape-image")).toBeVisible();
    await expect.poll(async () => (await readFile(path.join(profile, "data/logs/ledger.log"), "utf8")).includes("shared-asset-save-failed")).toBe(true);
    expect(JSON.stringify((await page.evaluate(() => window.desktopAPI!.collaboration!.info())).sessions)).not.toContain("retry.png");
    await rm(assetFolder);
    // Tab replacement calls the session flush and retries asset + update in order.
    await page.locator(`[data-tab-id="document:${seeded.otherId}"]`).click();
    const body = page.locator(".page-flow .ProseMirror").first();
    await expect(body).toBeVisible();
    await body.fill("画像保存エラー後も別教材を編集できる");
    await expect.poll(async () => JSON.stringify(await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), seeded.otherId))).toContain("画像保存エラー後も別教材を編集できる");
    await page.locator(`[data-tab-id="document:${seeded.fileId}"]`).click();
    const image = page.locator(".overlay-shape-image img.overlay-image-shape");
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(160);
    const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), seeded.fileId);
    expect(JSON.stringify(saved)).toContain("retry.png");
    expect(JSON.stringify(saved)).toContain("sigma-doc-storage://");
    expect(uploaded.size).toBe(0);
    const ledger = await readFile(path.join(profile, "data/logs/ledger.log"), "utf8");
    expect(ledger).toContain("shared-document-sync-failed");
    expect(ledger).not.toContain(dataUrl);

    cloudOffline = false;
    await page.evaluate((id) => window.desktopAPI!.collaboration!.flush(id, true), seeded.fileId);
    expect([...uploaded.values()]).toEqual([pixels]);
    expect(JSON.stringify(remote.project())).toContain("retry.png");
    await app!.close(); app = undefined;
    page = await launch();
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const restored = page.locator(".overlay-shape-image img.overlay-image-shape");
    await expect(restored).toBeVisible();
    await expect.poll(() => restored.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(160);
    const journal = await SharedDocumentJournal.open(path.join(directory, "documents", sharedId));
    expect(JSON.stringify(journal.document.project())).toContain("retry.png");
    expect(journal.outbox()).toHaveLength(0);
    journal.document.destroy();
    // Whiteboard coordinates can extend beyond the current camera. Pan through
    // the real wheel handler to include the restored pixels in visual evidence.
    const imageBox = (await restored.boundingBox())!;
    const viewportBox = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
    const center = { x: viewportBox.x + viewportBox.width / 2, y: viewportBox.y + viewportBox.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(imageBox.x + imageBox.width / 2 - center.x, imageBox.y + imageBox.height / 2 - center.y);
    await expect(restored).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("whiteboard-image-reloaded.png") });
  } finally {
    // The regression blocks the close/save handshake too. Only the disposable
    // fixture process may be terminated if its normal shutdown is rejected.
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
