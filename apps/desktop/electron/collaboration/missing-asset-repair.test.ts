import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import { fromBase64, toBase64, MAX_DOCUMENT_BYTES } from "../../src/features/collaboration/model/protocol";
import type { CollaborationEvent } from "../../src/features/collaboration/model/bridge";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { SharedDocumentJournal } from "./journal";
import { CollaborationSessions } from "./sessions";

vi.mock("electron", () => ({ safeStorage: {} }));

// #251: a shared document's edits refused with MISSING_ASSET were kept forever and resent forever.
// These cases run the real sessions against a server that validates like the deployed one: every
// operation is applied to the server's document and each `src` must be a registered image.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const actor = "55555555-5555-4555-8555-555555555555";
const directories: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

class AssetRefusal extends Error {
  constructor(readonly missing: string[], readonly invalid: string[]) { super(invalid.length ? "INVALID_ASSET_REFERENCE" : "MISSING_ASSET"); }
}
/** The deployed server's rules, for one document. `namesMissing: false` is the server before #251. */
class FixtureServer {
  remote = new SharedDocument();
  readonly assets = new Map<string, { type: string; bytes: Buffer }>();
  readonly receipts = new Map<string, { hash: string; seq: number }>();
  readonly requests: string[] = [];
  readonly refusedTypes = new Set<string>();
  /** Other documents' images this server also serves (one deployment serves every document). */
  readonly others = new Map<string, FixtureServer>();
  seq = 0;
  dropNextUpdates = false;
  constructor(readonly sharedId: string, readonly namesMissing: boolean) {}
  validate(document: ObjectValue): void {
    const missing = new Set<string>(), invalid = new Set<string>();
    const visit = (value: unknown, owner: string): void => {
      if (Array.isArray(value)) return value.forEach((child) => visit(child, owner));
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : owner;
      if (typeof item.src === "string") {
        const match = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})$/.exec(item.src);
        if (!match) invalid.add(id);
        else if (!this.assets.has(match[1])) missing.add(match[1]);
      }
      Object.values(item).forEach((child) => visit(child, id));
    };
    visit(document, "");
    if (missing.size || invalid.size) throw new AssetRefusal([...missing], [...invalid]);
  }
  refusal(error: AssetRefusal, operationId?: string) {
    return this.namesMissing
      ? { error: error.message, missingAssetIds: error.missing, invalidAssetReferences: error.invalid, ...(operationId ? { operationId } : {}) }
      : { error: "MISSING_ASSET" };
  }
  updateCount(): number {
    return this.requests.filter((request) => request.endsWith("/updates")).length;
  }
  async listen(): Promise<string> {
    const server: Server = createServer(async (request, response) => {
      const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      const prefix = `/documents/${this.sharedId}`;
      this.requests.push(`${request.method} ${request.url}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const other = [...this.others.values()].find((server) => request.url?.startsWith(`/documents/${server.sharedId}/assets/`));
      if (other) {
        const asset = other.assets.get(request.url!.split("/").at(-1)!);
        if (request.method !== "GET" || !asset) return json({ error: "MISSING_ASSET" }, 404);
        return response.writeHead(200, { "Content-Type": asset.type }).end(asset.bytes);
      }
      if (!request.url?.startsWith(prefix)) return json({ error: "NOT_FOUND" }, 404);
      const action = request.url.slice(prefix.length + 1);
      if (action.startsWith("assets/")) {
        const id = action.slice(7);
        if (request.method === "PUT") {
          const type = String(request.headers["content-type"]);
          if (this.refusedTypes.has(type)) return json({ error: "ASSET_TYPE" }, 415);
          this.assets.set(id, { type, bytes });
          return json({ assetId: id });
        }
        const asset = this.assets.get(id);
        if (!asset) return json({ error: "MISSING_ASSET" }, 404);
        return response.writeHead(200, { "Content-Type": asset.type }).end(asset.bytes);
      }
      const body = bytes.length ? JSON.parse(bytes.toString()) as Record<string, unknown> : {};
      if (action === "sync")
        return json({ update: toBase64(this.remote.difference(fromBase64(String(body.vector)))), role: "editor", epoch: 1, protocol: 1 });
      if (action === "initialize") {
        const candidate = new SharedDocument(fromBase64(String(body.state), MAX_DOCUMENT_BYTES));
        try { this.validate(candidate.project()); }
        catch (error) { candidate.destroy(); if (error instanceof AssetRefusal) return json(this.refusal(error), 400); throw error; }
        this.remote.destroy();
        this.remote = candidate;
        return json({ seq: 0 });
      }
      if (action === "updates") {
        const acks: { operationId: string; seq: number }[] = [];
        for (const operation of body.operations as { operationId: string; update: string }[]) {
          const update = fromBase64(operation.update);
          const hash = createHash("sha256").update(update).digest("hex");
          const receipt = this.receipts.get(operation.operationId);
          if (receipt) {
            if (receipt.hash !== hash) return json({ error: "OPERATION_REUSED" }, 400);
            acks.push({ operationId: operation.operationId, seq: receipt.seq });
            continue;
          }
          try { this.remote.prepareUpdate(update, (document) => this.validate(document)).destroy(); }
          catch (error) { if (error instanceof AssetRefusal) return json(this.refusal(error, operation.operationId), 400); throw error; }
          this.remote.applyUpdate(update);
          this.receipts.set(operation.operationId, { hash, seq: ++this.seq });
          acks.push({ operationId: operation.operationId, seq: this.seq });
        }
        if (this.dropNextUpdates) { this.dropNextUpdates = false; response.destroy(); return; }
        return json({ acks });
      }
      json({ error: "NOT_FOUND" }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    cleanups.push(() => this.remote.destroy());
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("FIXTURE_PORT_REQUIRED");
    return `http://127.0.0.1:${address.port}`;
  }
}

function overlay(document: ObjectValue): ObjectValue {
  const layout = document.pageLayout as ObjectValue;
  return ((layout.overlay ??= { overlaySnapshot: { version: 1, shapes: [], assets: {} } }) as ObjectValue).overlaySnapshot as ObjectValue;
}
function withImage(document: ObjectValue, key: string, src: string): void {
  (overlay(document).shapes as ObjectValue[]).push({ id: `shape_${key}`, type: "image", x: 10, y: 20, props: { assetId: key, w: 64, h: 48 } });
  (overlay(document).assets as ObjectValue)[key] = { id: key, type: "image",
    props: { w: 64, h: 48, name: `${key}.png`, isAnimated: false, mimeType: "image/png", src, fileSize: 70 } };
}
function withoutImage(document: ObjectValue, key: string): void {
  overlay(document).shapes = (overlay(document).shapes as ObjectValue[]).filter((shape) => shape.id !== `shape_${key}`);
  delete (overlay(document).assets as ObjectValue)[key];
}
function withText(document: ObjectValue, text: string): void {
  (document.content as ObjectValue[]).splice(0, 1, { type: "paragraph", id: "p_body", children: [{ type: "text", text }] });
}
/** An editor replica: each edit returns its update, as the renderer sends it to main. */
function replica(state: Uint8Array) {
  const document = new SharedDocument(state);
  cleanups.push(() => document.destroy());
  return (change: (value: ObjectValue) => void): Uint8Array => {
    const before = document.project(), after = structuredClone(before), vector = document.vector();
    change(after);
    document.change(before, after);
    return document.difference(vector);
  };
}

interface Seed {
  server: FixtureServer;
  fileId: string;
  /** Unsent edits saved on this device before the app (re)started. */
  pending?: Uint8Array[];
  /** Images cached on this device for this document. */
  cached?: Record<string, { source: string; uploaded: boolean }>;
  initialized?: boolean;
}
async function start(seeds: Seed[], directory?: string) {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  if (!directory) {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-missing-asset-"));
    directories.push(directory);
    const root = path.join(directory, "collaboration-v1");
    const files: Record<string, unknown> = {};
    for (const seed of seeds) {
      const shared = new SharedDocument(seed.server.remote.snapshot());
      const journalDirectory = path.join(root, "documents", seed.server.sharedId);
      const journal = await SharedDocumentJournal.create(journalDirectory, {
        sharedDocumentId: seed.server.sharedId, epoch: 1, protocol: 1, localFileId: seed.fileId, docId: (shared.project().docId as string),
      }, shared);
      if (seed.initialized === false) await fs.writeFile(path.join(journalDirectory, "initial-state.txt"), toBase64(shared.snapshot()));
      for (const update of seed.pending ?? [])
        await journal.append(update, { operationId: randomUUID(), actorId: actor, kind: "manual" }, true);
      shared.destroy();
      for (const [assetId, cached] of Object.entries(seed.cached ?? {})) {
        await fs.mkdir(path.join(root, "assets", seed.server.sharedId), { recursive: true });
        await fs.writeFile(path.join(root, "assets", seed.server.sharedId, `${assetId}.json`), JSON.stringify(cached));
      }
      files[seed.fileId] = { sharedDocumentId: seed.server.sharedId, actorId: actor, role: "editor", operationId: randomUUID(), initialized: seed.initialized ?? true };
    }
    await fs.writeFile(path.join(root, "registry.json"), JSON.stringify({ version: 1, files }));
  }
  const apiUrl = await seeds[0].server.listen();
  const events: CollaborationEvent[] = [];
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), (event) => events.push(event));
  Object.defineProperty(sessions, "auth", { value: {
    initialize: async () => {}, user: () => ({ id: actor }), cancelSignIn: () => {},
    accountSignal: () => new AbortController().signal, authorization: async () => "Bearer fixture", config: { apiUrl },
  } });
  await sessions.initialize();
  sessions.restrictCatalog(new Map(seeds.map((seed) => [seed.server.sharedId, "editor" as const])));
  cleanups.push(() => sessions.close());
  const internal = sessions as unknown as { sessions: Map<string, { journal: SharedDocumentJournal; status: string }> };
  const ledger = async () => (await fs.readFile(path.join(directory!, "data", "logs", "ledger.log"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { sessions, directory, events, internal, ledger };
}
function serverWith(namesMissing: boolean, change?: (document: ObjectValue) => void): FixtureServer {
  const server = new FixtureServer(randomUUID(), namesMissing);
  const document = JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue;
  withText(document, "共有教材の本文");
  // Replicas that each create the overlay at once keep only one of them (a map key set concurrently).
  overlay(document);
  change?.(document);
  server.remote.initialize(document, { sharedDocumentId: server.sharedId, epoch: 1 });
  return server;
}

describe.each([
  ["a server that names the missing images", true],
  ["a server from before #251 that only says MISSING_ASSET", false],
])("with %s", (_, namesMissing) => {
  it("re-sends an image this device marked as uploaded but the server lacks, and sends every edit once", async () => {
    const server = serverWith(namesMissing);
    const edit = replica(server.remote.snapshot());
    const pending = [
      edit((document) => withText(document, "オフラインで書いた本文")),
      edit((document) => withImage(document, "asset_a", "sigma-doc-storage://image-a")),
    ];
    // Another device edits the same document meanwhile.
    const other = replica(server.remote.snapshot());
    server.remote.applyUpdate(other((document) => withImage(document, "asset_other", "sigma-doc-storage://image-other")));
    server.assets.set("image-other", { type: "image/png", bytes: Buffer.from(PNG.split(",")[1], "base64") });
    const { sessions, internal, ledger } = await start([{ server, fileId: "file", pending, cached: { "image-a": { source: PNG, uploaded: true } } }]);
    server.dropNextUpdates = true;
    await expect(sessions.flush("file", true)).rejects.toThrow();
    await sessions.flush("file", true);
    expect(server.assets.has("image-a")).toBe(true);
    expect(internal.sessions.get("file")!.journal.outbox()).toEqual([]);
    expect(internal.sessions.get("file")!.status).toBe("saved");
    // The text edit was committed before the refusal, and the batch once more after the lost answer:
    // each operation still has exactly one receipt.
    expect(server.seq).toBe(2);
    const remote = JSON.stringify(server.remote.project());
    expect(remote).toContain("オフラインで書いた本文");
    expect(remote).toContain("sigma-doc-storage://image-a");
    expect(remote).toContain("sigma-doc-storage://image-other");
    expect(JSON.stringify(sessions.project("file"))).toContain("sigma-doc-storage://image-other");
    expect((await ledger()).filter((entry) => entry.event === "shared-asset-repair")).toEqual([
      expect.objectContaining({ fileId: "file", resent: 1, unresolved: 0 }),
    ]);
  });

  it("keeps edits that need an image nobody has, stops resending them, and lets a placeholder through", async () => {
    const server = serverWith(namesMissing);
    const edit = replica(server.remote.snapshot());
    const pending = [
      edit((document) => withImage(document, "asset_lost", "sigma-doc-storage://image-lost")),
      edit((document) => withText(document, "画像の後に書いた本文")),
    ];
    const { sessions, internal, events, directory } = await start([{ server, fileId: "file", pending }]);
    await expect(sessions.flush("file", true)).rejects.toThrow(/MISSING_ASSET/);
    const session = internal.sessions.get("file")!;
    expect(session.status).toBe("needs-recovery");
    expect(session.journal.outbox()).toHaveLength(2);
    const status = events.filter((event) => event.type === "status").at(-1);
    expect(status).toMatchObject({ status: "needs-recovery", detail: {
      pendingOperations: 2, pendingAssets: 0,
      recovery: { images: [{ assetId: "image-lost", name: "asset_lost.png", reason: "missing" }] },
    } });
    // Background retries pull remote changes but do not send the refused edits again.
    const refusedRequests = server.updateCount();
    await expect(sessions.flush("file", true)).rejects.toThrow("ASSET_RECOVERY_REQUIRED");
    await expect(sessions.flush("file", true)).rejects.toThrow("ASSET_RECOVERY_REQUIRED");
    expect(server.updateCount()).toBe(refusedRequests);
    expect(JSON.stringify(sessions.project("file"))).toContain("画像の後に書いた本文");

    await sessions.replaceMissingImages("file");
    expect(session.journal.outbox()).toEqual([]);
    expect(session.status).toBe("saved");
    const remote = server.remote.project() as unknown as { pageLayout: { overlay: { overlaySnapshot: { assets: Record<string, { props: { src: string; name: string; mimeType: string } }> } } } };
    const asset = remote.pageLayout.overlay.overlaySnapshot.assets.asset_lost;
    expect(asset.props).toMatchObject({ name: "asset_lost.png", mimeType: "image/svg+xml" });
    expect(asset.props.src).toMatch(/^sigma-doc-storage:\/\/[0-9a-f]{64}$/);
    expect(server.assets.has(asset.props.src.slice(20))).toBe(true);
    expect(JSON.stringify(remote)).toContain("画像の後に書いた本文");
    expect(events.filter((event) => event.type === "status").at(-1)).toMatchObject({ status: "saved", detail: { pendingOperations: 0 } });
    // The edits are on the server and on this device after a restart.
    await sessions.close();
    const restarted = await start([{ server, fileId: "file" }], directory);
    expect(JSON.stringify(await restarted.sessions.read("file"))).toContain("画像の後に書いた本文");
  });

  it("sends edits as one when only an edit that a later one undid wrote an image nobody has", async () => {
    const server = serverWith(namesMissing);
    const edit = replica(server.remote.snapshot());
    const pending = [
      edit((document) => withImage(document, "asset_gone", "sigma-doc-storage://image-gone")),
      edit((document) => withText(document, "残す本文")),
      edit((document) => withoutImage(document, "asset_gone")),
    ];
    const { sessions, internal, ledger } = await start([{ server, fileId: "file", pending }]);
    await sessions.flush("file", true);
    expect(internal.sessions.get("file")!.journal.outbox()).toEqual([]);
    const remote = JSON.stringify(server.remote.project());
    expect(remote).toContain("残す本文");
    expect(remote).not.toContain("image-gone");
    expect(server.seq).toBe(1);
    expect((await ledger()).filter((entry) => entry.event === "shared-asset-repair").at(-1)).toMatchObject({ merged: 3 });
  });

  it("names a src that is no image of this document and replaces it on request", async () => {
    const server = serverWith(namesMissing);
    const edit = replica(server.remote.snapshot());
    const pending = [edit((document) => withImage(document, "asset_legacy", "sigma-doc-storage://workspaces/a/remote.png"))];
    const { sessions, internal } = await start([{ server, fileId: "file", pending }]);
    await expect(sessions.flush("file", true)).rejects.toThrow();
    expect(sessions.describe("file").detail?.recovery?.images).toEqual([
      { assetId: "asset_legacy", name: "asset_legacy.png", reason: "invalid-reference" },
    ]);
    await sessions.replaceMissingImages("file");
    expect(internal.sessions.get("file")!.journal.outbox()).toEqual([]);
    expect(JSON.stringify(server.remote.project())).not.toContain("workspaces/a/remote.png");
  });
});

it("brings along an image pasted from another shared document of the account before sending the edit", async () => {
  const target = serverWith(true);
  const source = new FixtureServer(randomUUID(), true);
  source.remote.initialize(JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue, { sharedDocumentId: source.sharedId, epoch: 1 });
  cleanups.push(() => source.remote.destroy());
  const { sessions, internal, ledger } = await start([
    { server: target, fileId: "target" },
    { server: source, fileId: "source", cached: { "image-pasted": { source: PNG, uploaded: true } } },
  ]);
  await sessions.read("target");
  const edit = replica(internal.sessions.get("target")!.journal.document.snapshot());
  await sessions.update("target", toBase64(edit((document) => withImage(document, "asset_pasted", "sigma-doc-storage://image-pasted"))), randomUUID(), "manual", 1);
  await sessions.flush("target", true);
  expect(target.assets.has("image-pasted")).toBe(true);
  expect(JSON.stringify(target.remote.project())).toContain("sigma-doc-storage://image-pasted");
  expect(internal.sessions.get("target")!.journal.outbox()).toEqual([]);
  // Sent as a new image of this document: no refusal and no repair.
  expect((await ledger()).filter((entry) => entry.event === "shared-asset-repair" || entry.event === "shared-document-sync-failed")).toEqual([]);
});

it("repairs an initialization and edits that refer to images of another shared document", async () => {
  const target = new FixtureServer(randomUUID(), false);
  const source = new FixtureServer(randomUUID(), false);
  source.remote.initialize(JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue, { sharedDocumentId: source.sharedId, epoch: 1 });
  cleanups.push(() => source.remote.destroy());
  // A local document shared with a pasted reference in it: its initial state refers to the image.
  const local = JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue;
  withImage(local, "asset_initial", "sigma-doc-storage://image-initial");
  target.remote.initialize(local, { sharedDocumentId: target.sharedId, epoch: 1 });
  const edit = replica(target.remote.snapshot());
  const pending = [edit((document) => withImage(document, "asset_later", "sigma-doc-storage://image-later"))];
  const { sessions, internal } = await start([
    { server: target, fileId: "target", pending, initialized: false },
    { server: source, fileId: "source", cached: { "image-initial": { source: PNG, uploaded: true }, "image-later": { source: PNG, uploaded: true } } },
  ]);
  // The server has not received the document yet.
  target.remote.destroy();
  target.remote = new SharedDocument();
  await sessions.flush("target", true);
  expect([...target.assets.keys()].sort()).toEqual(["image-initial", "image-later"]);
  expect(internal.sessions.get("target")!.journal.outbox()).toEqual([]);
  const remote = JSON.stringify(target.remote.project());
  expect(remote).toContain("image-initial");
  expect(remote).toContain("image-later");
});

it("finishes a document copied before #250 by downloading the images from the document it was copied from", async () => {
  // The copy's creation was left half done: its initial state still refers to the source's image,
  // which this device never downloaded.
  const source = new FixtureServer(randomUUID(), false);
  const copied = JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue;
  withImage(copied, "asset_source", "sigma-doc-storage://image-source");
  source.remote.initialize(copied, { sharedDocumentId: source.sharedId, epoch: 1 });
  source.assets.set("image-source", { type: "image/png", bytes: Buffer.from(PNG.split(",")[1], "base64") });
  cleanups.push(() => source.remote.destroy());
  const target = new FixtureServer(randomUUID(), false);
  target.remote.initialize({ ...copied, docId: "doc_copy" }, { sharedDocumentId: target.sharedId, epoch: 1 });
  target.others.set(source.sharedId, source);
  const { sessions, internal, ledger } = await start([
    { server: target, fileId: "copy", initialized: false },
    { server: source, fileId: "source" },
  ]);
  target.remote.destroy();
  target.remote = new SharedDocument();
  await sessions.flush("copy", true);
  expect(target.assets.has("image-source")).toBe(true);
  expect(JSON.stringify(target.remote.project())).toContain("sigma-doc-storage://image-source");
  expect(internal.sessions.get("copy")!.status).toBe("saved");
  expect((await ledger()).filter((entry) => entry.event === "shared-asset-repair")).toEqual([
    expect.objectContaining({ fileId: "copy", adopted: 1, unresolved: 0 }),
  ]);
});

it("does not let an image the server will not store hold back edits that no longer use it", async () => {
  const server = serverWith(true);
  server.refusedTypes.add("image/svg+xml");
  const edit = replica(server.remote.snapshot());
  const pending = [edit((document) => withText(document, "画像とは別の本文"))];
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`;
  const { sessions, internal } = await start([{ server, fileId: "file", pending, cached: { "image-svg": { source: svg, uploaded: false } } }]);
  await sessions.flush("file", true);
  expect(internal.sessions.get("file")!.journal.outbox()).toEqual([]);
  expect(JSON.stringify(server.remote.project())).toContain("画像とは別の本文");
  expect(sessions.describe("file").detail).toEqual({ pendingOperations: 0, pendingAssets: 0 });
});
