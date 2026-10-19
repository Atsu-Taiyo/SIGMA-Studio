import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";
import type { CatalogNode, CatalogNodeId, SharedCapabilities, SharedDocumentId } from "@/features/collaboration/model/catalog";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { DesktopSharedCatalog } from "./catalog";
import { CatalogCache } from "./catalog-cache";
import { catalogSessionsPort } from "./catalog-port";
import { CollaborationSessions } from "./sessions";
import { CollaborationHttpError } from "./transport";

vi.mock("electron", () => ({ safeStorage: {}, shell: {} }));

// Issue #250: duplicating a cloud (shared) material failed with "Error invoking remote method
// 'storage:duplicate-file': Error: ..." — TARGET_UNAVAILABLE for a material shared with me on its
// own, FORBIDDEN for a viewer, and MISSING_ASSET from the server for a material with images in an
// editable shared folder (the copy pointed at images that only the original's shared document had).
// These run the real main-process session + catalog against a sync server that validates like the
// real one (an initial state may only refer to images uploaded to that same document).

const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const ACTOR = "participant";
const IMAGE_BYTES = Buffer.from("iVBORw0KGgo=", "base64");
const IMAGE_SOURCE = `data:image/png;base64,${IMAGE_BYTES.toString("base64")}`;
const capabilities = (overrides: Partial<SharedCapabilities> = {}): SharedCapabilities => ({
  read: true, editDocument: true, createChildren: true, rename: true, move: true, deleteDescendants: true,
  invite: false, manageEditorViewer: false, appointAdmin: false, stopRootShare: false, deleteRootShare: false,
  restoreDocument: false, startHierarchyShare: false, ...overrides,
});

function imageDocument(title: string, src: string, body = "本文"): SigmaDocument {
  const document = createBlankDocument(title);
  document.content = [{ type: "paragraph", id: "p", children: [{ type: "text", text: body }] }] as SigmaDocument["content"];
  document.pageLayout!.overlay = {
    overlaySnapshot: {
      version: 1,
      shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "asset_local", w: 64, h: 48 } }],
      assets: {
        asset_local: {
          id: "asset_local",
          type: "image",
          props: { w: 64, h: 48, name: "figure.png", isAnimated: false, mimeType: "image/png", src, fileSize: IMAGE_BYTES.byteLength },
        },
      },
    },
  } as never;
  return document;
}

function imageSources(document: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "src" && typeof child === "string") found.push(child);
      else visit(child);
    }
  };
  visit(document);
  return found;
}

const paragraphText = (document: SigmaDocument) =>
  ((document.content[0] as { children: { text?: string }[] }).children ?? []).map((child) => child.text ?? "").join("");

/** The parts of the sync server and catalog these flows reach, validating as the real ones do. */
class FakeServer {
  revision = 1;
  nodes = new Map<string, CatalogNode>();
  documents = new Map<string, { shared?: SharedDocument; assets: Map<string, { type: string; bytes: Uint8Array }> }>();
  creates = new Map<string, { nodeId: CatalogNodeId; sharedDocumentId: string | null }>();
  createRequests: string[] = [];
  failAssetUploads = 0;
  offline = false;

