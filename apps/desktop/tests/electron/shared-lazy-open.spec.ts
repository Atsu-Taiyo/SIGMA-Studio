import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { SharedDocumentJournal } from "../../electron/collaboration/journal";

// 起動時は、送信待ちの無い共有教材の journal を開かない (初めて使うときに開く)。送信待ちのある
// 教材だけは起動時に開き、再送の間隔で一度だけ送る。HTTP はループバックの固定応答だが、
// Electron main・preload・暗号化した認証・journal・再送の間隔は本物を使う。
test("sends a shared outbox left from the last run once, and opens clean shared files only when used", async () => {
  test.setTimeout(180_000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-lazy-electron-"));
  const actorId = "22222222-2222-4222-8222-222222222222";
  const directory = path.join(profile, "collaboration-v1");
  const remotes = new Map<string, SharedDocument>();
  const files: Record<string, unknown> = {};
  const fixture = async (name: string, sharedId: string, pendingTitle?: string) => {
    const document = createBlankDocument(`${name} title`);
    const remote = new SharedDocument();
    remote.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: sharedId, epoch: 1 });
    remotes.set(sharedId, remote);
    const journal = await SharedDocumentJournal.create(path.join(directory, "documents", sharedId), {
      sharedDocumentId: sharedId, epoch: 1, protocol: 1, localFileId: name, docId: document.docId,
    }, new SharedDocument(remote.snapshot()));
    let operationId: string | undefined;
    if (pendingTitle) {
      const editor = new SharedDocument(journal.document.snapshot());
      const before = editor.project();
      editor.change(before, { ...before, metadata: { ...(before.metadata as ObjectValue), title: pendingTitle } });
      operationId = crypto.randomUUID();
      await journal.append(editor.difference(journal.document.vector()), { operationId, actorId, kind: "manual" }, true);
      editor.destroy();
    }
    await journal.compact();
    journal.document.destroy();
    files[name] = { sharedDocumentId: sharedId, actorId, role: "editor", operationId: crypto.randomUUID(), initialized: true };
    return operationId;
  };
  const cleanId = "11111111-1111-4111-8111-111111111111";
  const editedId = "33333333-3333-4333-8333-333333333333";
  await fixture("clean_fixture", cleanId);
  const pendingOperation = await fixture("edited_fixture", editedId, "Edited before quitting");
  await writeFile(path.join(directory, "registry.json"), JSON.stringify({ version: 1, files }));

  const requests: string[] = [];
  const sent: string[] = [];
  const server = createServer(async (request, response) => {
    const match = /^\/documents\/([0-9a-f-]{36})\/(sync|updates)$/.exec(request.url ?? "");
    const remote = match ? remotes.get(match[1]) : undefined;
    if (!match || !remote) {
      // The catalog/account UI is offline; it cannot change the fixture's grants.
      response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"FIXTURE_OFFLINE"}');
      return;
    }
    requests.push(`${match[1]}/${match[2]}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { vector?: string; operations?: { operationId: string; update: string }[] };
    if (match[2] === "sync") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        update: toBase64(remote.difference(fromBase64(body.vector!))), role: "editor", epoch: 1, protocol: 1,
      }));
      return;
    }
    const acks = body.operations!.map((operation, index) => {
      remote.applyUpdate(fromBase64(operation.update));
      sent.push(operation.operationId);
      return { operationId: operation.operationId, seq: index + 1 };
    });
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ acks }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!/^\/documents\/[0-9a-f-]{36}\/socket$/.test(request.url ?? "")) { socket.destroy(); return; }
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
    // Linux CI grants the Electron executable itself user namespaces; launch it directly so
    // Playwright does not add --no-sandbox, and safeStorage uses the real Secret Service.
    const nativeKeyring = process.platform === "linux"
      ? { executablePath: createRequire(path.join(root, "package.json"))("electron") as string }
      : {};
    app = await electron.launch({ ...nativeKeyring, args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.collaboration));
    return page;
  };
  const sessionIds = async (page: Awaited<ReturnType<typeof launch>>) =>
    (await page.evaluate(() => window.desktopAPI!.collaboration!.info())).sessions.map((session) => session.binding.localFileId).sort();
  try {
    // First run only stores encrypted credentials for the fixture account.
    await launch();
    const encrypted = await app!.evaluate(({ safeStorage }, tokens) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_REQUIRED");
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, { access_token: "fixture", refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, user: { id: actorId } });
    await writeFile(path.join(directory, "auth.enc"), encrypted, { mode: 0o600 });
    await app!.close(); app = undefined;
    requests.length = 0;
    sent.length = 0;

    let page = await launch();
    // The edit left unsent by the last run goes out on the first retry, exactly once.
    await expect.poll(() => sent, { timeout: 20_000 }).toEqual([pendingOperation]);
    expect((remotes.get(editedId)!.project().metadata as ObjectValue).title).toBe("Edited before quitting");
    expect(await sessionIds(page)).toEqual(["edited_fixture"]);
    const info = await page.evaluate(() => window.desktopAPI!.collaboration!.info());
    expect(info.restrictedFileIds.sort()).toEqual(["clean_fixture", "edited_fixture"]);
    // The clean file stays closed and quiet until it is used.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(requests.filter((route) => route.startsWith(cleanId))).toEqual([]);
    expect(sent).toEqual([pendingOperation]);

    await page.evaluate((id) => window.desktopAPI!.collaboration!.view(id), "clean_fixture");
    expect(requests.filter((route) => route.startsWith(cleanId))).toEqual([`${cleanId}/sync`]);
    expect(await sessionIds(page)).toEqual(["clean_fixture", "edited_fixture"]);
    await page.evaluate(() => window.desktopAPI!.collaboration!.view(null));
    await app!.close(); app = undefined;

    // Acknowledged work is not sent again after another restart.
    page = await launch();
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(sent).toEqual([pendingOperation]);
    expect(await sessionIds(page)).toEqual([]);
  } finally {
    await app?.close();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const remote of remotes.values()) remote.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
