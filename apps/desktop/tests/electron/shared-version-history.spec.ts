import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

type VersionKind = "auto" | "manual" | "restore";
/** Version ids are UUIDs, as the server issues them (the IPC refuses anything else). */
const MANUAL_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const AUTO_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const BEFORE_RESTORE_ID = "aaaaaaaa-0000-4000-8000-000000000003";
/** An image only the 20-minutes-ago version has: the current document no longer refers to it. */
const VERSION_ONLY_ASSET_ID = "version-only-figure";
const FIGURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect x="4" y="4" width="112" height="72" fill="#2563eb"/></svg>';
interface FixtureVersion { id: string; kind: VersionKind; created_at: string; epoch: number; document: SigmaDocument }

/**
 * 共有教材の過去の版 (#244)。版は共有サーバーが残し、「過去の版」は端末の版履歴ではなくサーバーの版を見せる。
 * 見るのは参加者全員、戻すのは編集者以上。戻すと参加者全員の教材が戻り、戻す前の状態も版として残る。
 *
 * この偽サーバーは本物と同じく、閲覧者の復元を断り、復元の前の状態を `restore` の版として足し、
 * 復元で世代 (epoch) を進めて新しい世代の状態をスナップショットで返す (MISS.md R5)。
 */
test("a shared document's server versions are listed, previewed, and restored for everyone by an editor only", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-shared-versions-"));
  const sharedId = "88888888-8888-4888-8888-888888888888";
  const actorId = "55555555-5555-4555-8555-555555555555";
  const directory = path.join(profile, "collaboration-v1");
  let remote = new SharedDocument();
  let epoch = 1;
  let role: "editor" | "viewer" = "editor";
  /** 戻した後の世代で、この利用者に渡す権限 (閲覧者になった場合の見え方を同じ流れで確かめる)。 */
  let roleAfterRestore: "editor" | "viewer" | null = null;
  let sequence = 0;
  const versions = new Map<string, FixtureVersion>();
  const restoreRequests: { backupId: string; operationId: string; role: string }[] = [];
  const assetRequests: string[] = [];
  const server = createServer(async (request, response) => {
    const prefix = `/documents/${sharedId}`;
    const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!request.url?.startsWith(prefix)) {
      json({ error: "FIXTURE_OFFLINE" }, 503);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    const action = request.url.slice(prefix.length + 1);
    if (action.startsWith("assets/") && request.method === "GET") {
      assetRequests.push(action.slice("assets/".length));
      if (action === `assets/${VERSION_ONLY_ASSET_ID}`) response.writeHead(200, { "Content-Type": "image/svg+xml" }).end(FIGURE_SVG);
      else json({ error: "ASSET_UNAVAILABLE" }, 404);
      return;
    }
    if (action === "sync" && body.vector) {
      if (body.epoch !== epoch) { json({ error: "EPOCH_CHANGED" }, 409); return; }
      json({ update: toBase64(remote.difference(fromBase64(body.vector))), role, epoch, protocol: 1 });
    } else if (action === "updates" && Array.isArray(body.operations)) {
      json({ acks: body.operations.map((operation: { operationId: string; update: string }) => {
        remote.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: ++sequence };
      }) });
    } else if (action === "snapshot" && request.method === "GET") {
      json({ state: toBase64(remote.snapshot()), role, epoch, protocol: 1 });
    } else if (action === "backups" && request.method === "GET") {
      json([...versions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(({ id, kind, created_at, epoch: versionEpoch }) => ({ id, kind, created_at, epoch: versionEpoch })));
    } else if (action.startsWith("backups/") && request.method === "GET") {
      const version = versions.get(action.slice("backups/".length));
      if (!version) { json({ error: "BACKUP_UNAVAILABLE" }, 404); return; }
      json(version);
    } else if (action === "restore" && request.method === "POST") {
      restoreRequests.push({ backupId: body.backupId, operationId: body.operationId, role });
      // The server refuses a viewer's write before reaching the restore itself.
      if (role === "viewer") { json({ error: "READ_ONLY" }, 403); return; }
      const target = versions.get(body.backupId);
      if (!target) { json({ error: "BACKUP_UNAVAILABLE" }, 404); return; }
      // The state everyone had just before, kept as a version of its own.
      versions.set(BEFORE_RESTORE_ID, {
        id: BEFORE_RESTORE_ID, kind: "restore", created_at: new Date().toISOString(), epoch,
        document: remote.project() as unknown as SigmaDocument,
      });
      epoch += 1;
      const restored = new SharedDocument();
      restored.initialize(JSON.parse(JSON.stringify(target.document)) as ObjectValue, { sharedDocumentId: sharedId, epoch });
      remote.destroy();
      remote = restored;
      if (roleAfterRestore) role = roleAfterRestore;
      json({ epoch });
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
  try {
    const document: SigmaDocument = {
      ...createBlankDocument("共有教材の版"),
      content: [{ type: "paragraph", id: "p_body", children: [{ type: "text", text: "いまの本文" }] }],
      pageLayout: getDefaultPageLayout(),
    };
    let page: Page = await launch();
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
    const withBody = (text: string, figure = false): SigmaDocument => ({
      ...structuredClone(seeded.document),
      content: [{ type: "paragraph", id: "p_body", children: [{ type: "text", text }] }],
      ...(figure ? { pageLayout: { ...structuredClone(seeded.document.pageLayout!), overlay: { overlaySnapshot: {
        version: 1,
        shapes: [{ id: "figure", type: "image", x: 100, y: 160, anchor: { type: "page" }, props: { assetId: "figure-asset", w: 240, h: 160 } }],
        assets: { "figure-asset": { id: "figure-asset", type: "image", props: { w: 120, h: 80, name: "図", mimeType: "image/svg+xml",
          isAnimated: false, fileSize: FIGURE_SVG.length, src: `sigma-doc-storage://${VERSION_ONLY_ASSET_ID}` } } },
      } } } } : {}),
    } as SigmaDocument);
    const now = Date.now();
    versions.set(MANUAL_ID, { id: MANUAL_ID, kind: "manual", created_at: new Date(now - 26 * 3600_000).toISOString(), epoch: 1, document: withBody("昨日手で保存した本文") });
    versions.set(AUTO_ID, { id: AUTO_ID, kind: "auto", created_at: new Date(now - 20 * 60_000).toISOString(), epoch: 1, document: withBody("20分前の本文", true) });
    await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
      sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: seeded.fileId, docId: seeded.document.docId,
    }, remote);
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

    page = await launch();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await (await app!.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1050));
    const body = page.locator('.text-flow-editor [data-sigma-doc-id="p_body"]').first();
    await expect(body).toHaveText(/いまの本文/);
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 30_000 });

    // 1. 共有教材にも「過去の版」が出て、サーバーの版を種類つきで新しい順に並べる。
    await page.locator(".version-history-button").click();
    const panel = page.locator(".version-history-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".version-history-note")).toContainText("参加者全員が見られます");
    const rows = panel.locator(".version-history-row:not(.version-history-current-row)");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("自動で保存");
    await expect(rows.nth(1)).toContainText("手動で保存");

    // 2. 版を選ぶと、編集面の代わりにその版の中身を読み取り専用で見せる。
    await rows.nth(0).click();
    const preview = page.locator(".version-history-preview");
    await expect(preview).toContainText("20分前の本文");
    await expect(preview.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    // その版にだけある画像も、版を見ている間は共有サーバーから取り寄せて描く。
    const figure = preview.locator("img.overlay-image-shape").first();
    await expect(figure).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => figure.evaluate((element) => (element as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(assetRequests).toContain(VERSION_ONLY_ASSET_ID);
    await page.screenshot({ path: testInfo.outputPath("shared-version-preview.png") });

    // 3. 戻す前に、参加者全員の教材が戻ることを帯の中で確かめる。キャンセルすると何も送らない。
    await preview.getByRole("button", { name: "この版に戻す" }).click();
    await expect(preview).toContainText("参加者全員の教材をこの版に戻します");
    await preview.getByRole("button", { name: "キャンセル" }).click();
    await expect(preview.getByRole("button", { name: "この版に戻す" })).toBeVisible();
    expect(restoreRequests).toHaveLength(0);
    await preview.getByRole("button", { name: "この版に戻す" }).click();
    await expect(preview.locator(".version-history-preview-confirm")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("shared-version-confirm.png") });
    roleAfterRestore = "viewer";
    await preview.getByRole("button", { name: "全員の教材を戻す" }).click();

    // 4. サーバーが版を戻し、新しい世代の教材が届いて編集面に出る。戻す前の状態は版として残る。
    await expect.poll(() => restoreRequests.length).toBe(1);
    expect(restoreRequests[0]).toMatchObject({ backupId: AUTO_ID, role: "editor" });
    expect(restoreRequests[0]!.operationId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(preview).toHaveCount(0, { timeout: 30_000 });
    await expect(body).toHaveText(/20分前の本文/, { timeout: 30_000 });
    expect(epoch).toBe(2);
    expect(JSON.stringify(versions.get(BEFORE_RESTORE_ID)?.document)).toContain("いまの本文");
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await expect(rows.nth(0)).toContainText("復元する前");
    await page.screenshot({ path: testInfo.outputPath("shared-version-restored.png") });

    // 5. 閲覧者は版を見られるが、戻せない (戻すボタンは出さず、理由を出す)。サーバーへも送らない。
    await expect(panel.locator(".version-history-note")).toContainText("版を戻せるのは編集者以上です", { timeout: 30_000 });
    await rows.nth(0).click();
    await expect(preview).toContainText("いまの本文");
    await expect(preview.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    await expect(preview.getByRole("button", { name: "この版に戻す" })).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "現在の版に戻る" })).toBeVisible();
    await expect(preview.locator(".version-history-preview-note")).toHaveText("版を戻せるのは編集者以上です。");
    expect(restoreRequests).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("shared-version-viewer.png") });
  } finally {
    await app?.close().catch(() => {});
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    remote.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
