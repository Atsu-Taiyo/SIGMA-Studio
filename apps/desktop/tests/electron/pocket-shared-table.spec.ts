import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { ensurePageLayout, isValidOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { createTableShapeProps } from "@/components/editor/overlay-canvas/shapes/table";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

/** Main/preload, shared renderer, journal and HTTP are real; the loopback server validates each update. */
test("a table inserted from Pocket into an online shared material keeps editing and saving after restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-pocket-shared-table-"));
  const sharedId = "14444444-4444-4444-8444-444444444444";
  const actorId = "15555555-5555-4555-8555-555555555555";
  const directory = path.join(profile, "collaboration-v1");
  const remote = new SharedDocument();
  const receipts = new Map<string, number>();
  let rejectedUpdates = 0;
  const server = createServer(async (request, response) => {
    const prefix = `/documents/${sharedId}`;
    const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!request.url?.startsWith(prefix)) { json({ error: "FIXTURE_OFFLINE" }, 503); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (request.url === `${prefix}/snapshot`) {
      json({ state: toBase64(remote.snapshot()), role: "editor", epoch: 1, protocol: 1 });
    } else if (request.url === `${prefix}/sync` && body.vector) {
      json({ update: toBase64(remote.difference(fromBase64(body.vector))), role: "editor", epoch: 1, protocol: 1 });
    } else if (request.url === `${prefix}/updates` && Array.isArray(body.operations)) {
      try {
        const acks = body.operations.map((operation: { operationId: string; update: string }) => {
          let seq = receipts.get(operation.operationId);
          if (seq === undefined) {
            const update = fromBase64(operation.update);
            const candidate = remote.prepareUpdate(update, value => {
              const document = value as unknown as SigmaDocument;
              // The pure validator is the schema's overlaySnapshot z.custom predicate.
              if (!isValidOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot)) throw new Error("INVALID_REQUEST");
            });
            candidate.destroy();
            remote.applyUpdate(update);
            seq = receipts.size + 1;
            receipts.set(operation.operationId, seq);
          }
          return { operationId: operation.operationId, seq };
        });
        json({ acks });
      } catch { rejectedUpdates++; json({ error: "INVALID_REQUEST" }, 400); }
    } else response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/documents/${sharedId}/socket`) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit("connection", client, request));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_PORT_REQUIRED");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_ENV: "development", SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_COLLABORATION_URL: endpoint, SIGMA_SUPABASE_URL: endpoint, SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    const nativeKeyring = process.platform === "linux"
      ? { executablePath: createRequire(path.join(root, "package.json"))("electron") as string }
      : {};
    app = await electron.launch({ ...nativeKeyring, args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  const close = async () => {
    if (!app) return;
    const current = app;
    app = undefined;
    const timer = setTimeout(() => current.process().kill("SIGKILL"), 5000);
    try { await current.close(); } finally { clearTimeout(timer); }
  };
  const ledgerEvents = async () => (await readFile(path.join(profile, "data", "logs", "ledger.log"), "utf8"))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { event: string; pid: number; code?: number });
  try {
    const document = ensurePageLayout(createBlankDocument("オンラインのポケット表"));
    document.content = [{ type: "paragraph", id: "shared_table_body", children: [{ type: "text", text: "表を挿入したあと" }] }];
    const props = createTableShapeProps("plain");
    props.table.grid.lineOverrides = [
      { axis: "horizontal", beforeRowId: props.table.rows[1].id, style: { borderStyle: "double", borderWidth: 2 } },
      { axis: "vertical", beforeColumnId: props.table.columns[1].id, style: { visible: false } },
    ];
    props.table.cells[0].content = [{ type: "paragraph", id: "shared_table_heading", children: [{ type: "text", text: "共有の表の内容" }] }];
    document.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "shared_table_source", type: "tableShape", x: 100, y: 320, anchor: { type: "page" }, props,
    }] } };
    let page = await launch();
    const seeded = await page.evaluate(async input => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document: input });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return { fileId: created.file.fileId, workspaceId: created.file.workspaceId, document: (await api.loadDocument(created.file.fileId))! };
    }, document);
    const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, user: { id: actorId } });
    await close();
    remote.initialize(JSON.parse(JSON.stringify(seeded.document)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
    await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
      sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: seeded.fileId, docId: seeded.document.docId,
    }, remote);
    await writeFile(path.join(directory, "registry.json"), JSON.stringify({ version: 1, files: {
      [seeded.fileId]: { sharedDocumentId: sharedId, actorId, role: "editor", operationId: crypto.randomUUID(), initialized: true },
    } }));
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    const cache = await CatalogCache.open(directory, actorId);
    const nodeId = "16666666-6666-4666-8666-666666666666";
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
    cache.data.workspaceState = { openFileIds: [seeded.fileId], activeFileId: seeded.fileId };
    await cache.save();

    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await (await app!.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1050));
    page.on("pageerror", error => errors.push(error.message));
    const session = () => page.evaluate(async fileId => (await window.desktopAPI!.collaboration!.info()).sessions.find(item => item.binding.localFileId === fileId), seeded.fileId);
    await expect.poll(async () => Boolean(await session())).toBe(true);
    await expect(page.locator('.page-flow .ProseMirror').first()).toHaveAttribute("contenteditable", "true");
    await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="shared_table_source"]').first());
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    const card = page.locator("[data-pocket-item] button[data-kind]").first();
    await expect(card).toHaveAttribute("data-kind", "shapes");
    await card.click();
    await page.keyboard.press("ControlOrMeta+KeyS");
    const remoteDocument = () => remote.project() as unknown as SigmaDocument;
    await expect.poll(() => remoteDocument().pageLayout!.overlay!.overlaySnapshot!.shapes.length).toBe(2);
    expect((await session())?.status).not.toBe("save-error");
    await expect(page.locator('.page-flow .ProseMirror').first()).toHaveAttribute("contenteditable", "true");
    const tables = remoteDocument().pageLayout!.overlay!.overlaySnapshot!.shapes;
    for (const table of tables) {
      if (table.type !== "tableShape") throw new Error("EXPECTED_TABLE");
      expect(table.props.table.grid.lineOverrides).toEqual([
        { axis: "horizontal", beforeRowId: table.props.table.rows[1].id, style: { borderStyle: "double", borderWidth: 2 } },
        { axis: "vertical", beforeColumnId: table.props.table.columns[1].id, style: { visible: false } },
      ]);
      expect(JSON.stringify(table)).toContain("共有の表の内容");
    }
    // The failure used to latch the shared session read-only. Exercise actual keyboard input next.
    await page.keyboard.press("Escape");
    const paragraph = page.locator('[data-sigma-doc-id="shared_table_body"]').first();
    const bodyBox = (await paragraph.boundingBox())!;
    await page.mouse.click(bodyBox.x + bodyBox.width - 8, bodyBox.y + bodyBox.height / 2);
    await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.type("も編集して保存できる");
    await page.keyboard.press("ControlOrMeta+KeyS");
    await expect.poll(() => JSON.stringify(remoteDocument().content)).toContain("も編集して保存できる");
    await page.evaluate(id => window.desktopAPI!.collaboration!.flush(id, true), seeded.fileId);
    await expect.poll(async () => (await session())?.detail?.pendingOperations).toBe(0);
    await expect.poll(async () => (await session())?.status).toBe("saved");
    expect(rejectedUpdates).toBe(0);
    expect((await ledgerEvents()).filter(event => ["shared-document-save-failed", "shared-document-sync-failed"].includes(event.event))).toEqual([]);
    expect(errors).toEqual([]);
    const settled = remoteDocument();
    const closingPid = app!.process().pid;
    await page.screenshot({ path: testInfo.outputPath("shared-pocket-table-saved.png") });
    await close();
    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const restored = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), seeded.fileId);
    expect(restored!.pageLayout!.overlay!.overlaySnapshot!.shapes).toEqual(settled.pageLayout!.overlay!.overlaySnapshot!.shapes);
    expect(restored!.content).toEqual(settled.content);
    await expect(page.locator('[data-sigma-doc-id="shared_table_body"]').first()).toContainText("も編集して保存できる");
    expect((await session())?.status).not.toBe("save-error");
    await expect(page.locator('.page-flow .ProseMirror').first()).toHaveAttribute("contenteditable", "true");
    // Closing the previous process can abort its in-flight sync request. It must never be a
    // rejected document update, and the restarted session must have no save/sync failures.
    expect((await ledgerEvents()).filter(event =>
      event.event === "shared-document-save-failed" ||
      (event.event === "shared-document-sync-failed" && !(event.pid === closingPid && event.code === 20)),
    )).toEqual([]);
  } finally {
    if (app) {
      const page = await app.firstWindow();
      const statuses = await page.evaluate(() => window.desktopAPI!.collaboration!.info()).then(info => info.sessions.map(({ binding, status, detail }) => ({ fileId: binding.localFileId, status, detail })), () => []);
      const diagnosticPath = testInfo.outputPath("shared-session-status.json");
      await writeFile(diagnosticPath, JSON.stringify({ sessions: statuses, errors, editables: await page.locator('.page-flow .ProseMirror').evaluateAll(elements => elements.map(element => element.getAttribute("contenteditable"))).catch(() => []) }));
      await testInfo.attach("shared-session-status", { path: diagnosticPath, contentType: "application/json" });
    }
    const ledgerPath = testInfo.outputPath("shared-save-ledger.json");
    await writeFile(ledgerPath, JSON.stringify(await ledgerEvents().catch(() => [])));
    await testInfo.attach("shared-save-ledger", { path: ledgerPath, contentType: "application/json" });
    await close();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    remote.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
