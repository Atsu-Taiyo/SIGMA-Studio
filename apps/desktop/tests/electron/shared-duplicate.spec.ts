import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import type { CatalogNode, CatalogNodeId, SharedCapabilities, SharedDocumentId } from "@/features/collaboration/model/catalog";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

/** A 1×1 PNG: small, but a real image the page can decode. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const OFFLINE = "共有サーバーに接続できないため、教材を複製できませんでした。元の教材はそのままです。接続を確認して、もう一度お試しください。";
const capabilities = (overrides: Partial<SharedCapabilities> = {}): SharedCapabilities => ({
  read: true, editDocument: true, createChildren: true, rename: true, move: true, deleteDescendants: true,
  invite: false, manageEditorViewer: false, appointAdmin: false, stopRootShare: false, deleteRootShare: false,
  restoreDocument: false, startHierarchyShare: false, ...overrides,
});

function material(title: string, body: string, src: string): SigmaDocument {
  const pageLayout = getDefaultPageLayout();
  pageLayout.overlay = {
    overlaySnapshot: {
      version: 1,
      shapes: [{ id: "figure", type: "image", x: 120, y: 160, props: { assetId: "asset_figure", w: 160, h: 120 } }],
      assets: { asset_figure: { id: "asset_figure", type: "image", props: { w: 160, h: 120, name: "figure.png", isAnimated: false, mimeType: "image/png", src, fileSize: PNG.byteLength } } },
    },
  } as never;
  return { ...createBlankDocument(title), content: [{ type: "paragraph", id: "p_body", children: [{ type: "text", text: body }] }], pageLayout };
}

function sources(document: unknown): string[] {
  return [...JSON.stringify(document).matchAll(/"src":"([^"]+)"/g)].map((match) => match[1]);
}

/** What a copy must not change in the original: its text and its image. (Opening it may place the figure's anchor.) */
function essentials(document: SigmaDocument) {
  return { body: JSON.stringify(document.content), images: sources(document) };
}

/**
 * Issue #250: duplicating a cloud (shared) material failed with "Error invoking remote method
 * 'storage:duplicate-file': Error: …". Here the real Electron main, preload, encrypted sign-in, catalog,
 * sessions and journals run against a loopback sharing server that validates like the real one (a
 * document may only refer to images uploaded to that same document). A material in an editable shared
 * folder is duplicated into the folder with its image, a failed attempt explains itself in Japanese and
 * its retry makes one copy, a material shared on its own becomes a private copy (and the app says where),
 * and both copies keep their content and images after a restart without touching the originals.
 */
