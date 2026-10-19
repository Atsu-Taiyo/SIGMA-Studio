import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { getDefaultPageLayout, type OverlayAsset, type OverlayShape, type SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

/**
 * #251: a shared document's edits refused with MISSING_ASSET stayed on the device and were resent
 * forever ("Reconnect" repeated the same 400). The fixture server validates like the deployed one:
 * it applies every operation and refuses it unless each `src` is an image uploaded to this document.
 */
const actorId = "55555555-5555-4555-8555-555555555555";
/** A 1×1 PNG, for images made without a page. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
type Snapshot = { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> };

class Refusal extends Error {
  constructor(readonly missing: string[], readonly invalid: string[]) { super(invalid.length ? "INVALID_ASSET_REFERENCE" : "MISSING_ASSET"); }
}

async function fixture(sharedId: string, namesMissing: boolean) {
  const state = {
    remote: new SharedDocument(),
    assets: new Map<string, { type: string; bytes: Buffer }>(),
    receipts: new Map<string, { hash: string; seq: number }>(),
    sequence: 0,
    offline: false,
    updateRequests: 0,
    refusals: 0,
  };
  const validate = (document: unknown) => {
    const missing = new Set<string>(), invalid = new Set<string>();
    const visit = (value: unknown, owner: string): void => {
      if (Array.isArray(value)) return value.forEach((child) => visit(child, owner));
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : owner;
      if (typeof item.src === "string") {
        const match = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})$/.exec(item.src);
        if (!match) invalid.add(id);
        else if (!state.assets.has(match[1])) missing.add(match[1]);
      }
      Object.values(item).forEach((child) => visit(child, id));
    };
    visit(document, "");
    if (missing.size || invalid.size) throw new Refusal([...missing], [...invalid]);
  };
  const server = createServer(async (request, response) => {
    const prefix = `/documents/${sharedId}`;
    const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!request.url?.startsWith(prefix) || state.offline) return json({ error: "FIXTURE_OFFLINE" }, 503);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (request.url.startsWith(`${prefix}/assets/`)) {
      const id = request.url.split("/").at(-1)!;
      if (request.method === "PUT") { state.assets.set(id, { type: String(request.headers["content-type"]), bytes }); return json({ assetId: id }); }
      const asset = state.assets.get(id);
      if (!asset) return json({ error: "MISSING_ASSET" }, 404);
      return response.writeHead(200, { "Content-Type": asset.type }).end(asset.bytes);
    }
    const body = bytes.length ? JSON.parse(bytes.toString()) as Record<string, unknown> : {};
    if (request.url === `${prefix}/members`) return json([{ user_id: actorId, role: "editor", email: "editor@example.com" }]);
    if (request.url === `${prefix}/sync`)
      return json({ update: toBase64(state.remote.difference(fromBase64(String(body.vector)))), role: "editor", epoch: 1, protocol: 1 });
    if (request.url === `${prefix}/updates`) {
      state.updateRequests++;
      const acks: { operationId: string; seq: number }[] = [];
      for (const operation of body.operations as { operationId: string; update: string }[]) {
        const update = fromBase64(operation.update);
        const hash = createHash("sha256").update(update).digest("hex");
        const receipt = state.receipts.get(operation.operationId);
        if (receipt) {
          if (receipt.hash !== hash) return json({ error: "OPERATION_REUSED" }, 400);
          acks.push({ operationId: operation.operationId, seq: receipt.seq });
          continue;
        }
        try { state.remote.prepareUpdate(update, validate).destroy(); }
        catch (error) {
          if (!(error instanceof Refusal)) throw error;
          state.refusals++;
          return json(namesMissing
            ? { error: error.message, missingAssetIds: error.missing, invalidAssetReferences: error.invalid, operationId: operation.operationId }
            : { error: "MISSING_ASSET" }, 400);
        }
        state.remote.applyUpdate(update);
        state.receipts.set(operation.operationId, { hash, seq: ++state.sequence });
        acks.push({ operationId: operation.operationId, seq: state.sequence });
      }
      return json({ acks });
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/documents/${sharedId}/socket` || state.offline) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_PORT_REQUIRED");
  return {
    state, endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      state.remote.destroy();
    },
  };
}

/** A signed-in profile with one shared whiteboard whose journal matches the server's document. */
async function profileWith(title: string, endpoint: string, sharedId: string, remote: SharedDocument) {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-missing-asset-"));
  const directory = path.join(profile, "collaboration-v1");
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    NODE_ENV: "development", SIGMA_STUDIO_USER_DATA_DIR: profile,
    SIGMA_COLLABORATION_URL: endpoint, SIGMA_SUPABASE_URL: endpoint, SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app: ElectronApplication | undefined;
  const launch = async (): Promise<Page> => {
    const nativeKeyring = process.platform === "linux"
      ? { executablePath: createRequire(path.join(root, "package.json"))("electron") as string }
      : {};
    app = await electron.launch({ ...nativeKeyring, args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  const close = async () => { await app?.close(); app = undefined; };
  let page = await launch();
  const board: SigmaDocument = { ...createBlankDocument(title), content: [], pageLayout: getDefaultPageLayout("whiteboard") };
  // Editors on two devices patch one overlay (each creating it would keep only one of them).
  board.pageLayout!.overlay = { overlaySnapshot: { version: 1, shapes: [], assets: {} } };
  const seeded = await page.evaluate(async (input) => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const api = window.desktopAPI!.storage;
    const created = await api.createFileFromDocument({ document: input });
    await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    return { fileId: created.file.fileId, workspaceId: created.file.workspaceId, document: (await api.loadDocument(created.file.fileId))! };
  }, board);
  const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
    return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
  }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600, user: { id: actorId } });
  await close();
  remote.initialize(JSON.parse(JSON.stringify(seeded.document)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
  const journal = await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
    sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: seeded.fileId, docId: seeded.document.docId,
  }, new SharedDocument(remote.snapshot()));
  await writeFile(path.join(directory, "registry.json"), JSON.stringify({ version: 1, files: {
    [seeded.fileId]: { sharedDocumentId: sharedId, actorId, role: "editor", operationId: crypto.randomUUID(), initialized: true },
  } }));
  await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
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
  const open = async () => {
    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await (await app!.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1000));
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const ledger = async () => (await readFile(path.join(profile, "data/logs/ledger.log"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    profile, directory, fileId: seeded.fileId, journal, open, close, ledger,
    app: () => app,
    dispose: async () => {
      await close().catch(() => {});
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    },
  };
}

async function imageFile(page: Page, name: string, color: string, width = 160, height = 100) {
  const dataUrl = await page.evaluate(({ color, width, height }) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png");
  }, { color, width, height });
  return { name, mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1]!, "base64") };
}
function snapshotOf(document: unknown): Snapshot {
  return ((document as SigmaDocument).pageLayout?.overlay?.overlaySnapshot ?? { shapes: [], assets: {} }) as Snapshot;
}
function imageNames(document: unknown): string[] {
  const snapshot = snapshotOf(document);
  return snapshot.shapes.filter((shape) => shape.type === "image")
    .map((shape) => snapshot.assets[(shape.props as { assetId: string }).assetId]?.props.name ?? "?").sort();
}
async function localDocument(page: Page, fileId: string): Promise<SigmaDocument> {
  return (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!;
}
async function shapeIdNamed(page: Page, fileId: string, name: string): Promise<string> {
  const snapshot = snapshotOf(await localDocument(page, fileId));
  const shape = snapshot.shapes.find((item) => item.type === "image" && snapshot.assets[(item.props as { assetId: string }).assetId]?.props.name === name);
  if (!shape) throw new Error(`NO_IMAGE_${name}`);
  return shape.id;
}
async function expectImagesDrawn(page: Page, count: number) {
  const images = page.locator(".overlay-shape-image img.overlay-image-shape");
  await expect(images).toHaveCount(count, { timeout: 30_000 });
  for (let index = 0; index < count; index++)
    await expect.poll(() => images.nth(index).evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
}

test("image edits made offline survive a restart, and images the server lacks are sent again", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const sharedId = "77777777-7777-4777-8777-777777777777";
  // The deployed server: it says MISSING_ASSET without naming the images.
  const server = await fixture(sharedId, false);
  const shared = await profileWith("オフラインの画像編集", server.endpoint, sharedId, server.state.remote);
  try {
    shared.journal.document.destroy();
    let page = await shared.open();
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 30_000 });
    // A normal sync repairs nothing (MISS.md R3).
    expect((await shared.ledger()).filter((entry) => entry.event === "shared-asset-repair")).toEqual([]);

    // 1. Offline: add two images, replace one, delete the other, then undo/redo/undo the delete.
    server.state.offline = true;
    await page.locator('header input[type="file"][multiple][accept*="image/"]').setInputFiles([
      await imageFile(page, "a.png", "#2563eb"), await imageFile(page, "b.png", "#dc2626", 100, 160),
    ]);
    await expectImagesDrawn(page, 2);
    await expect.poll(async () => imageNames(await localDocument(page, shared.fileId))).toEqual(["a.png", "b.png"]);
    const b = page.locator(`[data-overlay-shape-id="${await shapeIdNamed(page, shared.fileId, "b.png")}"]`);
    // Both inserted images start selected; replacing is offered for one image.
    const canvas = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
    await page.mouse.click(canvas.x + 120, canvas.y + 160);
    await expect(page.locator(".overlay-shape-image.selected")).toHaveCount(0);
    await b.click();
    await b.click({ button: "right" });
    // Electron opens the OS file dialog for the hidden input; hand the file to the same input instead.
    await page.evaluate(() => {
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (this: HTMLInputElement) { if (this.type !== "file") click.call(this); };
    });
    await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "画像を置き換え…", exact: true }).click();
    await page.locator('[data-testid="overlay-image-replacement-input"]').setInputFiles(await imageFile(page, "c.png", "#16a34a", 120, 120));
    await expect.poll(async () => imageNames(await localDocument(page, shared.fileId))).toEqual(["a.png", "c.png"]);
    // Edits closer together than the undo grouping (500ms) undo as one step.
    await page.waitForTimeout(800);
    await page.locator(`[data-overlay-shape-id="${await shapeIdNamed(page, shared.fileId, "a.png")}"]`).click();
    await page.keyboard.press("Delete");
    await expect.poll(async () => imageNames(await localDocument(page, shared.fileId))).toEqual(["c.png"]);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(async () => imageNames(await localDocument(page, shared.fileId))).toEqual(["a.png", "c.png"]);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect.poll(async () => imageNames(await localDocument(page, shared.fileId))).toEqual(["c.png"]);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(async () => imageNames(await localDocument(page, shared.fileId))).toEqual(["a.png", "c.png"]);
    await expect(page.getByRole("status", { name: "オフライン" })).toBeVisible({ timeout: 30_000 });
    await shared.close();

    // 2. While the app is closed: the edits are in the journal. This device's image cache is made to
    //    say "uploaded" although the server never received them (the state the report ended in), and
    //    another device adds an image to the same document.
    const pending = await SharedDocumentJournal.inspect(path.join(shared.directory, "documents", sharedId));
    expect(pending.pending).toBeGreaterThan(0);
    const assetFolder = path.join(shared.directory, "assets", sharedId);
    const cached = (await readdir(assetFolder)).filter((name) => name.endsWith(".json"));
    expect(cached.length).toBeGreaterThanOrEqual(3);
    for (const name of cached) {
      const item = JSON.parse(await readFile(path.join(assetFolder, name), "utf8")) as { source: string; uploaded: boolean };
      expect(item.uploaded).toBe(false);
      await writeFile(path.join(assetFolder, name), JSON.stringify({ ...item, uploaded: true }));
    }
    const other = new SharedDocument(server.state.remote.snapshot());
    const before = other.project();
    const after = structuredClone(before) as unknown as SigmaDocument;
    const otherPixels = Buffer.from(PIXEL, "base64");
    server.state.assets.set("image-from-other-device", { type: "image/png", bytes: otherPixels });
    const snapshot = after.pageLayout!.overlay!.overlaySnapshot!;
    snapshot.shapes.push({ id: "shape_remote", type: "image", x: 600, y: 400, rotation: 0, props: { assetId: "asset_remote", w: 160, h: 100 } } as OverlayShape);
    snapshot.assets.asset_remote = { id: "asset_remote", type: "image", props: { w: 160, h: 100, name: "remote.png", isAnimated: false, mimeType: "image/png", src: "sigma-doc-storage://image-from-other-device", fileSize: otherPixels.length } };
    const vector = other.vector();
    other.change(before, JSON.parse(JSON.stringify(after)) as ObjectValue);
    server.state.remote.applyUpdate(other.difference(vector));
    other.destroy();

    // 3. Back online: the refused edits are repaired by sending the images again, and sync.
    server.state.offline = false;
    page = await shared.open();
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 60_000 });
    expect(server.state.refusals).toBeGreaterThan(0);
    const remoteNames = imageNames(server.state.remote.project());
    expect(remoteNames).toEqual(["a.png", "c.png", "remote.png"]);
    for (const [, asset] of Object.entries(snapshotOf(server.state.remote.project()).assets))
      expect(server.state.assets.has(asset.props.src.slice(20))).toBe(true);
    expect(imageNames(await localDocument(page, shared.fileId))).toEqual(remoteNames);
    // Every operation reached the server once.
    expect(server.state.sequence).toBe(server.state.receipts.size);
    const repairs = (await shared.ledger()).filter((entry) => entry.event === "shared-asset-repair");
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.some((entry) => Number(entry.resent) >= 2)).toBe(true);
    await expectImagesDrawn(page, 3);
    await page.screenshot({ path: testInfo.outputPath("offline-images-synced.png") });

    // 4. After another restart the document and its images are still there, with nothing left to send.
    await shared.close();
    const journal = await SharedDocumentJournal.open(path.join(shared.directory, "documents", sharedId));
    expect(journal.outbox()).toHaveLength(0);
    journal.document.destroy();
    page = await shared.open();
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 60_000 });
    expect(imageNames(await localDocument(page, shared.fileId))).toEqual(["a.png", "c.png", "remote.png"]);
    await expectImagesDrawn(page, 3);
  } finally {
    await shared.dispose();
    await server.close();
  }
});

