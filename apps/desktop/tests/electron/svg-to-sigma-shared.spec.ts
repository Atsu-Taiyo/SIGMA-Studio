import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { getDefaultPageLayout, type InlineNode, type OverlaySnapshot, type SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><g stroke="#111111" stroke-width="2" fill="none"><rect x="20" y="20" width="80" height="50" fill="#dddddd"/><polygon points="150,20 190,70 110,70" fill="#cccccc"/><line x1="20" y1="100" x2="180" y2="100" stroke-dasharray="8 6"/><line x1="20" y1="130" x2="180" y2="130" stroke-dasharray="1 6"/><path d="M30 160 C60 190 120 190 160 160"/></g><text x="200" y="40">装置図</text><text x="200" y="80"><tspan font-style="italic">V</tspan>(<tspan font-style="italic">z</tspan>)</text></svg>';
const ASSET_ID = "svg_shared_asset";

/** A shared (cloud) document keeps every image as `sigma-doc-storage://<id>`; only the durable cache holds the SVG text. */
test("SVG in a shared document converts to shapes through the storage reference", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const reference = process.env.SIGMA_STUDIO_SVG_REFERENCE_DOCUMENT;
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-svg-shared-"));
  const sharedId = "44444444-4444-4444-8444-444444444444";
  const actorId = "55555555-5555-4555-8555-555555555555";
  const directory = path.join(profile, "collaboration-v1");
  const remote = new SharedDocument();
  const uploaded = new Map<string, Buffer>();
  let sequence = 0;
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
    if (request.url.startsWith(`${prefix}/assets/`)) {
      const id = request.url.split("/").at(-1)!;
      if (request.method === "PUT") { uploaded.set(id, bytes); json({ ok: true }); }
      else response.writeHead(200, { "Content-Type": "image/svg+xml" }).end(uploaded.get(id));
      return;
    }
    // Probes and heartbeats can arrive without a body; only sync and updates carry JSON.
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (request.url === `${prefix}/sync` && body.vector) {
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
    const nativeKeyring = process.platform === "linux"
      ? { executablePath: createRequire(path.join(root, "package.json"))("electron") as string }
      : {};
    app = await electron.launch({ ...nativeKeyring, args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  try {
    // The cache keeps the image the way the shared session received it: as a data URL.
    let assetSource: string;
    let document: SigmaDocument;
    if (reference) {
      document = JSON.parse(await readFile(reference, "utf8")) as SigmaDocument;
      const overlay = document.pageLayout!.overlay!.overlaySnapshot!;
      const asset = Object.values(overlay.assets)[0];
      assetSource = asset.props.src;
      asset.props.src = `sigma-doc-storage://${ASSET_ID}`;
    } else {
      assetSource = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;
      const snapshot: OverlaySnapshot = {
        version: 1,
        shapes: [{ id: "svg-image", type: "image", x: 100, y: 120, anchor: { type: "page" },
          props: { assetId: "svg-asset", w: 240, h: 200,
            crop: { topLeft: { x: 0.1, y: 0 }, bottomRight: { x: 0.9, y: 1 } } } }],
        assets: { "svg-asset": { id: "svg-asset", type: "image", props: { w: 300, h: 200, name: "装置図", mimeType: "image/svg+xml",
          isAnimated: false, fileSize: SVG.length, src: `sigma-doc-storage://${ASSET_ID}` } } },
      };
      document = { ...createBlankDocument("共有教材のSVG"), content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "SVGを右クリックして変換" }] }],
        pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: snapshot } } };
    }
    let page = await launch();
    const seeded = await page.evaluate(async (input) => {
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
    await app!.close(); app = undefined;
    remote.initialize(JSON.parse(JSON.stringify(seeded.document)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
    await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
      sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: seeded.fileId, docId: seeded.document.docId,
    }, remote);
    await writeFile(path.join(directory, "registry.json"), JSON.stringify({ version: 1, files: {
      [seeded.fileId]: { sharedDocumentId: sharedId, actorId, role: "editor", operationId: crypto.randomUUID(), initialized: true },
    } }));
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    const assetFolder = path.join(directory, "assets", sharedId);
    await mkdir(assetFolder, { recursive: true });
    await writeFile(path.join(assetFolder, `${ASSET_ID}.json`), JSON.stringify({ source: assetSource, uploaded: true }));
    const cache = await CatalogCache.open(directory, actorId);
    const nodeId = "66666666-6666-4666-8666-666666666666";
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
    await (await app!.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1050));
    const sessions = JSON.stringify((await page.evaluate(() => window.desktopAPI!.collaboration!.info())).sessions);
    expect(sessions).toContain(sharedId);
    const imageShape = page.locator(".overlay-shape-image").first();
    await imageShape.scrollIntoViewIfNeeded();
    await expect(imageShape.locator("img.overlay-image-shape")).toBeVisible();
    await expect.poll(() => imageShape.locator("img.overlay-image-shape").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
    const savedSnapshot = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), seeded.fileId))!.pageLayout!.overlay!.overlaySnapshot!;
    // The shared snapshot must hold only the storage reference, never the SVG text itself.
    const before = await savedSnapshot();
    expect(JSON.stringify(before)).toContain(`sigma-doc-storage://${ASSET_ID}`);
    await page.screenshot({ path: testInfo.outputPath("shared-svg-before.png") });

    const box = (await imageShape.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
    await expect(page.getByTestId("svg-conversion-message")).toContainText("個の図形に変換しました");
    await page.screenshot({ path: testInfo.outputPath("shared-svg-converted.png") });
    await expect.poll(async () => (await savedSnapshot()).shapes.filter((shape) => shape.type === "geo" || shape.type === "line").length).toBeGreaterThan(0);
    const converted = await savedSnapshot();
    const nodes = (shape: OverlaySnapshot["shapes"][number]): InlineNode[] => shape.type === "text" ? shape.props.blocks.flatMap((block) => block.type === "paragraph" ? block.children : []) : [];
    const texts = converted.shapes.filter((shape) => shape.type === "text");
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.flatMap(nodes).some((node) => node.type === "mathInline" && node.tex.includes("V(z)"))).toBe(true);
    expect(converted.shapes.some((shape) => shape.type === "group")).toBe(true);
    // Kept SVG fragments are new images; the shared session stores them by reference like any other image.
    const fragments = Object.values(converted.assets);
    expect(fragments.length).toBeGreaterThan(0);
    for (const asset of fragments) expect(asset.props.src).toMatch(/^sigma-doc-storage:\/\/[\w-]+$/);
    expect(converted.assets).not.toHaveProperty(Object.keys(before.assets)[0]);
    await expect.poll(() => page.locator(".overlay-shape-image img.overlay-image-shape").evaluateAll((images) =>
      images.length > 0 && images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const round = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "number" ? Math.round(child * 100) / 100 : child));
    // A reference document can carry coordinates that no longer match its block anchor. The editor re-anchors it on the
    // first layout as a history step of its own, so only the default fixture can promise a single Undo.
    if (!reference) {
      await page.keyboard.press(`${modifier}+z`);
      await expect.poll(async () => round(await savedSnapshot())).toEqual(round(before));
      await page.keyboard.press(`${modifier}+Shift+z`);
      await expect.poll(async () => round(await savedSnapshot())).toEqual(round(converted));
    }

    // The converted shapes survive cloud sync and a restart of the desktop app, not just the live session.
    await page.evaluate((id) => window.desktopAPI!.collaboration!.flush(id, true), seeded.fileId);
    expect(uploaded.size).toBe(fragments.length);
    expect(JSON.stringify(remote.project())).toContain('"type":"group"');
    const settled = await savedSnapshot();
    await app!.close(); app = undefined;
    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect.poll(async () => round(await savedSnapshot())).toEqual(round(settled));
    await expect.poll(() => page.locator(".overlay-shape-image img.overlay-image-shape").evaluateAll((images) =>
      images.length > 0 && images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("shared-svg-reloaded.png") });
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