  addNode(node: Omit<CatalogNode, "revision" | "titleVersion" | "createdBy" | "isShareRoot"> & Partial<CatalogNode>): CatalogNode {
    const value: CatalogNode = { revision: ++this.revision, titleVersion: 1, createdBy: node.ownerId, isShareRoot: node.parentId === null, ...node };
    this.nodes.set(value.id, value);
    return value;
  }
  addDocument(sharedDocumentId: string, document: SigmaDocument, assets: Record<string, Uint8Array>): void {
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId, epoch: 1 });
    this.documents.set(sharedDocumentId, { shared, assets: new Map(Object.entries(assets).map(([id, bytes]) => [id, { type: "image/png", bytes }])) });
    cleanups.push(async () => shared.destroy());
  }
  project(sharedDocumentId: string): SigmaDocument {
    return JSON.parse(JSON.stringify(this.documents.get(sharedDocumentId)!.shared!.project())) as SigmaDocument;
  }
  /** The real room refuses any `src` that is not an image uploaded to this same document. */
  private validate(sharedDocumentId: string, value: unknown): void {
    const assets = this.documents.get(sharedDocumentId)!.assets;
    for (const src of imageSources(value)) {
      const match = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})$/.exec(src);
      if (!match || !assets.has(match[1])) throw new CollaborationHttpError("MISSING_ASSET", 400);
    }
  }
  private document(route: string): { id: string; action: string } | null {
    const match = /^\/documents\/([^/]+)\/(.+)$/.exec(route);
    return match ? { id: match[1], action: match[2] } : null;
  }
  async request(route: string, body?: unknown): Promise<unknown> {
    if (this.offline) throw new TypeError("fetch failed");
    if (route === "/catalog/capabilities") return { hierarchySharingEnabled: true, canStartDocumentShare: true, documentShareSource: "entitlement", canStartHierarchyShare: true, hierarchyShareSource: "entitlement" };
    if (route === "/catalog/delta") {
      const known = (body as { knownIds?: string[] }).knownIds ?? [];
      return { revision: this.revision, nodes: [...this.nodes.values()], tombstones: known.filter((id) => !this.nodes.has(id)).map((id) => ({ id, deleted: true, revision: this.revision })) };
    }
    if (route === "/catalog/nodes") {
      const input = body as { operationId: string; parentId: CatalogNodeId; kind: "folder" | "document"; name: string };
      this.createRequests.push(input.operationId);
      const existing = this.creates.get(input.operationId);
      if (existing) return existing;
      const parent = this.nodes.get(input.parentId);
      if (!parent?.capabilities.createChildren) throw new CollaborationHttpError("FORBIDDEN", 403);
      const sharedDocumentId = input.kind === "document" ? randomUUID() : null;
      const created = this.addNode({ id: randomUUID() as CatalogNodeId, kind: input.kind, parentId: parent.id, ownerId: parent.ownerId, createdBy: ACTOR, name: input.name, sharedDocumentId: sharedDocumentId as SharedDocumentId | null, state: input.kind === "document" ? "initializing" : "active", role: parent.role, capabilities: parent.capabilities, isShareRoot: false });
      if (sharedDocumentId) this.documents.set(sharedDocumentId, { assets: new Map() });
      const result = { nodeId: created.id, sharedDocumentId };
      this.creates.set(input.operationId, result);
      return result;
    }
    const target = this.document(route);
    const document = target && this.documents.get(target.id);
    if (!target || !document) throw new CollaborationHttpError("NOT_FOUND", 404);
    if (target.action === "initialize") {
      if (document.shared) return { seq: 0 };
      const candidate = new SharedDocument(fromBase64((body as { state: string }).state));
      try { this.validate(target.id, candidate.project()); } catch (error) { candidate.destroy(); throw error; }
      document.shared = candidate;
      cleanups.push(async () => candidate.destroy());
      const node = [...this.nodes.values()].find((item) => item.sharedDocumentId === target.id)!;
      node.state = "active";
      node.revision = ++this.revision;
      return { seq: 0 };
    }
    const node = [...this.nodes.values()].find((item) => item.sharedDocumentId === target.id)!;
    if (!document.shared) throw new CollaborationHttpError("NOT_INITIALIZED", 409);
    if (target.action === "snapshot") return { state: toBase64(document.shared.snapshot()), role: node.role, epoch: 1 };
    if (target.action === "sync") return { update: toBase64(document.shared.difference(fromBase64((body as { vector: string }).vector))), role: node.role, epoch: 1, protocol: 1 };
    if (target.action === "updates") {
      const operations = (body as { operations: { operationId: string; update: string }[] }).operations;
      return { acks: operations.map((operation, index) => {
        const candidate = document.shared!.prepareUpdate(fromBase64(operation.update), (value) => this.validate(target.id, value));
        candidate.destroy();
        document.shared!.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: index + 1 };
      }) };
    }
    throw new Error(`UNEXPECTED_ROUTE ${route}`);
  }
  async requestRaw(route: string, init: RequestInit = {}): Promise<Response> {
    if (this.offline) throw new TypeError("fetch failed");
    const target = this.document(route);
    const asset = target?.action.startsWith("assets/") ? target.action.slice(7) : null;
    const document = target && this.documents.get(target.id);
    if (!asset || !document) throw new Error(`UNEXPECTED_RAW_ROUTE ${route}`);
    if (init.method === "PUT") {
      if (this.failAssetUploads > 0) { this.failAssetUploads--; throw new TypeError("fetch failed"); }
      document.assets.set(asset, { type: String(new Headers(init.headers).get("Content-Type")), bytes: new Uint8Array(init.body as Uint8Array) });
      return new Response(null, { status: 204 });
    }
    const stored = document.assets.get(asset);
    if (!stored) throw new CollaborationHttpError("MISSING_ASSET", 404);
    return new Response(Buffer.from(stored.bytes), { headers: { "Content-Type": stored.type } });
  }
}