test("edits that need an image found nowhere are kept, not resent forever, and sync once it is replaced", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const sharedId = "88888888-8888-4888-8888-888888888888";
  // A server with #251: it names the missing images.
  const server = await fixture(sharedId, true);
  const shared = await profileWith("見つからない画像", server.endpoint, sharedId, server.state.remote);
  try {
    // Edits saved on this device before: one refers to an image neither this device nor the server
    // has, the next adds an image this device has not sent yet.
    const okPixels = Buffer.from(PIXEL, "base64");
    const edit = (change: (document: SigmaDocument) => void) => {
      const document = shared.journal.document;
      const before = document.project(), after = structuredClone(before) as unknown as SigmaDocument, vector = document.vector();
      change(after);
      document.change(before, JSON.parse(JSON.stringify(after)) as ObjectValue);
      return document.difference(vector);
    };
    const image = (document: SigmaDocument, key: string, name: string, src: string, x: number) => {
      const snapshot = document.pageLayout!.overlay!.overlaySnapshot!;
      snapshot.shapes.push({ id: `shape_${key}`, type: "image", x, y: 200, rotation: 0, props: { assetId: key, w: 160, h: 120 } } as OverlayShape);
      snapshot.assets[key] = { id: key, type: "image", props: { w: 160, h: 120, name, isAnimated: false, mimeType: "image/png", src, fileSize: okPixels.length } };
    };
    for (const update of [
      edit((document) => image(document, "asset_lost", "lost.png", "sigma-doc-storage://image-lost", 200)),
      edit((document) => image(document, "asset_ok", "ok.png", "sigma-doc-storage://image-ok", 500)),
    ]) await shared.journal.append(update, { operationId: crypto.randomUUID(), actorId, kind: "manual" }, true);
    shared.journal.document.destroy();
    const assetFolder = path.join(shared.directory, "assets", sharedId);
    await mkdir(assetFolder, { recursive: true });
    await writeFile(path.join(assetFolder, "image-ok.json"), JSON.stringify({ source: `data:image/png;base64,${okPixels.toString("base64")}`, uploaded: false }));

    const page = await shared.open();
    await expect(page.getByRole("status", { name: "端末保存済み・画像の確認が必要です" })).toBeVisible({ timeout: 60_000 });
    expect(server.state.assets.has("image-ok")).toBe(true);
    // Retries pull remote changes but do not send the refused edits again.
    const requests = server.state.updateRequests;
    await page.waitForTimeout(12_000);
    expect(server.state.updateRequests).toBe(requests);
    await expect(page.getByRole("status", { name: "端末保存済み・画像の確認が必要です" })).toBeVisible();
    expect(imageNames(server.state.remote.project())).toEqual([]);
    expect(imageNames(await localDocument(page, shared.fileId))).toEqual(["lost.png", "ok.png"]);

    // The status names the image and offers the way through.
    await page.getByRole("button", { name: "同期を止めている画像を確認" }).click();
    const details = page.locator("[data-sync-detail]");
    await expect(details).toBeVisible();
    await expect(details).toContainText(/未同期の編集 \d+件（この端末に保存済み）/);
    await expect(details).toContainText("lost.png");
    await expect(details).toContainText("この端末にも共有サーバーにもありません");
    await page.waitForTimeout(500);
    await page.screenshot({ path: testInfo.outputPath("missing-image-recovery.png") });
    await details.getByRole("button", { name: "仮の画像に置き換えて同期" }).click();
    await expect(page.locator("[data-sync-detail]")).toHaveCount(0, { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 30_000 });
    const remote = snapshotOf(server.state.remote.project());
    expect(imageNames(server.state.remote.project())).toEqual(["lost.png", "ok.png"]);
    expect(remote.assets.asset_lost.props).toMatchObject({ name: "lost.png", mimeType: "image/svg+xml" });
    expect(server.state.assets.has(remote.assets.asset_lost.props.src.slice(20))).toBe(true);
    await expectImagesDrawn(page, 2);
    await page.screenshot({ path: testInfo.outputPath("missing-image-replaced.png") });

    await shared.close();
    const reopened = await shared.open();
    await expect(reopened.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 60_000 });
    expect(imageNames(await localDocument(reopened, shared.fileId))).toEqual(["lost.png", "ok.png"]);
    await expectImagesDrawn(reopened, 2);
  } finally {
    await shared.dispose();
    await server.close();
  }
});
