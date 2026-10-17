import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect x="10" y="10" width="180" height="100" fill="none" stroke="#111111"/><text x="100" y="66" text-anchor="middle">図1</text></svg>';
type FigureDraft = {
  operations: { operation?: string; overlayShape: OverlayShape; assets?: Record<string, OverlayAsset> }[];
  mutationOperations?: unknown[];
};
const REFUSED = "共有サーバーがこの教材の変更を受け付けなかったため、承認できませんでした。";

/**
 * MISS.md R21: a sync server whose document schema is older than the app refuses the document's oldest
 * unsent edit (400 INVALID_REQUEST), and every later edit waits behind it. The app used to show this as
 * "Offline" and every AI approval as a conflict ("the target was changed or deleted"). Here the app
 * shows the refusal as it is, keeps the edits on the device, and once the server accepts them again the
 * edits sync and the same proposal is approved.
 */
test("a server refusing a shared document's edits is shown as a refusal, and approving works once it accepts them", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-shared-sync-rejected-"));
  const sharedId = "77777777-7777-4777-8777-777777777777";
  const actorId = "55555555-5555-4555-8555-555555555555";
  const directory = path.join(profile, "collaboration-v1");
  const remote = new SharedDocument();
  const uploaded = new Map<string, { type: string; bytes: Buffer }>();
  let refuseUpdates = false;
  let refusedRequests = 0;
  let sequence = 0;
  let dropNextApprovalResponse = false;
  const approvalReceipts = new Map<string, { body: string; result: { update: string; operationId: string; seq: number } }>();
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
    if (request.url.startsWith(`${prefix}/assets/`)) {
      const id = request.url.split("/").at(-1)!;
      if (request.method === "PUT") { uploaded.set(id, { type: String(request.headers["content-type"]), bytes }); json({ ok: true }); }
      else response.writeHead(200, { "Content-Type": uploaded.get(id)?.type ?? "application/octet-stream" }).end(uploaded.get(id)?.bytes);
      return;
    }
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (request.url === `${prefix}/sync` && body.vector) {
      json({ update: toBase64(remote.difference(fromBase64(body.vector))), role: "editor", epoch: 1, protocol: 1 });
    } else if (request.url === `${prefix}/updates` && Array.isArray(body.operations)) {
      // What the deployed server did with shapes its older schema did not know.
      if (refuseUpdates) { refusedRequests++; json({ error: "INVALID_REQUEST" }, 400); return; }
      json({ acks: body.operations.map((operation: { operationId: string; update: string }) => {
        remote.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: ++sequence };
      }) });
    } else if (request.url === `${prefix}/approve` && Array.isArray(body.drafts ?? (body.draft ? [body.draft] : null))) {
      const receipt = approvalReceipts.get(body.operationId);
      if (receipt) {
        if (receipt.body !== JSON.stringify(body)) { json({ error: "OPERATION_REUSED" }, 409); return; }
        json(receipt.result);
        return;
      }
      // The server replays the approved drafts; this fixture knows only the figure insertion it is sent.
      const before = remote.project();
      const next = structuredClone(before) as unknown as SigmaDocument;
      const overlay = next.pageLayout!.overlay ??= {};
      const snapshot = overlay.overlaySnapshot ??= { version: 1, shapes: [], assets: {} };
      for (const draft of (body.drafts ?? [body.draft]) as FigureDraft[]) {
        if (draft.mutationOperations?.length) throw new Error("FIXTURE_UNEXPECTED_MUTATION");
        for (const operation of draft.operations) {
          if (operation.operation !== "insertOverlayShape") throw new Error(`FIXTURE_UNEXPECTED_${operation.operation}`);
          snapshot.shapes.push({ ...operation.overlayShape, anchor: operation.overlayShape.anchor ?? { type: "page" } });
          Object.assign(snapshot.assets, operation.assets ?? {});
        }
      }
      const candidate = new SharedDocument(remote.snapshot());
      candidate.change(before, JSON.parse(JSON.stringify(next)) as ObjectValue);
      const update = candidate.difference(remote.vector());
      candidate.destroy();
      remote.applyUpdate(update);
      const result = { update: toBase64(update), operationId: body.operationId, seq: ++sequence };
      approvalReceipts.set(body.operationId, { body: JSON.stringify(body), result });
      if (dropNextApprovalResponse) { dropNextApprovalResponse = false; response.destroy(); return; }
      json(result);
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
  const client = new Client({ name: "shared-sync-rejected", version: "1" });
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
      ...createBlankDocument("共有教材の同期"),
      content: [{ type: "paragraph", id: "p_body", children: [{ type: "text", text: "共有教材の本文" }] }],
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
    expect(JSON.stringify((await page.evaluate(() => window.desktopAPI!.collaboration!.info())).sessions)).toContain(sharedId);
    const body = page.locator('.text-flow-editor [data-sigma-doc-id="p_body"]').first();
    await expect(body).toBeVisible();
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 30_000 });

    // 1. The server starts refusing this document's edits. A typed edit stays on the device, and the
    //    sharing status says the server refuses it instead of "Offline".
    refuseUpdates = true;
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("（人の追記）");
    await expect.poll(() => refusedRequests, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByRole("status", { name: "端末保存済み・サーバーが受け付けません" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("status", { name: "オフライン" })).toHaveCount(0);
    expect(JSON.stringify(remote.project())).not.toContain("人の追記");
    await page.screenshot({ path: testInfo.outputPath("shared-sync-rejected-status.png") });

    // 2. The AI inserts an SVG figure (the user's case). Approving it fails on the refused sync, and the
    //    message says so instead of calling it a conflict; the proposal stays pending.
    await client.connect(new StdioClientTransport({
      command: await app!.evaluate(() => process.execPath),
      args: [path.join(root, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile },
      stderr: "pipe",
    }));
    const expectedRevision = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find((file) => file.fileId === seeded.fileId)!.revision;
    const inserted = await client.callTool({
      name: "insert_svg_image",
      arguments: { fileId: seeded.fileId, expectedRevision, targetId: "p_body", svg: SVG, name: "図1", w: 240 },
    });
    expect(inserted.isError, JSON.stringify(inserted)).not.toBe(true);
    expect(inserted.structuredContent).toMatchObject({ ok: true, data: { proposalCreated: true } });
    const pending = () => page.evaluate((id) => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })
      .then((items) => items.filter((item) => item.fileId === id)), seeded.fileId);
    await expect.poll(async () => (await pending()).length).toBe(1);
    const apply = page.getByRole("button", { name: "適用", exact: true }).first();
    await expect(apply).toBeVisible({ timeout: 30_000 });
    await apply.click();
    await expect(page.getByText(REFUSED).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("対象ブロックが変更または削除されている可能性があります")).toHaveCount(0);
    expect(await pending()).toHaveLength(1);
    // The card leaves its busy state, so the same proposal can be approved again.
    await expect(apply).toBeEnabled({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("shared-sync-rejected-approval.png") });

    // 3. The server is updated and accepts the edits: the waiting edit reaches it, and the same
    //    proposal is approved — the SVG is in the shared document and on the page.
    refuseUpdates = false;
    await page.evaluate((id) => window.desktopAPI!.collaboration!.flush(id, true), seeded.fileId);
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 30_000 });
    expect(JSON.stringify(remote.project())).toContain("人の追記");
    dropNextApprovalResponse = true;
    await apply.click();
    await expect(page.getByText("共有教材をクラウドと同期できなかったため、承認できませんでした。接続を確認してから、もう一度承認してください。").first()).toBeVisible();
    expect(await pending()).toHaveLength(1);
    expect(approvalReceipts.size).toBe(1);
    const appliedSequence = sequence;
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(async () => (await pending()).length, { timeout: 30_000 }).toBe(0);
    await expect(page.locator("[data-ai-proposal-card]")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(REFUSED)).toHaveCount(0);
    const remoteShapes = () => ((remote.project() as unknown as SigmaDocument).pageLayout?.overlay?.overlaySnapshot?.shapes ?? []);
    await expect.poll(() => remoteShapes().filter((shape) => shape.type === "image").length).toBe(1);
    expect(approvalReceipts.size).toBe(1);
    expect(sequence).toBe(appliedSequence);
    const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), seeded.fileId);
    expect(saved!.pageLayout!.overlay!.overlaySnapshot!.shapes.some((shape) => shape.type === "image")).toBe(true);
    expect(JSON.stringify(saved)).toContain("人の追記");
    const image = page.locator("img.overlay-image-shape").first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(JSON.stringify(remote.project())).toContain("人の追記");
    await expect(page.locator(".document-tab-save-dot").first()).toHaveClass(/\bsaved\b/, { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("shared-sync-recovered.png") });
  } finally {
    await client.close().catch(() => {});
    await app?.close().catch(() => {});
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    remote.destroy();
    // The app's background agents can still be writing into the profile right after it closes.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