test("duplicates shared materials with their images, explains failures, and retries without extra copies", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-shared-duplicate-"));
  const directory = path.join(profile, "collaboration-v1");
  const actorId = randomUUID();
  const ownerId = randomUUID();
  let revision = 1;
  const nodes = new Map<string, CatalogNode>();
  const documents = new Map<string, { shared?: SharedDocument; assets: Map<string, { type: string; bytes: Buffer }> }>();
  const creates = new Map<string, { nodeId: string; sharedDocumentId: string | null }>();
  const createRequests: string[] = [];
  let dropAssetUploads = 0;
  const addNode = (node: Omit<CatalogNode, "revision" | "titleVersion" | "createdBy" | "isShareRoot"> & Partial<CatalogNode>) => {
    const value: CatalogNode = { revision: ++revision, titleVersion: 1, createdBy: node.ownerId, isShareRoot: node.parentId === null, ...node };
    nodes.set(value.id, value);
    return value;
  };
  const addDocument = (sharedDocumentId: string, document: SigmaDocument, assets: Record<string, Buffer>) => {
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId, epoch: 1 });
    documents.set(sharedDocumentId, { shared, assets: new Map(Object.entries(assets).map(([id, bytes]) => [id, { type: "image/png", bytes }])) });
  };
  const project = (sharedDocumentId: string) => JSON.parse(JSON.stringify(documents.get(sharedDocumentId)!.shared!.project())) as SigmaDocument;
  /** The real room refuses an `src` that is not an image uploaded to this same document. */
  const missingAsset = (sharedDocumentId: string, value: unknown) => sources(value).some((src) => {
    const match = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})$/.exec(src);
    return !match || !documents.get(sharedDocumentId)!.assets.has(match[1]);
  });

  // One shared folder another account shares with me (I may create in it), holding a material with an
  // image, and one material shared with me on its own.
  const folder = addNode({ id: randomUUID() as CatalogNodeId, kind: "folder", parentId: null, ownerId, name: "共有フォルダ", sharedDocumentId: null, state: "active", role: "editor", capabilities: capabilities() });
  const inFolderId = randomUUID();
  const inFolder = addNode({ id: randomUUID() as CatalogNodeId, kind: "document", parentId: folder.id, ownerId, name: "図つきの教材", sharedDocumentId: inFolderId as SharedDocumentId, state: "active", role: "editor", capabilities: capabilities() });
  addDocument(inFolderId, material("図つきの教材", "フォルダの教材の本文", "sigma-doc-storage://img_folder"), { img_folder: PNG });
  const aloneId = randomUUID();
  const alone = addNode({ id: randomUUID() as CatalogNodeId, kind: "document", parentId: null, ownerId, name: "受け取った教材", sharedDocumentId: aloneId as SharedDocumentId, state: "active", role: "editor", capabilities: capabilities({ createChildren: false }) });
  addDocument(aloneId, material("受け取った教材", "単独の教材の本文", "sigma-doc-storage://img_alone"), { img_alone: PNG });
  const originals = { inFolder: essentials(project(inFolderId)), alone: essentials(project(aloneId)) };

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const url = request.url ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (url === "/catalog/capabilities") { json({ hierarchySharingEnabled: true, canStartDocumentShare: true, documentShareSource: "entitlement", canStartHierarchyShare: true, hierarchyShareSource: "entitlement" }); return; }
    if (url === "/catalog/delta") {
      const known: string[] = JSON.parse(bytes.toString()).knownIds ?? [];
      json({ revision, nodes: [...nodes.values()], tombstones: known.filter((id) => !nodes.has(id)).map((id) => ({ id, deleted: true, revision })) });
      return;
    }
    if (url === "/catalog/nodes") {
      const input = JSON.parse(bytes.toString()) as { operationId: string; parentId: string; kind: "folder" | "document"; name: string };
      createRequests.push(input.operationId);
      const existing = creates.get(input.operationId);
      if (existing) { json(existing); return; }
      const parent = nodes.get(input.parentId);
      if (!parent?.capabilities.createChildren) { json({ error: "FORBIDDEN" }, 403); return; }
      const sharedDocumentId = input.kind === "document" ? randomUUID() : null;
      const created = addNode({ id: randomUUID() as CatalogNodeId, kind: input.kind, parentId: parent.id, ownerId: parent.ownerId, createdBy: actorId, name: input.name, sharedDocumentId: sharedDocumentId as SharedDocumentId | null, state: input.kind === "document" ? "initializing" : "active", role: parent.role, capabilities: parent.capabilities, isShareRoot: false });
      if (sharedDocumentId) documents.set(sharedDocumentId, { assets: new Map() });
      const result = { nodeId: created.id, sharedDocumentId };
      creates.set(input.operationId, result);
      json(result);
      return;
    }
    const match = /^\/documents\/([0-9a-f-]{36})\/(.+)$/.exec(url);
    const document = match && documents.get(match[1]);
    if (!match || !document) { json({ error: "NOT_FOUND" }, 404); return; }
    const [, id, action] = match;
    const node = [...nodes.values()].find((item) => item.sharedDocumentId === id)!;
    if (action.startsWith("assets/")) {
      const assetId = action.slice(7);
      if (request.method === "PUT") {
        // The connection drops while an image is being sent.
        if (dropAssetUploads > 0) { dropAssetUploads--; request.socket.destroy(); return; }
        document.assets.set(assetId, { type: String(request.headers["content-type"]), bytes });
        json({ ok: true });
        return;
      }
      const stored = document.assets.get(assetId);
      if (!stored) { json({ error: "MISSING_ASSET" }, 404); return; }
      response.writeHead(200, { "Content-Type": stored.type }).end(stored.bytes);
      return;
    }
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (action === "initialize") {
      if (!document.shared) {
        const candidate = new SharedDocument(fromBase64(body.state));
        if (missingAsset(id, candidate.project())) { candidate.destroy(); json({ error: "MISSING_ASSET" }, 400); return; }
        document.shared = candidate;
        node.state = "active";
        node.revision = ++revision;
      }
      json({ seq: 0 });
      return;
    }
    if (!document.shared) { json({ error: "NOT_INITIALIZED" }, 409); return; }
    if (action === "snapshot") { json({ state: toBase64(document.shared.snapshot()), role: node.role, epoch: 1 }); return; }
    if (action === "sync") { json({ update: toBase64(document.shared.difference(fromBase64(body.vector))), role: node.role, epoch: 1, protocol: 1 }); return; }
    if (action === "updates") {
      json({ acks: (body.operations as { operationId: string; update: string }[]).map((operation, index) => {
        document.shared!.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: index + 1 };
      }) });
      return;
    }
    json({ error: "NOT_FOUND" }, 404);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!/^\/documents\/[0-9a-f-]{36}\//.test(request.url ?? "")) { socket.destroy(); return; }
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
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
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
  const body = (page: Page) => page.locator('.text-flow-editor [data-sigma-doc-id="p_body"]').first();
  const imageShown = (page: Page) => page.locator("img.overlay-image-shape").first()
    .evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)
    .catch(() => false);
  const duplicateFromFileMenu = async (page: Page) => {
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "現在の教材を複製" }).click();
  };
  const copiesOf = (source: CatalogNode) => [...nodes.values()].filter((item) => item.kind === "document" && item.parentId === source.parentId && item.id !== source.id);
  try {
    // First run, signed out: the app's own settings, and encrypted credentials for the fixture account.
    let page = await launch();
    const home = await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const overview = await window.desktopAPI!.storage.getWorkspaceOverview();
      if (overview.state !== "ready") throw new Error("NO_LIBRARY");
      await window.desktopAPI!.storage.renameWorkspace(overview.overview.activeWorkspaceId, "マイ教材");
      return overview.overview.activeWorkspaceId;
    });
    const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user: { id: actorId } });
    await app!.close(); app = undefined;
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    // Both shared materials are open in tabs, the one in the folder in front.
    const inFolderFile = `file_${randomUUID()}`, aloneFile = `file_${randomUUID()}`;
    const cache = await CatalogCache.open(directory, actorId);
    cache.data.mappings[inFolder.id] = { nodeId: inFolder.id, local: { kind: "document", fileId: inFolderFile }, bodyCached: false };
    cache.data.mappings[alone.id] = { nodeId: alone.id, local: { kind: "document", fileId: aloneFile }, bodyCached: false };
    cache.data.workspaceState = { openFileIds: [inFolderFile, aloneFile], activeFileId: inFolderFile };
    await cache.save();

    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await (await app!.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1000));
    await expect(body(page)).toContainText("フォルダの教材の本文", { timeout: 60_000 });
    await expect.poll(() => imageShown(page), { timeout: 30_000 }).toBe(true);

    // 1. The connection drops while the copy's image is sent: a Japanese reason, the original stays open.
    dropAssetUploads = 1;
    await duplicateFromFileMenu(page);
    await expect(page.locator(".save-state.error").first()).toHaveText(OFFLINE, { timeout: 30_000 });
    await expect(page.getByText(/invoking|remote method/)).toHaveCount(0);
    await expect(body(page)).toContainText("フォルダの教材の本文");
    await page.screenshot({ path: testInfo.outputPath("01-duplicate-failed.png") });

    // 2. Retrying makes exactly one copy, in the same shared folder, with its own image.
    await duplicateFromFileMenu(page);
    await expect(page.getByRole("tab", { name: /図つきの教材-のコピー/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("dialog", { name: "教材を複製しました" })).toHaveCount(0);
    expect(copiesOf(inFolder).map((item) => [item.name, item.state])).toEqual([["図つきの教材-のコピー", "active"]]);
    expect(new Set(createRequests).size).toBe(1);
    const copyNode = copiesOf(inFolder)[0];
    const copySharedId = copyNode.sharedDocumentId!;
    const [copySource] = sources(project(copySharedId));
    expect(documents.get(copySharedId)!.assets.get(copySource.replace("sigma-doc-storage://", ""))?.bytes).toEqual(PNG);
    await expect(body(page)).toContainText("フォルダの教材の本文");
    await expect.poll(() => imageShown(page), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("02-duplicated-in-folder.png") });

    // 3. Editing the copy reaches the copy's shared document only.
    await body(page).click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("（コピーだけの追記）");
    await expect.poll(() => JSON.stringify(project(copySharedId)), { timeout: 30_000 }).toContain("コピーだけの追記");
    expect(essentials(project(inFolderId))).toEqual(originals.inFolder);

    // 4. A material shared with me on its own cannot get a sibling in the cloud: it becomes my own
    //    material on this PC, and the app says where it went.
    await page.getByRole("tab", { name: /受け取った教材/ }).click();
    await expect(body(page)).toContainText("単独の教材の本文", { timeout: 30_000 });
    await duplicateFromFileMenu(page);
    const dialog = page.getByRole("dialog", { name: "教材を複製しました" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator("[data-new-material-workspace]")).toHaveText("マイ教材");
    await expect(dialog.locator("[data-new-material-folder]")).toHaveText("ワークスペースの直下");
    await expect(dialog.locator("[data-new-material-storage]")).toHaveText("このPC");
    await expect(dialog).toContainText("複製元の場所には作成できないため、既定の作成先に複製しました。複製した教材は共有されていません。");
    await page.screenshot({ path: testInfo.outputPath("03-private-copy-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(body(page)).toContainText("単独の教材の本文");
    await expect.poll(() => imageShown(page), { timeout: 30_000 }).toBe(true);
    const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
    const privateCopy = files.find((file) => file.title === "受け取った教材-のコピー")!;
    expect(privateCopy).toMatchObject({ workspaceId: home, folderId: null });
    expect(privateCopy.sharing).toBeUndefined();
    expect(createRequests.length).toBe(2);

    // 5. After a restart both copies keep their content and images; the originals are unchanged.
    await app!.close(); app = undefined;
    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const copyFile = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.sharing?.target.catalogNodeId === copyNode.id)!;
    const reloaded = await page.evaluate(async ([shared, local]) => ({
      shared: await window.desktopAPI!.storage.loadDocument(shared),
      local: await window.desktopAPI!.storage.loadDocument(local),
    }), [copyFile.fileId, privateCopy.fileId] as const);
    expect(JSON.stringify(reloaded.shared)).toContain("コピーだけの追記");
    expect(sources(reloaded.shared)).toEqual([copySource]);
    expect(JSON.stringify(reloaded.local)).toContain("単独の教材の本文");
    expect(sources(reloaded.local)).toEqual([`data:image/png;base64,${PNG.toString("base64")}`]);
    await page.getByRole("tab", { name: /図つきの教材-のコピー/ }).click();
    await expect(body(page)).toContainText("コピーだけの追記", { timeout: 30_000 });
    await expect.poll(() => imageShown(page), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("04-copy-after-restart.png") });
    expect(essentials(project(inFolderId))).toEqual(originals.inFolder);
    expect(essentials(project(aloneId))).toEqual(originals.alone);
    expect([...nodes.values()].filter((item) => item.kind === "document")).toHaveLength(3);

    // 6. The material list duplicates a shared material the same way; a deliberate second duplicate is a new copy.
    await page.keyboard.press("ControlOrMeta+P");
    await page.getByPlaceholder("コマンドや設定を検索").fill("教材一覧を開く");
    await page.keyboard.press("Enter");
    const list = page.getByRole("dialog", { name: "教材一覧" });
    await expect(list).toBeVisible();
    await list.getByRole("group", { name: "図つきの教材-のコピーの操作" }).getByRole("button", { name: "複製" }).click();
    await expect(list).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /図つきの教材-のコピー-のコピー/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("dialog", { name: "教材を複製しました" })).toHaveCount(0);
    expect(copiesOf(inFolder).map((item) => [item.name, item.state])).toEqual([["図つきの教材-のコピー", "active"], ["図つきの教材-のコピー-のコピー", "active"]]);
    await expect(body(page)).toContainText("コピーだけの追記");
    await expect.poll(() => imageShown(page), { timeout: 30_000 }).toBe(true);
  } finally {
    await app?.close().catch(() => {});
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const document of documents.values()) document.shared?.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
