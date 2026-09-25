import { createSingleGroupWorkspaceLayout, documentWorkspaceTab, splitWorkspaceGroupWithTab } from "@/lib/workspace-tab-groups";
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CatalogNode, CatalogNodeId, SharedDocumentId } from "@/features/collaboration/model/catalog";
import { createBlankDocument } from "@/lib/blank-document";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CatalogCache } from "./catalog-cache";
import { DesktopSharedCatalog, type CatalogSessionsPort } from "./catalog";
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
function node(kind: CatalogNode["kind"], parentId: CatalogNodeId | null = null): CatalogNode {
  return { id: randomUUID() as CatalogNodeId, kind, parentId, ownerId: "owner", createdBy: "owner", name: kind, sharedDocumentId: kind === "document" ? randomUUID() as SharedDocumentId : null, state: "active", isShareRoot: parentId === null, role: "editor", titleVersion: 1, revision: 1,
    capabilities: { read: true, editDocument: true, createChildren: true, rename: true, move: true, deleteDescendants: true, invite: false, manageEditorViewer: false, appointAdmin: false, stopRootShare: false, deleteRootShare: false, restoreDocument: false, startHierarchyShare: false } };
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-catalog-")); directories.push(directory);
  const local = new LocalSigmaDocStore(directory);
  await local.initializeWorkspace({ initialDocument: createBlankDocument("local") });
  let actor: string | null = "participant";
  let nodes: CatalogNode[] = [];
  let offline = false;
  const document = createBlankDocument("remote body");
  const request = vi.fn(async (route: string, body?: unknown): Promise<unknown> => {
    if (offline) throw new Error("NETWORK_UNAVAILABLE");
    if (route === "/catalog/capabilities") return { hierarchySharingEnabled: true, canStartDocumentShare: true, documentShareSource: "trial", canStartHierarchyShare: true, hierarchyShareSource: "trial" };
    if (route === "/catalog/delta") return { revision: 1, nodes, tombstones: ((body as { knownIds: string[] }).knownIds ?? []).filter(id => !nodes.some(n => n.id === id)).map(id => ({ id, deleted: true, revision: 1 })) };
    if (route.endsWith("/members")) return [];
    if (route.endsWith("/rename")) { const id = route.split("/")[3]; const target = nodes.find(n => n.id === id)!; target.name = (body as { name: string }).name; return {}; }
    throw new Error(`UNEXPECTED_REQUEST ${route}`);
  });
  const open = vi.fn(async () => document);
  const sessions: CatalogSessionsPort = {
    recoverLocked: vi.fn(async () => ({ saved: 0, failed: 0 })), actorId: () => actor, request: request as CatalogSessionsPort["request"], bindings: () => [], has: () => false, open, initialize: vi.fn(), activate: vi.fn(), start: vi.fn(), flush: vi.fn(), retainLocal: vi.fn(), restrict: vi.fn() };
  const emit = vi.fn();
  const catalog = new DesktopSharedCatalog(directory, local, sessions, emit);
  local.setLibraryAuthority(catalog.authority());
  local.setDocumentAuthority({ read: id => catalog.read(id), save: async () => undefined });
  return { directory, local, catalog, sessions, request, open, emit, setNodes: (value: CatalogNode[]) => { nodes = value; }, setActor: (value: string | null) => { actor = value; }, setOffline: (value: boolean) => { offline = value; } };
}
it("lists metadata lazily, retains file identity through workspace grant/revoke and restart", async () => {
  const f = await fixture(); const workspace = node("workspace"); const folder = node("folder", workspace.id); const doc = node("document", folder.id);
  f.setNodes([doc]); await f.catalog.refresh();
  const initial = await f.catalog.overview("shared-items"); expect(initial.state).toBe("ready");
  if (initial.state !== "ready") throw new Error();
  const fileId = initial.overview.files[0].fileId;
  expect(f.open).not.toHaveBeenCalled();
  f.setNodes([workspace, folder, doc]); await f.catalog.refresh();
  const all = await f.local.listFiles(); expect(all.filter(file => file.fileId === fileId)).toHaveLength(1);
  expect(all.find(file => file.fileId === fileId)?.workspaceId).toBe(`catalog_${workspace.id}`);
  const sharedItems = await f.catalog.overview("shared-items");
  if (sharedItems.state === "ready") expect(sharedItems.overview.workspaces.some(w => w.id === "shared-items")).toBe(false);
  await f.local.loadDocument(fileId); expect(f.open).toHaveBeenCalledTimes(1);
  f.setNodes([doc]); await f.catalog.refresh();
  const returned = (await f.local.listFiles()).find(file => file.fileId === fileId)!;
  expect(returned.workspaceId).toBe("shared-items"); expect(returned.sharing?.bodyCached).toBe(true);
  const cache = await CatalogCache.open(f.directory, "participant");
  expect(cache.data.mappings[doc.id].local).toEqual({ kind: "document", fileId });
  expect(cache.data.mappings[doc.id].bodyCached).toBe(true);
  expect((await f.local.getLocalLibrarySnapshot()).files).toHaveLength(1);
  expect(f.request.mock.calls.every(([route]) => !route.includes("snapshot"))).toBe(true);
});
it("discards an in-flight old-account catalog and clears visible data immediately", async () => {
  const f = await fixture(); const doc = node("document"); f.setNodes([doc]); await f.catalog.refresh();
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const prior = f.sessions.request;
  f.sessions.request = async (route, body) => { if (route === "/catalog/delta") { started.resolve(); await release.promise; } return prior(route, body); };
  const pending = f.catalog.refresh(); await started.promise;
  f.setActor(null); expect((await f.catalog.status()).state).toBe("signed-out");
  expect((await f.local.listFiles()).some(file => file.sharing)).toBe(false);
  release.resolve(); expect((await pending).state).toBe("signed-out");
  f.setActor("different"); expect((await f.local.listFiles()).some(file => file.sharing)).toBe(false);
});
it("counts visible direct children after catalog create, move and revoke without loading bodies", async () => {
  const f = await fixture(); const workspace = node("workspace");
  const folder = node("folder", workspace.id), nested = node("folder", folder.id);
  const first = node("document", folder.id), second = node("document", nested.id);
  const counts = async () => {
    const result = await f.catalog.overview(`catalog_${workspace.id}`);
    if (result.state !== "ready") throw new Error("OVERVIEW_NOT_READY");
    return result.overview.folders.map(item => [item.id, item.fileCount]);
  };
  f.setNodes([workspace, folder, nested, first, second]); await f.catalog.refresh();
  expect(await counts()).toEqual([[`catalog_${folder.id}`, 1], [`catalog_${nested.id}`, 1]]);
  const created = node("document", folder.id);
  f.setNodes([workspace, folder, nested, first, second, created]); await f.catalog.refresh();
  expect(await counts()).toEqual([[`catalog_${folder.id}`, 2], [`catalog_${nested.id}`, 1]]);
  created.parentId = nested.id;
  await f.catalog.refresh();
  expect(await counts()).toEqual([[`catalog_${folder.id}`, 1], [`catalog_${nested.id}`, 2]]);
  f.setNodes([workspace, folder, nested, first]); await f.catalog.refresh();
  expect(await counts()).toEqual([[`catalog_${folder.id}`, 1], [`catalog_${nested.id}`, 0]]);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(([route]) => !route.includes("snapshot"))).toBe(true);
});
it("blocks offline hierarchy mutations without loading a body or changing local source", async () => {
  const f = await fixture(); const doc = node("document"); f.setNodes([doc]); await f.catalog.refresh();
  const file = (await f.local.listFiles()).find(file => file.sharing)!; f.setOffline(true);
  await expect(f.catalog.renameDocument("shared-items", file.fileId, "changed")).rejects.toThrow("CATALOG_OFFLINE");
  await expect(f.local.deleteFile(file.fileId)).rejects.toThrow("CATALOG_OFFLINE");
  expect(f.open).not.toHaveBeenCalled(); expect((await f.local.listFiles()).find(item => item.fileId === file.fileId)?.title).toBe("document");
});
it("keeps new descendants of a standalone shared folder in the owner's hierarchy after restart", async () => {
  const f = await fixture();
  const workspaceId = (await f.local.getLocalLibrarySnapshot()).activeWorkspaceId;
  await f.local.createFolder(workspaceId, "Private parent");
  let raw = await f.local.getLocalLibrarySnapshot();
  const privateParent = raw.folders[0].id;
  await f.local.createFolder(workspaceId, "Shared root", privateParent);
  raw = await f.local.getLocalLibrarySnapshot();
  const localRoot = raw.folders.find(folder => folder.name === "Shared root")!;
  const root = { ...node("folder"), ownerId: "participant" };
  const child = { ...node("folder", root.id), ownerId: "participant", createdBy: "other-user" };
  const direct = { ...node("document", root.id), ownerId: "participant", createdBy: "other-user" };
  const nested = { ...node("document", child.id), ownerId: "participant" };
  const cache = await CatalogCache.open(f.directory, "participant");
  // Reproduce existing caches: only the shared root has an owner location,
  // and older versions did not persist its private parent folder.
  cache.data.mappings[root.id] = { nodeId: root.id, local: { kind: "folder", workspaceId, folderId: localRoot.id }, workspaceId, bodyCached: false };
  cache.apply({ revision: 1, nodes: [root, child, direct, nested], tombstones: [] });
  const directId = cache.navigationId(direct);
  const nestedId = cache.navigationId(nested);
  const assertPlacement = (current: CatalogCache) => {
    const view = current.project(raw, workspaceId);
    expect(view.folders.find(folder => folder.id === localRoot.id)?.parentFolderId).toBe(privateParent);
    expect(view.folders.find(folder => folder.id === current.navigationId(child))).toMatchObject({ workspaceId, parentFolderId: localRoot.id, fileCount: 1 });
    expect(view.files.find(file => file.fileId === directId)).toMatchObject({ workspaceId, folderId: localRoot.id, sharing: { createdBy: "other-user" } });
    expect(view.files.find(file => file.fileId === nestedId)).toMatchObject({ workspaceId, folderId: current.navigationId(child) });
    expect(view.workspaces.some(workspace => workspace.id === "shared-items")).toBe(false);
    expect(view.files.some(file => file.workspaceId === "shared-items")).toBe(false);
  };
  assertPlacement(cache);
  await cache.save();
  assertPlacement(await CatalogCache.open(f.directory, "participant"));
  expect(f.open).not.toHaveBeenCalled();
  expect((await f.local.getLocalLibrarySnapshot()).files).toEqual(raw.files);
  const recipient = await CatalogCache.open(f.directory, "other-user");
  recipient.apply({ revision: 1, nodes: [root, child, direct, nested], tombstones: [] });
  const received = recipient.project(raw, "shared-items");
  expect(received.folders).toHaveLength(2);
  expect(received.files).toHaveLength(2);
  expect(received.folders.find(folder => folder.id === recipient.navigationId(child))?.parentFolderId).toBe(recipient.navigationId(root));
});
it("uses the current shared parent after moving an owned child between standalone roots", async () => {
  const f = await fixture();
  const cache = await CatalogCache.open(f.directory, "participant");
  const first = { ...node("folder"), ownerId: "participant" };
  const second = { ...node("folder"), ownerId: "participant" };
  const child = { ...node("document", first.id), ownerId: "participant" };
  for (const [root, workspaceId, folderId] of [[first, "workspace-a", "folder-a"], [second, "workspace-b", "folder-b"]] as const) {
    cache.data.mappings[root.id] = { nodeId: root.id, local: { kind: "folder", workspaceId, folderId }, workspaceId, bodyCached: false };
  }
  cache.apply({ revision: 1, nodes: [first, second, child], tombstones: [] });
  Object.assign(cache.data.mappings[child.id], { workspaceId: "workspace-a", folderId: "folder-a" });
  expect(cache.location(child)).toEqual({ workspaceId: "workspace-a", folderId: "folder-a" });
  const moved = { ...child, parentId: second.id, revision: 2 };
  cache.apply({ revision: 2, nodes: [moved], tombstones: [] });
  expect(cache.location(moved)).toEqual({ workspaceId: "workspace-b", folderId: "folder-b" });
  expect(cache.navigationId(moved)).toBe(cache.navigationId(child));
});
for (const actor of [null, "participant"]) it(`persists local workspace selection with catalog authority (${actor ?? "signed out"})`, async () => {
  const f = await fixture(); f.setActor(actor);
  const first = (await f.local.getLocalLibrarySnapshot()).activeWorkspaceId;
  await f.local.createWorkspace("Second");
  const selected = await f.local.getWorkspaceOverview(first);
  expect(selected.state).toBe("ready");
  const restarted = new LocalSigmaDocStore(f.directory);
  expect((await restarted.getLocalLibrarySnapshot()).activeWorkspaceId).toBe(first);
  const again = await f.catalog.overview();
  if (again.state !== "ready") throw new Error("OVERVIEW_NOT_READY");
  expect(again.overview.activeWorkspaceId).toBe(first);
  expect(f.open).not.toHaveBeenCalled();
});
it("routes all shared library operations through authority and renames without JSON saves", async () => {
  const f = await fixture(); const workspace = node("workspace"); const folder = node("folder", workspace.id); const doc = node("document", folder.id); f.setNodes([workspace, folder, doc]); await f.catalog.refresh();
  const file = (await f.local.listFiles()).find(file => file.sharing)!;
  const save = vi.spyOn(f.local, "saveDocument");
  await f.catalog.renameDocument(file.workspaceId, file.fileId, "Renamed");
  expect((await f.local.listFiles()).find(item => item.fileId === file.fileId)?.title).toBe("Renamed");
  expect(save).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  const raw = await f.local.getLocalLibrarySnapshot();
  await expect(f.local.moveFileToWorkspace(file.fileId, raw.activeWorkspaceId)).rejects.toThrow("OWNER_REQUIRED");
  await expect(f.local.createDocument({ workspaceId: "shared-items" })).rejects.toThrow("TARGET_UNAVAILABLE");
  expect((await f.local.getLocalLibrarySnapshot()).files).toHaveLength(1);
});
it("rejects stale local selections instead of presenting them as unshared", async () => {
  const f = await fixture(); await f.catalog.refresh();
  await expect(f.catalog.details({ source: "local", local: { kind: "folder", workspaceId: "missing", folderId: "missing" } })).rejects.toThrow("TARGET_UNAVAILABLE");
  const localFile = (await f.local.listFiles())[0];
  expect(await f.catalog.details({ source: "local", local: { kind: "document", fileId: localFile.fileId } })).toBeNull();
});
it("does not emit catalog events for repeated unchanged details refreshes", async () => {
  const f = await fixture(); const doc = node("document"); f.setNodes([doc]); await f.catalog.refresh();
  const count = f.emit.mock.calls.length;
  for (let i = 0; i < 3; i++) await f.catalog.details({ source: "shared", shared: { kind: "document", catalogNodeId: doc.id } });
  expect(f.emit).toHaveBeenCalledTimes(count);
});
it("does not install a late poll after visibility cleanup during refresh", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const prior = f.sessions.request;
  f.sessions.request = async (route, body) => { if (route === "/catalog/delta") { started.resolve(); await release.promise; } return prior(route, body); };
  const showing = f.catalog.setVisible(true); await started.promise; await f.catalog.setVisible(false);
  release.resolve(); await showing;
  vi.useFakeTimers(); const count = f.request.mock.calls.length; await vi.advanceTimersByTimeAsync(15000); expect(f.request).toHaveBeenCalledTimes(count);
  f.catalog.close();
});
it("older delta tombstones cannot erase a newly regranted node and historical mappings do not mask active shares", async () => {
  const f = await fixture(); const cache = await CatalogCache.open(f.directory, "participant");
  const old = node("workspace"); const fresh = { ...node("workspace"), revision: 9 };
  cache.data.mappings[old.id] = { nodeId: old.id, local: { kind: "workspace", workspaceId: "local-workspace" }, bodyCached: false };
  cache.data.mappings[fresh.id] = { nodeId: fresh.id, local: { kind: "workspace", workspaceId: "local-workspace" }, bodyCached: false };
  cache.apply({ revision: 9, nodes: [fresh], tombstones: [] });
  cache.apply({ revision: 4, nodes: [], tombstones: [{ id: fresh.id, deleted: true, revision: 4 }] });
  expect(cache.data.nodes[fresh.id]).toEqual(fresh);
  expect(cache.nodeForLocal({ kind: "workspace", workspaceId: "local-workspace" })?.id).toBe(fresh.id);
});
it("journals create identity before POST and reuses it after lost ACK and restart", async () => {
  const f = await fixture(); const parent = node("workspace"); f.setNodes([parent]); await f.catalog.refresh();
  const requests: string[] = []; const created = node("folder", parent.id); let fail = true;
  const prior = f.sessions.request;
  f.sessions.request = async (route, body) => {
    if (route === "/catalog/nodes") {
      requests.push((body as { operationId: string }).operationId);
      const saved = await CatalogCache.open(f.directory, "participant"); expect(saved.data.creates[requests[0]].complete).toBe(false);
      if (fail) { fail = false; throw new Error("ACK_LOST"); }
      f.setNodes([parent, created]); return { nodeId: created.id, sharedDocumentId: null } as never;
    }
    return prior(route, body);
  };
  await expect(f.local.createFolder(`catalog_${parent.id}`, "created")).rejects.toThrow("ACK_LOST");
  const restarted = new DesktopSharedCatalog(f.directory, f.local, f.sessions, vi.fn());
  await restarted.recoverPending();
  expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
  expect((await CatalogCache.open(f.directory, "participant")).data.creates[requests[0]].complete).toBe(true);
});
it("resumes a partially staged hierarchy, freezes structure, and captures later local body edits", async () => {
  const f = await fixture(); const raw = await f.local.getLocalLibrarySnapshot(); const file = raw.files[0];
  const root = { ...node("workspace"), ownerId: "participant" };
  const remote = { ...node("document", root.id), ownerId: "participant" };
  let failStage = true;
  const operationIds: string[] = [];
  const prior = f.sessions.request;
  f.sessions.request = async (route, body) => {
    if (route === "/catalog/share/begin") { operationIds.push((body as { operationId: string }).operationId); return { operationId: operationIds[0], rootNodeId: root.id, state: "staging", stagedCount: 0, pendingDocumentIds: [] } as never; }
    if (route === "/catalog/share/stage") { if (failStage) { failStage = false; throw new Error("STAGING_LOST"); } return { nodeId: remote.id, sharedDocumentId: remote.sharedDocumentId, existing: false } as never; }
    if (route === "/catalog/share/complete") { f.setNodes([root, remote]); return {} as never; }
    return prior(route, body);
  };
  await expect(f.catalog.start({ kind: "workspace", workspaceId: raw.activeWorkspaceId })).rejects.toThrow("STAGING_LOST");
  expect((await f.local.listFiles()).map(f => f.fileId)).toContain(file.fileId);
  const pending = await f.catalog.overview(raw.activeWorkspaceId);
  if (pending.state !== "ready") throw new Error(); expect(pending.overview.workspaces.find(w => w.id === raw.activeWorkspaceId)?.sharingPending).toBe(true);
  await expect(f.local.createDocument({ workspaceId: raw.activeWorkspaceId, title: "must not omit" })).rejects.toThrow("HIERARCHY_SHARE_IN_PROGRESS");
  await expect(f.local.renameWorkspace(raw.activeWorkspaceId, "cannot drift")).rejects.toThrow("HIERARCHY_SHARE_IN_PROGRESS");
  const document = (await f.local.loadDocument(file.fileId))!; document.metadata.title = "latest body title";
  expect((await f.local.saveDocument(file.fileId, document, { expectedRevision: file.revision })).ok).toBe(true);
  const restarted = new DesktopSharedCatalog(f.directory, f.local, f.sessions, vi.fn());
  await restarted.recoverPending();
  expect(operationIds).toEqual([operationIds[0], operationIds[0]]);
  expect(f.sessions.initialize).toHaveBeenCalledWith(file.fileId, remote.sharedDocumentId, operationIds[0], expect.objectContaining({ metadata: expect.objectContaining({ title: "latest body title" }) }), true);
  const persisted = await CatalogCache.open(f.directory, "participant");
  expect(Object.values(persisted.data.operations)[0].complete).toBe(true);
  expect(persisted.data.mappings[remote.id].local).toEqual({ kind: "document", fileId: file.fileId });
});
it("pending owner documents remain visible even after their session binding has been created", async () => {
  const f = await fixture(); const raw = await f.local.getLocalLibrarySnapshot(); const file = raw.files[0];
  const cache = await CatalogCache.open(f.directory, "participant"); const pendingId = randomUUID() as CatalogNodeId;
  cache.data.mappings[pendingId] = { nodeId: pendingId, local: { kind: "document", fileId: file.fileId }, bodyCached: true };
  cache.data.operations.operation = { operationId: randomUUID(), source: { kind: "workspace", workspaceId: raw.activeWorkspaceId }, name: "pending", complete: false, items: [{ key: file.fileId, parentKey: null, kind: "document", name: file.title, local: { kind: "document", fileId: file.fileId }, nodeId: pendingId }] };
  const projected = cache.project(raw, raw.activeWorkspaceId, new Set([file.fileId]));
  expect(projected.files.map(item => item.fileId)).toContain(file.fileId); expect(projected.files[0].sharingPending).toBe(true);
});
it("bootstraps a private blank when every local file is bound to an inaccessible account", async () => {
  const f = await fixture(); const raw = await f.local.getLocalLibrarySnapshot(); const hidden = raw.files[0].fileId;
  f.sessions.bindings = () => [{ fileId: hidden, sharedDocumentId: "old-shared", actorId: "different" }];
  f.sessions.has = id => id === hidden;
  f.setActor(null);
  const state = await f.local.initializeWorkspace({ initialDocument: createBlankDocument() });
  expect(state.activeFileId).toBeTruthy(); expect(state.activeFileId).not.toBe(hidden);
  expect(state.openFileIds).toEqual([state.activeFileId]);
  expect((await f.local.listFiles()).map(file => file.fileId)).not.toContain(hidden);
  const document = await f.local.loadDocument(state.activeFileId); expect(document).toBeTruthy();
});

