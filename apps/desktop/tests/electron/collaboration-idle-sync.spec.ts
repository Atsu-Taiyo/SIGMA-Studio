import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";

// The backend is a loopback protocol fixture. Electron main, preload, HTTP,
// WebSocket, the retry interval, encrypted auth storage, and journals are real.
test("closed shared journals stay idle across restart and catch up through the Electron bridge", async () => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-idle-electron-"));
  const sharedId = "11111111-1111-4111-8111-111111111111";
  const actorId = "22222222-2222-4222-8222-222222222222";
  const fileId = "idle_fixture";
  const document = createBlankDocument("Before reopening");
  const remote = new SharedDocument();
  remote.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
  const directory = path.join(profile, "collaboration-v1");
  await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
    sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: fileId, docId: document.docId,
  }, remote);
  await writeFile(path.join(directory, "registry.json"), JSON.stringify({ version: 1, files: {
    [fileId]: { sharedDocumentId: sharedId, actorId, role: "editor", operationId: crypto.randomUUID(), initialized: true },
  } }));
  let syncs = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== `/documents/${sharedId}/sync`) {
      // Unrelated catalog/account UI is offline; it cannot modify fixture grants.
      response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"FIXTURE_OFFLINE"}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { vector: string };
    syncs++;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      update: toBase64(remote.difference(fromBase64(body.vector))), role: "editor", epoch: 1, protocol: 1,
    }));
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
    SIGMA_COLLABORATION_URL: endpoint, SIGMA_SUPABASE_URL: endpoint,
    SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await electron.launch({ args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  const idlePastReconciliation = async () => {
    await app!.evaluate(() => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + 120_000;
    });
    // Keep the actual main-process retry interval; only advance the due date.
    await new Promise((resolve) => setTimeout(resolve, 6500));
  };
  try {
    await launch();
    const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, user: { id: actorId } });
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    await app!.close(); app = undefined;

    let page = await launch();
    expect((await page.evaluate(() => window.desktopAPI!.collaboration!.info())).user?.actorId).toBe(actorId);
    await idlePastReconciliation();
    expect(syncs).toBe(0);
    await page.evaluate((id) => window.desktopAPI!.collaboration!.view(id), fileId);
    expect(syncs).toBe(1);
    await page.evaluate(() => window.desktopAPI!.collaboration!.view(null));
    await expect.poll(() => sockets.clients.size).toBe(0);

    const before = remote.project();
    const after = structuredClone(before);
    (after.metadata as ObjectValue).title = "Changed while closed";
    remote.change(before, after);
    await idlePastReconciliation();
    expect(syncs).toBe(1);
    await page.evaluate((id) => window.desktopAPI!.collaboration!.view(id), fileId);
    expect(syncs).toBe(2);
    await page.evaluate(() => window.desktopAPI!.collaboration!.view(null));
    await app!.close(); app = undefined;

    page = await launch();
    const info = await page.evaluate(() => window.desktopAPI!.collaboration!.info());
    const state = info.sessions.find((session) => session.binding.localFileId === fileId)!.state;
    const restored = new SharedDocument(fromBase64(state));
    expect((restored.project().metadata as ObjectValue).title).toBe("Changed while closed");
    restored.destroy();
    await idlePastReconciliation();
    expect(syncs).toBe(2);
  } finally {
    await app?.close();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    remote.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
