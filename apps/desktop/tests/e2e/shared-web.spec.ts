import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createBlankDocument } from "../../src/lib/blank-document";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "../../src/features/collaboration/model/protocol";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import type { SharedTargetRef } from "../../src/features/collaboration/model/catalog";

test.skip(process.env.SIGMA_WEB_E2E !== "1", "Run npm run web:build, npm run electron:build, then npm run test:e2e:web.");
const root = path.resolve(__dirname, "../../../..");
const appRoot = path.join(root, "apps/desktop");
const id = "00000000-0000-4000-8000-000000000001";
const nodeId = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000003";
let backend: Server, worker: ChildProcess, directory: string, site: string, upstream: string, document: SharedDocument;
let role = "owner";
let workerLogs = "";
const sockets = new Set<WebSocket>();
const codes = new Map<string, string>();
const acknowledgements = new Map<string, number>();
const requests: string[] = [];
const capabilities = Object.fromEntries(["read", "editDocument", "createChildren", "rename", "move", "deleteDescendants", "invite", "manageEditorViewer", "appointAdmin", "stopRootShare", "deleteRootShare", "restoreDocument", "startHierarchyShare"].map(key => [key, true]));
const token = "fixture-access-token";
const assetId = "00000000-0000-4000-8000-000000000004";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=", "base64");
const user = { id: actor, email: "fixture@example.test", user_metadata: { full_name: "Fixture" } };
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_PORT");
  return address.port;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  directory = mkdtempSync(path.join(tmpdir(), "sigma-shared-web-"));
  const portServer = createServer();
  const port = await listen(portServer);
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  site = `http://127.0.0.1:${port}`;
  document = new SharedDocument();
  const initial = createBlankDocument("共有の検証教材");
  initial.content = [{ type: "paragraph", id: "shared_paragraph", children: [{ type: "text", text: "Original shared text" }] }];
  initial.pageLayout!.overlay = { overlaySnapshot: { version: 1, shapes: [{ id: "shared-image", type: "image", x: 100, y: 100, rotation: 0, props: { assetId: "shared-asset", w: 40, h: 40 } }],
    assets: { "shared-asset": { id: "shared-asset", type: "image", props: { src: `sigma-doc-storage://${assetId}`, w: 1, h: 1, name: "fixture.png", mimeType: "image/png", isAnimated: false, fileSize: image.length } } } } };
  document.initialize(JSON.parse(JSON.stringify(initial)) as ObjectValue, { sharedDocumentId: id, epoch: 1 });
  backend = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", upstream);
    requests.push(`${request.method} ${url.pathname}`);
    const send = (value: unknown, status = 200) => {
      const body = JSON.stringify(value);
      if (url.pathname === "/catalog/delta") {
        const compressed = gzipSync(body);
        response.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip", "content-length": compressed.length }).end(compressed);
      } else response.writeHead(status, { "content-type": "application/json" }).end(body);
    };
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : {};
    if (url.pathname === "/auth/v1/authorize") {
      const code = crypto.randomUUID(); codes.set(code, url.searchParams.get("code_challenge") ?? "");
      const callback = new URL(url.searchParams.get("redirect_to")!); callback.searchParams.set("code", code);
      response.writeHead(302, { location: callback.href }).end(); return;
    }
    if (url.pathname === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "pkce" && codes.get(body.auth_code) !== createHash("sha256").update(body.code_verifier).digest("base64url")) return send({ error: "AUTH_FAILED" }, 400);
      return send({ access_token: token, refresh_token: "fixture-refresh", expires_in: 3600, user });
    }
    if (request.headers.authorization !== `Bearer ${token}`) return send({ error: "AUTH_REQUIRED" }, 401);
    if (url.pathname === "/auth/v1/user") return send(user);
    if (url.pathname === "/auth/v1/logout") return send({ ok: true });
    if (url.pathname === `/documents/${id}/assets/${assetId}`) { response.writeHead(200, { "content-type": "image/png" }).end(image); return; }
    if (url.pathname === "/profile") return send({ userId: actor, displayName: "Fixture", avatarVersion: 0 });
    if (url.pathname === "/catalog/capabilities") return send({ hierarchySharingEnabled: true, canStartDocumentShare: true, documentShareSource: "free", canStartHierarchyShare: false, hierarchyShareSource: "none", plan: "free" });
    if (url.pathname === "/catalog/delta") return send({ revision: 1, nodes: [{ id: nodeId, kind: "document", parentId: null, isShareRoot: true, ownerId: actor, createdBy: actor, name: "共有の検証教材", sharedDocumentId: id, state: "active", role, capabilities: { ...capabilities, editDocument: role !== "viewer" }, titleVersion: 1, revision: 1 }], tombstones: [] });
    if (url.pathname === "/documents") return send([]);
    if (url.pathname === `/documents/${id}/snapshot`) return send({ state: toBase64(document.snapshot()), epoch: 1, role, protocol: 1 });
    if (url.pathname === `/documents/${id}/sync`) return send({ update: toBase64(document.difference(fromBase64(body.vector))), epoch: 1, role, protocol: 1 });
    if (url.pathname === `/documents/${id}/updates`) {
      if (role === "viewer") return send({ error: "READ_ONLY" }, 403);
      return send({ acks: body.operations.map((operation: { operationId: string; update: string; actorId: string; kind: string }) => {
        if (!acknowledgements.has(operation.operationId)) {
          document.applyUpdate(fromBase64(operation.update));
          acknowledgements.set(operation.operationId, acknowledgements.size + 1);
          for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify({ type: "update", update: operation.update, identity: { operationId: operation.operationId, actorId: operation.actorId, kind: operation.kind } }));
        }
        return { operationId: operation.operationId, seq: acknowledgements.get(operation.operationId) };
      }) });
    }
    if (url.pathname.endsWith("/title-projection")) return send({ catalogNodeId: nodeId, name: "共有の検証教材", titleVersion: 1, revision: 1 });
    if (url.pathname.endsWith("/backups")) return send([]);
    if (url.pathname.endsWith("/members")) return send([{ user_id: actor, role, email: user.email }]);
    return send({ error: "NOT_FOUND" }, 404);
  });
  upstream = `http://127.0.0.1:${await listen(backend)}`;
  const wss = new WebSocketServer({ noServer: true });
  backend.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, connection => {
      sockets.add(connection); connection.on("close", () => sockets.delete(connection));
      connection.send(JSON.stringify({ type: "roster", ownClientId: crypto.randomUUID(), participants: [] }));
    });
  });
  const configuration = { name: "sigma-web-fixture", main: path.join(root, "apps/web/worker.mjs"), compatibility_date: "2026-10-20", assets: { directory: path.join(appRoot, "out"), binding: "ASSETS", run_worker_first: ["/api/*", "/auth/callback/*"] },
    vars: { APP_ORIGIN: site, ALLOW_LOCAL_AUTH: "true", SIGMA_COLLABORATION_URL: upstream, SIGMA_SUPABASE_URL: upstream, SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture" } };
  writeFileSync(path.join(directory, "wrangler.json"), JSON.stringify(configuration));
  writeFileSync(path.join(directory, ".dev.vars"), "SESSION_SECRET=fixture-session-encryption-secret-32-bytes-minimum\n", { mode: 0o600 });
  worker = spawn(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", path.join(directory, "wrangler.json"), "--port", String(port), "--ip", "127.0.0.1"], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout?.on("data", value => { workerLogs = (workerLogs + value).slice(-4000); }); worker.stderr?.on("data", value => { workerLogs = (workerLogs + value).slice(-4000); });
  await expect.poll(async () => {
    if (worker.exitCode !== null) throw new Error(`Worker exited: ${workerLogs}`);
    try { return (await fetch(`${site}/api/auth/session`)).status; } catch { return 0; }
  }, { timeout: 90_000 }).toBe(401);
});
test.afterAll(async () => {
  worker?.kill("SIGTERM");
  if (worker && worker.exitCode === null) await new Promise<void>(resolve => worker.once("exit", () => resolve()));
  for (const socket of sockets) socket.terminate();
  if (backend) await new Promise<void>(resolve => backend.close(() => resolve()));
  document?.destroy(); if (directory) rmSync(directory, { recursive: true, force: true });
});

test("shared-only Web and real Electron exchange edits through the same backend document", async ({ page }) => {
  test.setTimeout(120_000);
  expect(existsSync(path.join(appRoot, "dist-electron/main.cjs"))).toBe(true);
  await page.goto(site);
  await page.getByRole("button", { name: "Googleでログイン" }).click();
  await expect(page.getByRole("button", { name: "共有の検証教材", exact: true })).toBeVisible().catch(error => {
    throw new Error(`${String(error)}\nFixture requests: ${JSON.stringify(requests)}\n${workerLogs}`);
  });
  await expect(page.getByRole("button", { name: "新規教材", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "共有の検証教材", exact: true }).click();
  const paragraph = page.locator('.page-flow [data-sigma-doc-id="shared_paragraph"]').first();
  await expect(paragraph).toContainText("Original shared text");
  await expect.poll(() => page.locator(`img[src*="/assets/${assetId}"]`).first().evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  await paragraph.click(); await page.keyboard.press("End"); await page.keyboard.insertText(" Web edit");
  await expect.poll(() => JSON.stringify(document.project())).toContain("Web edit");

  const profile = path.join(directory, "electron-profile");
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_STUDIO_DEV_SERVER_URL: site,
    SIGMA_COLLABORATION_URL: upstream, SIGMA_SUPABASE_URL: upstream, SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [appRoot], cwd: appRoot, env });
    await app.evaluate(({ shell }) => { shell.openExternal = async url => { await fetch(url); }; });
    const desktop = await app.firstWindow();
    await desktop.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    await desktop.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      await window.desktopAPI!.collaboration!.signInWithGoogle();
      await window.desktopAPI!.sharedCatalog!.refresh();
    });
    await desktop.evaluate(async target => {
      const opened = await window.desktopAPI!.sharedCatalog!.openLink!(target as SharedTargetRef);
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [opened.fileId!], activeFileId: opened.fileId! });
    }, { kind: "document", catalogNodeId: nodeId, sharedDocumentId: id });
    await desktop.reload();
    const other = desktop.locator('.page-flow [data-sigma-doc-id="shared_paragraph"]').first();
    await expect(other).toContainText("Web edit");
    await other.click(); await desktop.keyboard.press("End"); await desktop.keyboard.insertText(" Electron edit");
    await expect(paragraph).toContainText("Electron edit", { timeout: 20_000 });
    await page.reload();
    await page.getByRole("button", { name: "共有の検証教材", exact: true }).click();
    await expect(paragraph).toContainText("Web edit"); await expect(paragraph).toContainText("Electron edit");
    const localCount = await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      if (!databases.some(database => database.name === "sigma-studio")) return 0;
      return new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("sigma-studio");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result, read = database.transaction("documents").objectStore("documents").count();
          read.onsuccess = () => { database.close(); resolve(read.result); };
          read.onerror = () => { database.close(); reject(read.error); };
        };
      });
    });
    expect(localCount).toBe(0);
    await page.screenshot({ path: path.join(root, "test-results/shared-web-electron.png") });
  } finally { await app?.close(); }
});

test("Web viewer permissions keep the shared document read-only", async ({ page }) => {
  role = "viewer";
  try {
    await page.goto(site); await page.getByRole("button", { name: "Googleでログイン" }).click();
    await page.getByRole("button", { name: "共有の検証教材", exact: true }).click();
    await expect(page.locator('.page-flow [data-sigma-doc-id="shared_paragraph"]').first()).toBeVisible();
    await expect(page.locator('.page-flow [contenteditable="true"]')).toHaveCount(0);
  } finally { role = "owner"; }
});