it("does not coalesce separate same-title document creates after a lost ACK", async () => {
  const f = await fixture(); const parent = node("workspace"); f.setNodes([parent]); await f.catalog.refresh();
  const prior = f.sessions.request; const operations: string[] = [];
  f.sessions.request = async (route, body) => {
    if (route === "/catalog/nodes") {
      operations.push((body as { operationId: string }).operationId);
      throw new Error("ACK_LOST");
    }
    return prior(route, body);
  };
  const first = createBlankDocument("same title"); const second = createBlankDocument("same title");
  for (const document of [first, second, first]) {
    await expect(f.local.createFileFromDocument({ document, workspaceId: `catalog_${parent.id}` })).rejects.toThrow("ACK_LOST");
  }
  expect(operations[0]).not.toBe(operations[1]); expect(operations[2]).toBe(operations[0]);
  const persisted = await CatalogCache.open(f.directory, "participant");
  expect(Object.values(persisted.data.creates).map(item => item.document?.docId)).toEqual([first.docId, second.docId]);
});

it("persists signed-in split layouts and prunes revoked document tabs on restart", async () => {
  const f = await fixture(); const remote = node("document");
  f.setNodes([remote]); await f.catalog.refresh();
  const files = await f.local.listFiles();
  const localId = files.find(file => !file.sharing)!.fileId;
  const remoteId = files.find(file => file.sharing)!.fileId;
  let layout = createSingleGroupWorkspaceLayout([localId, remoteId], localId);
  layout = splitWorkspaceGroupWithTab(layout, documentWorkspaceTab(remoteId).id, layout.groups[0].id, "right", "second", "split");
  await f.local.saveWorkspace({ openFileIds: [localId, remoteId], activeFileId: remoteId, layout });
  const cache = await CatalogCache.open(f.directory, "participant");
  expect(cache.data.workspaceState?.layout).toEqual(layout);
  const restored = await f.local.initializeWorkspace({ initialDocument: createBlankDocument() });
  expect(restored.layout?.groups).toHaveLength(2);
  f.setNodes([]); await f.catalog.refresh();
  const revoked = await f.local.initializeWorkspace({ initialDocument: createBlankDocument() });
  expect(revoked.layout?.groups).toHaveLength(1);
  expect(revoked.openFileIds).toEqual([localId]);
});