/** One app process: the main-process session, catalog and library wired as `main.ts` wires them. */
async function launch(directory: string, server: FakeServer) {
  const local = new LocalSigmaDocStore(directory);
  const sessions = new CollaborationSessions(directory, local, () => {});
  Object.defineProperty(sessions, "auth", { value: {
    initialize: async () => {}, cancelSignIn: () => {}, user: () => ({ id: ACTOR }),
    config: { apiUrl: "https://sync.example.test" }, authorization: async () => "Bearer fixture",
    accountSignal: () => new AbortController().signal,
  } });
  vi.spyOn(sessions, "request").mockImplementation((route: string, body?: unknown) => server.request(route, body) as never);
  (sessions as unknown as { requestRaw(route: string, init?: RequestInit): Promise<Response> }).requestRaw = (route, init) => server.requestRaw(route, init);
  vi.spyOn(sessions as unknown as { connect(fileId: string): Promise<void> }, "connect").mockResolvedValue();
  vi.spyOn(sessions as unknown as { needsRetry(): boolean }, "needsRetry").mockReturnValue(false);
  const catalog = new DesktopSharedCatalog(sessions.directory, local, catalogSessionsPort(sessions), () => {});
  local.setLibraryAuthority(catalog.authority());
  local.setDocumentAuthority({
    read: async (fileId) => catalog.read(fileId),
    save: async (fileId, document) => sessions.has(fileId) ? sessions.boundarySave(fileId, document) : undefined,
  });
  await sessions.initialize();
  await local.initializeWorkspace({ initialDocument: createBlankDocument("ローカルの教材") });
  await catalog.refresh();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; catalog.close(); await sessions.close(); } };
  cleanups.push(close);
  return { local, sessions, catalog, close };
}

async function fixture() {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-duplicate-"));
  directories.push(directory);
  return { directory, server: new FakeServer() };
}

/** A folder another account shares with me, holding one material with an image. */
function sharedFolderWithImage(server: FakeServer, role: "editor" | "viewer" = "editor") {
  const folder = server.addNode({ id: randomUUID() as CatalogNodeId, kind: "folder", parentId: null, ownerId: "owner", name: "共有フォルダ", sharedDocumentId: null, state: "active", role, capabilities: capabilities(role === "viewer" ? { editDocument: false, createChildren: false } : {}) });
  const sharedDocumentId = randomUUID();
  const material = server.addNode({ id: randomUUID() as CatalogNodeId, kind: "document", parentId: folder.id, ownerId: "owner", name: "図つきの教材", sharedDocumentId: sharedDocumentId as SharedDocumentId, state: "active", role, capabilities: capabilities(role === "viewer" ? { editDocument: false, createChildren: false } : {}) });
  server.addDocument(sharedDocumentId, imageDocument("図つきの教材", "sigma-doc-storage://img_source"), { img_source: IMAGE_BYTES });
  return { folder, material, sharedDocumentId };
}

async function fileOf(local: LocalSigmaDocStore, node: CatalogNode) {
  const file = (await local.listFiles()).find((item) => item.sharing?.target.catalogNodeId === node.id);
  if (!file) throw new Error("SHARED_FILE_NOT_LISTED");
  return file;
}

