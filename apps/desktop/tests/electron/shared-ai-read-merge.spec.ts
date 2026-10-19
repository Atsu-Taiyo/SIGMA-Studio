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
import { findBlock, updateBlockInDocument } from "@/lib/document-tree";
import { getDefaultPageLayout, type InlineNode, type OverlayAsset, type OverlayShape, type SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { assertReadPreconditions, type ReadPrecondition } from "@/features/collaboration/model/approval";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";
import { CatalogCache } from "../../electron/collaboration/catalog-cache";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect x="10" y="10" width="180" height="100" fill="none" stroke="#111111"/><text x="100" y="66" text-anchor="middle">表</text></svg>';
type FigureDraft = { operations: { operation?: string; overlayShape: OverlayShape; assets?: Record<string, OverlayAsset> }[]; mutationOperations?: unknown[] };

const textOf = (document: SigmaDocument, id: string) => ((findBlock(document, id) as { children?: InlineNode[] } | null)?.children ?? [])
  .map((node) => (node.type === "text" ? node.text : "")).join("");

/**
 * Issue #249 (MISS R24) on a shared document, in the real app with a fixture sync server. The AI reads a
 * paragraph as reference ("関数g(a)の増減表を作って" reads the problem) and inserts a figure elsewhere;
 * another participant then edits the paragraph it only read. The approval used to send the read
 * paragraph's hash as a precondition, so the server refused it as PROPOSAL_CONFLICT and the app called it
 * "AI提案が上書きする対象が承認前に変更されている" — on every retry. Now the approval goes through, and
 * the participant's edit and the AI's figure are both in the shared document.
 */
test("a shared approval goes through after another participant edited what the AI only read", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-shared-ai-read-merge-"));
  const sharedId = "88888888-8888-4888-8888-888888888888";
  const actorId = "55555555-5555-4555-8555-555555555555";
  const directory = path.join(profile, "collaboration-v1");
  const remote = new SharedDocument();
  const uploaded = new Map<string, { type: string; bytes: Buffer }>();
  const approvals: { preconditions: ReadPrecondition[]; status: number }[] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const prefix = `/documents/${sharedId}`;
    const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!request.url?.startsWith(prefix)) { json({ error: "FIXTURE_OFFLINE" }, 503); return; }
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
      json({ acks: body.operations.map((operation: { operationId: string; update: string }) => {
        remote.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: ++sequence };
      }) });
    } else if (request.url === `${prefix}/approve` && Array.isArray(body.drafts ?? (body.draft ? [body.draft] : null))) {
      const before = remote.project();
      // The server checks every precondition against the document it holds, as the real one does.
      try {
        await assertReadPreconditions(before, body.preconditions);
      } catch {
        approvals.push({ preconditions: body.preconditions, status: 409 });
        json({ error: "PROPOSAL_CONFLICT" }, 409);
        return;
      }
      approvals.push({ preconditions: body.preconditions, status: 200 });
      const next = structuredClone(before) as unknown as SigmaDocument;
      const snapshot = (next.pageLayout!.overlay ??= {}).overlaySnapshot ??= { version: 1, shapes: [], assets: {} };
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
      json({ update: toBase64(update), operationId: body.operationId, seq: ++sequence });
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
  const client = new Client({ name: "shared-ai-read-merge", version: "1" });
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
      ...createBlankDocument("共有教材のAI編集"),
      content: [
        { type: "paragraph", id: "p_problem", children: [{ type: "text", text: "関数g(a)の増減を調べよ。" }] },
        { type: "paragraph", id: "p_body", children: [{ type: "text", text: "増減表をここに置く。" }] },
      ],
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
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user: { id: actorId } });
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
    const nodeId = "99999999-9999-4999-8999-999999999999";
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
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_body"]').first()).toBeVisible();
    await expect(page.getByRole("status", { name: "クラウド保存済み" })).toBeVisible({ timeout: 30_000 });

    // The AI reads the problem it was asked about, then inserts the figure after the other paragraph.
    await client.connect(new StdioClientTransport({
      command: await app!.evaluate(() => process.execPath),
      args: [path.join(root, "dist-electron/sigma-doc-mcp-server.cjs")],
      env: { PATH: process.env.PATH ?? "", HOME: homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile },
      stderr: "pipe",
    }));
    const runId = "run_shared_read_merge";
    const read = await client.callTool({ name: "get_block", arguments: { fileId: seeded.fileId, blockId: "p_problem", runId } });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    const inserted = await client.callTool({
      name: "insert_svg_image",
      arguments: { fileId: seeded.fileId, expectedRevision: 1, targetId: "p_body", svg: SVG, name: "増減表", w: 240, runId },
    });
    expect(inserted.isError, JSON.stringify(inserted)).not.toBe(true);
    const pending = () => page.evaluate((id) => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" })
      .then((items) => items.filter((item) => item.fileId === id)), seeded.fileId);
    await expect.poll(async () => (await pending()).length).toBe(1);

    // Another participant edits the problem the AI only read; it reaches the server.
    const before = remote.project();
    const edited = updateBlockInDocument(structuredClone(before) as unknown as SigmaDocument, "p_problem",
      (block) => ({ ...block, children: [{ type: "text", text: "関数g(a)の増減を調べ、最小値を求めよ。" }] } as never));
    remote.change(before, JSON.parse(JSON.stringify(edited)) as ObjectValue);

    const apply = page.getByRole("button", { name: "適用", exact: true }).first();
    await expect(apply).toBeVisible({ timeout: 30_000 });
    await apply.click();
    await expect.poll(async () => (await pending()).length, { timeout: 30_000 }).toBe(0);
    await expect(page.getByText("AI提案が上書きする対象が承認前に変更されているため、承認できませんでした。")).toHaveCount(0);
    expect(approvals.map((approval) => approval.status)).toEqual([200]);
    expect(approvals[0]!.preconditions.map((condition) => condition.id)).not.toContain("p_problem");
    const shared = remote.project() as unknown as SigmaDocument;
    expect(textOf(shared, "p_problem")).toBe("関数g(a)の増減を調べ、最小値を求めよ。");
    expect(shared.pageLayout?.overlay?.overlaySnapshot?.shapes.filter((shape) => shape.type === "image")).toHaveLength(1);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_problem"]').first()).toHaveText("関数g(a)の増減を調べ、最小値を求めよ。");
    await expect(page.locator("img.overlay-image-shape").first()).toBeVisible();
    const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), seeded.fileId);
    expect(textOf(saved!, "p_problem")).toBe("関数g(a)の増減を調べ、最小値を求めよ。");
    await page.screenshot({ path: testInfo.outputPath("shared-read-merge-approved.png") });
  } finally {
    await client.close().catch(() => {});
    await app?.close().catch(() => {});
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    remote.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});