it("rejects viewer folder and document creation before writing intents or local files", async () => {
  const f = await fixture(); const parent = node("workspace");
  parent.role = "viewer";
  parent.capabilities.createChildren = false;
  f.setNodes([parent]); await f.catalog.refresh();
  const before = await f.local.getLocalLibrarySnapshot();
  await expect(f.local.createFolder(`catalog_${parent.id}`, "denied")).rejects.toThrow("FORBIDDEN");
  await expect(f.local.createDocument({ workspaceId: `catalog_${parent.id}`, title: "denied" })).rejects.toThrow("FORBIDDEN");
  await expect(f.local.createFileFromDocument({ workspaceId: `catalog_${parent.id}`, document: createBlankDocument("denied template") })).rejects.toThrow("FORBIDDEN");
  expect((await CatalogCache.open(f.directory, "participant")).data.creates).toEqual({});
  expect(await f.local.getLocalLibrarySnapshot()).toEqual(before);
  expect(f.request.mock.calls.some(([route]) => route === "/catalog/nodes")).toBe(false);
});

it("uses refreshed parent permission when a create races with a role downgrade", async () => {
  const f = await fixture(); const parent = node("folder");
  f.setNodes([parent]); await f.catalog.refresh();
  f.setNodes([{ ...parent, role: "viewer", revision: 2, capabilities: { ...parent.capabilities, createChildren: false } }]);
  await expect(f.local.createDocument({ workspaceId: "shared-items", folderId: `catalog_${parent.id}` })).rejects.toThrow("FORBIDDEN");
  expect((await CatalogCache.open(f.directory, "participant")).data.creates).toEqual({});
  expect(f.request.mock.calls.some(([route]) => route === "/catalog/nodes")).toBe(false);
});