it("duplicates a material in an editable shared folder into that folder, with its images in the new shared document", async () => {
  const { directory, server } = await fixture();
  const { material, sharedDocumentId } = sharedFolderWithImage(server);
  const app = await launch(directory, server);
  const source = await fileOf(app.local, material);
  // Opened in the editor first, as the menu command does.
  expect(paragraphText((await app.local.loadDocument(source.fileId))!)).toBe("本文");
  const before = server.project(sharedDocumentId);

  const copy = await app.local.duplicateFile(source.fileId);

  // New shared names never contain spaces (`spaceFreeFileName`).
  expect(copy.file.title).toBe("図つきの教材-のコピー");
  expect(copy.file.sharing?.target.kind).toBe("document");
  expect([copy.file.workspaceId, copy.file.folderId]).toEqual([source.workspaceId, source.folderId]);
  const copyNode = [...server.nodes.values()].find((node) => node.id === copy.file.sharing?.target.catalogNodeId)!;
  expect(copyNode.parentId).toBe(material.parentId);
  const copied = server.project(copyNode.sharedDocumentId!);
  expect(paragraphText(copied)).toBe("本文");
  // The copy refers to an image of its own document, uploaded with the same bytes.
  const [copiedSource] = imageSources(copied);
  const assetId = /^sigma-doc-storage:\/\/(.+)$/.exec(copiedSource)![1];
  expect(Buffer.from(server.documents.get(copyNode.sharedDocumentId!)!.assets.get(assetId)!.bytes)).toEqual(IMAGE_BYTES);
  await expect(app.sessions.asset(copy.file.fileId, assetId)).resolves.toBe(IMAGE_SOURCE);
  expect(server.project(sharedDocumentId)).toEqual(before);
  expect(Object.values((await CatalogCache.open(app.sessions.directory, ACTOR)).data.creates).every((intent) => intent.complete && !intent.document)).toBe(true);

  // Editing the copy leaves the original untouched.
  const editor = new SharedDocument(fromBase64(app.sessions.describe(copy.file.fileId).state));
  const vector = editor.vector();
  const edited = JSON.parse(JSON.stringify(editor.project())) as SigmaDocument;
  (edited.content[0] as { children: { type: string; text: string }[] }).children = [{ type: "text", text: "コピーだけの変更" }];
  editor.change(JSON.parse(JSON.stringify(editor.project())) as ObjectValue, edited as unknown as ObjectValue);
  await app.sessions.update(copy.file.fileId, toBase64(editor.difference(vector)), randomUUID(), "manual", 1);
  editor.destroy();
  await app.sessions.flush(copy.file.fileId, true);
  expect(paragraphText(server.project(copyNode.sharedDocumentId!))).toBe("コピーだけの変更");
  expect(server.project(sharedDocumentId)).toEqual(before);

  // After a restart both reopen with their own content, and the copy's image is still served.
  await app.close();
  const restarted = await launch(directory, server);
  expect(paragraphText((await restarted.local.loadDocument(copy.file.fileId))!)).toBe("コピーだけの変更");
  expect(paragraphText((await restarted.local.loadDocument(source.fileId))!)).toBe("本文");
  const served = await restarted.sessions.assetResponse(copiedSource);
  expect(served.status).toBe(200);
  expect(Buffer.from(await served.arrayBuffer())).toEqual(IMAGE_BYTES);
});

it("copies a material shared with me on its own into my own workspace, carrying its images", async () => {
  const { directory, server } = await fixture();
  const sharedDocumentId = randomUUID();
  const material = server.addNode({ id: randomUUID() as CatalogNodeId, kind: "document", parentId: null, ownerId: "owner", name: "受け取った教材", sharedDocumentId: sharedDocumentId as SharedDocumentId, state: "active", role: "editor", capabilities: capabilities({ createChildren: false }) });
  server.addDocument(sharedDocumentId, imageDocument("受け取った教材", "sigma-doc-storage://img_source"), { img_source: IMAGE_BYTES });
  const app = await launch(directory, server);
  const personal = (await app.local.withLocalLibrary(() => app.local.getLocalLibrarySnapshot())).workspaces[0];
  const source = await fileOf(app.local, material);
  expect(source.workspaceId).toBe("shared-items");
  const before = server.project(sharedDocumentId);

  const copy = await app.local.duplicateFile(source.fileId);

  expect(copy.file.sharing).toBeUndefined();
  expect([copy.file.workspaceId, copy.file.folderId]).toEqual([personal.id, null]);
  expect(imageSources(copy.document)).toEqual([IMAGE_SOURCE]);
  expect(server.createRequests).toEqual([]);
  expect(server.project(sharedDocumentId)).toEqual(before);
  await app.close();
  // The local copy keeps the image itself: it no longer depends on the shared session.
  const reopened = await new LocalSigmaDocStore(directory).loadDocument(copy.file.fileId);
  expect(reopened?.metadata.title).toBe("受け取った教材-のコピー");
  expect(imageSources(reopened)).toEqual([IMAGE_SOURCE]);
});

it("copies a material from a folder I can only view into my own workspace without asking the server to create it", async () => {
  const { directory, server } = await fixture();
  const { material } = sharedFolderWithImage(server, "viewer");
  const app = await launch(directory, server);
  const source = await fileOf(app.local, material);

  const copy = await app.local.duplicateFile(source.fileId);

  expect(copy.file.sharing).toBeUndefined();
  expect(copy.file.workspaceId).not.toBe(source.workspaceId);
  expect(imageSources(copy.document)).toEqual([IMAGE_SOURCE]);
  expect(server.createRequests).toEqual([]);
});

it("keeps an owner's privately duplicated material next to the original, with the images inlined", async () => {
  const { directory, server } = await fixture();
  const app = await launch(directory, server);
  const workspace = (await app.local.withLocalLibrary(() => app.local.getLocalLibrarySnapshot())).workspaces[0];
  const folder = await app.local.withLocalLibrary(() => app.local.createFolder(workspace.id, "授業"));
  if (folder.state !== "ready") throw new Error("FOLDER_NOT_READY");
  const folderId = folder.overview.folders[0].id;
  const local = await app.local.createFileFromDocument({ document: imageDocument("自分の共有教材", IMAGE_SOURCE), workspaceId: workspace.id, folderId });
  // Sharing it on its own (free plan) moves the image into the shared document.
  const sharedDocumentId = randomUUID();
  vi.mocked(app.sessions.request).mockImplementation(async (route: string, body?: unknown) => {
    if (route === "/documents") {
      server.documents.set(sharedDocumentId, { assets: new Map() });
      server.addNode({ id: randomUUID() as CatalogNodeId, kind: "document", parentId: null, ownerId: ACTOR, name: "自分の共有教材", sharedDocumentId: sharedDocumentId as SharedDocumentId, state: "initializing", role: "owner", capabilities: capabilities({ createChildren: false, stopRootShare: true, deleteRootShare: true }) });
      return { id: sharedDocumentId, epoch: 1 } as never;
    }
    return server.request(route, body) as never;
  });
  await app.sessions.start(local.file.fileId, (await app.local.withLocalLibrary(() => app.local.loadDocument(local.file.fileId)))!);
  await app.sessions.flush(local.file.fileId, true);
  await app.catalog.refresh({ force: true });
  const shared = (await app.local.listFiles()).find((file) => file.fileId === local.file.fileId)!;
  expect(shared.sharing?.placement).toBe("owned");
  expect(imageSources(app.sessions.project(local.file.fileId))[0]).toMatch(/^sigma-doc-storage:\/\//);

  const copy = await app.local.duplicateFile(local.file.fileId);

  expect(copy.file.sharing).toBeUndefined();
  expect([copy.file.workspaceId, copy.file.folderId]).toEqual([workspace.id, folderId]);
  expect(imageSources(copy.document)).toEqual([IMAGE_SOURCE]);
  await app.close();
  expect(imageSources(await new LocalSigmaDocStore(directory).loadDocument(copy.file.fileId))).toEqual([IMAGE_SOURCE]);
});

it("retries a failed duplicate into a shared folder without making a second copy", async () => {
  const { directory, server } = await fixture();
  const { material } = sharedFolderWithImage(server);
  const app = await launch(directory, server);
  const source = await fileOf(app.local, material);
  server.failAssetUploads = 1;

  await expect(app.local.duplicateFile(source.fileId)).rejects.toThrow();
  // The original is still there and unchanged.
  expect(paragraphText((await app.local.loadDocument(source.fileId))!)).toBe("本文");

  const copy = await app.local.duplicateFile(source.fileId);
  expect(copy.file.title).toBe("図つきの教材-のコピー");
  const copies = [...server.nodes.values()].filter((node) => node.kind === "document" && node.id !== material.id);
  expect(copies.map((node) => [node.name, node.state])).toEqual([["図つきの教材-のコピー", "active"]]);
  expect(new Set(server.createRequests).size).toBe(1);
  expect(Object.values((await CatalogCache.open(app.sessions.directory, ACTOR)).data.creates).every((intent) => intent.complete)).toBe(true);
  // A deliberate second duplicate is a new copy.
  const second = await app.local.duplicateFile(source.fileId);
  expect(second.file.fileId).not.toBe(copy.file.fileId);
  expect([...server.nodes.values()].filter((node) => node.kind === "document").length).toBe(3);
});

it("makes a private copy while the catalog is unreachable, but resumes an unfinished copy rather than adding one", async () => {
  const { directory, server } = await fixture();
  const { material } = sharedFolderWithImage(server);
  const app = await launch(directory, server);
  const source = await fileOf(app.local, material);
  // Opening the material online caches its image on this PC.
  await app.local.loadDocument(source.fileId);
  await app.sessions.flush(source.fileId, true);

  server.offline = true;
  // An edit made while offline is only in this PC's journal; the copy still carries it.
  const editor = new SharedDocument(fromBase64(app.sessions.describe(source.fileId).state));
  const vector = editor.vector();
  const edited = JSON.parse(JSON.stringify(editor.project())) as SigmaDocument;
  (edited.content[0] as { children: { type: string; text: string }[] }).children = [{ type: "text", text: "未送信の編集" }];
  editor.change(JSON.parse(JSON.stringify(editor.project())) as ObjectValue, edited as unknown as ObjectValue);
  await app.sessions.update(source.fileId, toBase64(editor.difference(vector)), randomUUID(), "manual", 1);
  editor.destroy();
  const offlineCopy = await app.local.duplicateFile(source.fileId);
  expect(offlineCopy.file.sharing).toBeUndefined();
  expect(paragraphText(offlineCopy.document)).toBe("未送信の編集");
  expect(imageSources(offlineCopy.document)).toEqual([IMAGE_SOURCE]);
  expect(server.createRequests).toEqual([]);

  // A copy into the folder that got as far as the server but not further...
  server.offline = false;
  server.failAssetUploads = 1;
  await expect(app.local.duplicateFile(source.fileId)).rejects.toThrow();
  // ...is not replaced by a private copy while offline: it would finish later beside it.
  server.offline = true;
  const filesBefore = (await app.local.withLocalLibrary(() => app.local.listFiles())).length;
  await expect(app.local.duplicateFile(source.fileId)).rejects.toThrow("CATALOG_OFFLINE");
  expect((await app.local.withLocalLibrary(() => app.local.listFiles())).length).toBe(filesBefore);
  server.offline = false;
  const copy = await app.local.duplicateFile(source.fileId);
  expect(copy.file.sharing?.target.kind).toBe("document");
  expect([...server.nodes.values()].filter((node) => node.kind === "document").map((node) => node.state)).toEqual(["active", "active"]);
});

it("refuses to copy a material whose access was withdrawn since it was listed, creating nothing", async () => {
  const { directory, server } = await fixture();
  const { material } = sharedFolderWithImage(server);
  const app = await launch(directory, server);
  const source = await fileOf(app.local, material);
  const before = (await app.local.withLocalLibrary(() => app.local.listFiles())).length;
  server.nodes.delete(material.id);

  await expect(app.local.duplicateFile(source.fileId)).rejects.toThrow("TARGET_UNAVAILABLE");
  expect((await app.local.withLocalLibrary(() => app.local.listFiles())).length).toBe(before);
  expect(server.createRequests).toEqual([]);
});