it("reads a shared preview without opening a session or marking the document body cached", async () => {
  const f = await fixture(); const doc = node("document"); f.setNodes([doc]); await f.catalog.refresh();
  const file = (await f.local.listFiles()).find(value => value.sharing)!;
  f.sessions.preview = vi.fn(async () => createBlankDocument("preview"));
  expect((await f.catalog.preview(file.fileId))?.metadata.title).toBe("preview");
  expect(f.sessions.preview).toHaveBeenCalledWith(file.fileId, doc.sharedDocumentId);
  expect(f.open).not.toHaveBeenCalled();
  const cache = await CatalogCache.open(f.directory, "participant");
  expect(cache.data.mappings[doc.id].bodyCached).not.toBe(true);
  f.setActor(null);
  expect(await f.catalog.preview(file.fileId)).toBeNull();
});

it("places owner documents without saved placement in a personal workspace, keeping incoming documents separate", async () => {
  const f = await fixture();
  const originalWorkspaceId = (await f.local.getLocalLibrarySnapshot()).workspaces[0].id;
  await f.local.withLocalLibrary(() => f.local.createWorkspace("second workspace"));
  const owned = { ...node("document"), ownerId: "participant", role: "owner" as const };
  const incoming = node("document");
  f.setNodes([owned, incoming]); await f.catalog.refresh();
  const local = await f.local.getLocalLibrarySnapshot();
  const personal = (await f.catalog.listFiles()).find(file => file.sharing?.target.catalogNodeId === owned.id)!;
  expect(personal.workspaceId).toBe(originalWorkspaceId);
  expect(personal.sharing?.placement).toBe("owned");
  const shared = await f.catalog.overview("shared-items");
  if (shared.state !== "ready") throw new Error("missing overview");
  expect(shared.overview.files.map(file => file.sharing?.target.catalogNodeId)).toEqual([incoming.id]);
  const restored = await CatalogCache.open(f.directory, "participant");
  expect(restored.project({ ...local, workspaces: [...local.workspaces].reverse() }, originalWorkspaceId).files.some(file => file.fileId === personal.fileId)).toBe(true);
});
