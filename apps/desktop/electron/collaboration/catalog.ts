import { normalizeWorkspaceLayout } from "@/lib/workspace-tab-groups";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import type { SigmaDocument } from "@/features/document";
import type { CatalogDelta, CatalogNode, CatalogNodeId, HierarchyShareOperation, ServerCollaborationCapabilities, SharedTargetRef } from "@/features/collaboration/model/catalog";
import type { MemberRole } from "@/features/collaboration/model/protocol";
import type { CatalogSharingDetails, LibrarySharingTarget, LocalSharingTarget, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import { SHARED_ITEMS_WORKSPACE_ID } from "@/lib/runtime/shared-catalog";
import { createBlankDocument } from "@/lib/blank-document";
import type { WorkspaceOverview } from "@/lib/runtime/types";
import type { LibraryAuthority, LocalSigmaDocStore, LocalWorkspaceOverviewResult } from "../local-sigma-doc-store";
import { CatalogCache, localTargetKey, type PendingHierarchyShare, type ShareSourceItem, type PendingCatalogCreate } from "./catalog-cache";

export interface CatalogSessionsPort {
  actorId(): string | null;
  request<T>(route: string, body?: unknown): Promise<T>;
  bindings(): { fileId: string; sharedDocumentId: string; actorId: string; docId?: string }[];
  has(fileId: string): boolean;
  open(fileId: string, sharedDocumentId: string): Promise<SigmaDocument>;
  previewVersion?(fileId: string): string | undefined;
  preview?(fileId: string, sharedDocumentId: string): Promise<SigmaDocument>;
  initialize(fileId: string, sharedDocumentId: string, operationId: string, document: SigmaDocument, staged?: boolean): Promise<void>;
  activate(fileIds: string[]): Promise<void>;
  start(fileId: string, document: SigmaDocument): Promise<unknown>;
  flush(fileId: string): Promise<void>;
  retainLocal(fileId: string): Promise<void>;
  recoverLocked(): Promise<{ saved: number; failed: number }>;
  restrict(allowed: Map<string, MemberRole>): void;
}
/** Metadata authority. Document journals/assets are owned by CollaborationSessions. */
export class DesktopSharedCatalog {
  private cache?: CatalogCache;
  private generation = 0;
  private actor: string | null = null;
  private refreshTail: Promise<unknown> = Promise.resolve();
  private refreshPending?: Promise<SharedCatalogStatus>;
  private operationTail: Promise<unknown> = Promise.resolve();
  private visible = false;
  private visibilityGeneration = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastEmitted = "";
  private publish(): void {
    const value = JSON.stringify(this.current);
    if (value === this.lastEmitted) return;
    this.lastEmitted = value;
    this.emit({ ...this.current });
  }
  private current: SharedCatalogStatus = { state: "signed-out", actorId: null, revision: 0 };
  constructor(private readonly directory: string, private readonly local: LocalSigmaDocStore, private readonly sessions: CatalogSessionsPort, private readonly emit: (status: SharedCatalogStatus) => void) {}
  private async account(): Promise<void> {
    const actor = this.sessions.actorId();
    if (actor === this.actor && (this.cache || !actor)) return;
    this.actor = actor;
    this.refreshPending = undefined;
    const generation = ++this.generation;
    this.cache = undefined;
    this.current = { state: actor ? "loading" : "signed-out", actorId: actor, revision: 0 };
    this.publish();
    if (actor) {
      const cache = await CatalogCache.open(this.directory, actor);
      if (generation !== this.generation || actor !== this.sessions.actorId()) return;
      this.cache = cache;
      this.current = { ...this.current, revision: cache.data.revision };
    }
  }
  async billing(action: "checkout" | "portal"): Promise<void> {
    const result = await this.sessions.request<{ url: string }>(`/billing/${action}`, {});
    const url = new URL(result.url);
    if (url.protocol !== "https:" || !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname) || url.username || url.password) throw new Error("INVALID_BILLING_URL");
    await shell.openExternal(url.href);
  }
  async lockedDocumentCount(): Promise<number> {
    const actor = this.sessions.actorId();
    if (!actor) return 0;
    const documents = await this.sessions.request<{ id: string }[]>("/billing/locked");
    if (actor !== this.sessions.actorId()) throw new Error("ACCOUNT_CHANGED");
    return documents.length;
  }
  async recoverLocked(): Promise<{ saved: number; failed: number }> {
    const result = await this.sessions.recoverLocked();
    await this.refresh();
    return result;
  }
  async status(): Promise<SharedCatalogStatus> { await this.account(); return { ...this.current }; }
  async setVisible(visible: boolean): Promise<void> {
    const generation = ++this.visibilityGeneration;
    this.visible = visible;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (visible) {
      await this.refresh();
      if (!this.visible || generation !== this.visibilityGeneration) return;
      this.timer = setInterval(() => { if (this.visible) void this.refresh(); }, 5000);
      this.timer.unref();
    }
  }
  async refresh(): Promise<SharedCatalogStatus> {
    await this.account();
    if (!this.cache) return this.status();
    if (this.refreshPending) return this.refreshPending;
    const run = this.refreshTail.then(() => this.refreshNow());
    this.refreshTail = run.catch(() => {});
    this.refreshPending = run;
    try { return await run; } finally { if (this.refreshPending === run) this.refreshPending = undefined; }
  }
  private async refreshNow(): Promise<SharedCatalogStatus> {
    await this.account();
    const cache = this.cache;
    if (!cache) return this.status();
    const generation = this.generation;
    try {
      const capabilities = await this.sessions.request<ServerCollaborationCapabilities>("/catalog/capabilities");
      const known = Object.keys(cache.data.nodes);
      const deltas: CatalogDelta[] = [];
      // All batches share the old cursor; publish only when the complete set arrived.
      for (let i = 0; i < Math.max(known.length, 1); i += 5000) {
        deltas.push(await this.sessions.request<CatalogDelta>("/catalog/delta", { since: cache.data.revision, knownIds: known.slice(i, i + 5000) }));
      }
      if (generation !== this.generation || cache.data.actorId !== this.sessions.actorId()) { await this.account(); return this.status(); }
      for (const delta of deltas) cache.apply(delta);
      const localOverview = await this.local.getLocalLibrarySnapshot();
      const localFiles = localOverview.files;
      for (const binding of this.sessions.bindings()) {
        if (binding.actorId !== cache.data.actorId) continue;
        const node = Object.values(cache.data.nodes).find(n => n.sharedDocumentId === binding.sharedDocumentId);
        if (!node) continue;
        const prior = cache.data.mappings[node.id];
        const localFile = localFiles.find(f => f.fileId === binding.fileId);
        cache.data.mappings[node.id] = { ...prior, nodeId: node.id, local: { kind: "document", fileId: binding.fileId }, bodyCached: true, docId: binding.docId, ...(node.ownerId === cache.data.actorId && localFile && !prior?.workspaceId ? { workspaceId: localFile.workspaceId, folderId: localFile.folderId } : {}) };
      }
      cache.ensureOwnerLocations(localOverview);
      await cache.save();
      if (generation !== this.generation || cache.data.actorId !== this.sessions.actorId()) { await this.account(); return this.status(); }
      const allowed = new Map(Object.values(cache.data.nodes).filter(n => n.sharedDocumentId && (n.state === "active" || n.state === "initializing")).map(n => [n.sharedDocumentId!, n.role]));
      for (const op of Object.values(cache.data.operations)) if (!op.complete) for (const item of op.items) if (item.sharedDocumentId) allowed.set(item.sharedDocumentId as import("@/features/collaboration/model/catalog").SharedDocumentId, "owner");
      for (const intent of Object.values(cache.data.creates)) if (!intent.complete && intent.sharedDocumentId) allowed.set(intent.sharedDocumentId as import("@/features/collaboration/model/catalog").SharedDocumentId, "editor");
      this.sessions.restrict(allowed);
      this.current = { state: "ready", actorId: cache.data.actorId, revision: cache.data.revision, capabilities };
    } catch (error) {
      if (generation !== this.generation || cache.data.actorId !== this.sessions.actorId()) { await this.account(); return this.status(); }
      this.current = { ...this.current, state: "offline", error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
    return { ...this.current };
  }
  private async online(): Promise<CatalogCache> {
    await this.refresh();
    if (!this.cache || !this.actor) throw new Error("AUTH_REQUIRED");
    if (this.current.state !== "ready") throw new Error("CATALOG_OFFLINE");
    return this.cache;
  }
  private checkAccount(cache: CatalogCache): void {
    if (cache !== this.cache || cache.data.actorId !== this.sessions.actorId()) throw new Error("ACCOUNT_CHANGED");
  }
  private async mutate<T>(run: (cache: CatalogCache) => Promise<T>): Promise<T> {
    const actor = this.sessions.actorId();
    const next = this.operationTail.then(async () => {
      if (actor !== this.sessions.actorId()) throw new Error("ACCOUNT_CHANGED");
      const cache = await this.online();
      const result = await run(cache);
      this.checkAccount(cache);
      await this.refresh();
      return result;
    });
    this.operationTail = next.catch(() => {});
    return next;
  }
  private find(id: string, kind?: CatalogNode["kind"]): CatalogNode | undefined {
    return this.cache && Object.values(this.cache.data.nodes).find(n => (!kind || n.kind === kind) && this.cache!.navigationId(n) === id);
  }
  private requireTarget(target: SharedTargetRef, cache = this.cache): CatalogNode {
    const node = cache?.data.nodes[target.catalogNodeId];
    if (!node || node.kind !== target.kind || node.state !== "active" || (target.sharedDocumentId && target.sharedDocumentId !== node.sharedDocumentId)) throw new Error("TARGET_UNAVAILABLE");
    return node;
  }
  private async rawOverview(workspaceId?: string | null): Promise<WorkspaceOverview> {
    const overview = await this.local.getLocalLibrarySnapshot();
    return { ...overview, activeWorkspaceId: workspaceId && overview.workspaces.some(w => w.id === workspaceId) ? workspaceId : overview.activeWorkspaceId };
  }

  async overview(workspaceId?: string | null): Promise<LocalWorkspaceOverviewResult> {
    await this.account();
    if (workspaceId && (await this.local.getLocalLibrarySnapshot()).workspaces.some(w => w.id === workspaceId)) {
      const selected = await this.local.withLocalLibrary(() => this.local.getWorkspaceOverview(workspaceId));
      if (selected.state !== "ready") return selected;
    }
    const local = await this.rawOverview(workspaceId);
    const hidden = new Set(this.sessions.bindings().map(b => b.fileId));
    const overview = this.cache ? this.cache.project(local, workspaceId, hidden) : { ...local, files: local.files.filter(f => !hidden.has(f.fileId)), folders: local.folders.filter(f => f.workspaceId === local.activeWorkspaceId) };
    return { state: "ready", overview: { ...overview, catalog: await this.status() } } as LocalWorkspaceOverviewResult;
  }
  async listFiles() {
    await this.account();
    const local = await this.rawOverview();
    const hidden = new Set(this.sessions.bindings().map(b => b.fileId));
    if (!this.cache) return local.files.filter(f => !hidden.has(f.fileId));
    const projected = this.cache.project(local, undefined, hidden);
    const results = [...projected.files];
    for (const workspace of projected.workspaces) {
      if (workspace.id !== projected.activeWorkspaceId) results.push(...this.cache.project(local, workspace.id, hidden).files);
    }
    return results;
  }
  async previewContext(fileId: string): Promise<{ scope: string; token: string; opened: boolean } | null> {
    await this.account();
    const node = this.find(fileId, "document");
    if (!node || node.state !== "active" || !node.capabilities.read || !node.sharedDocumentId) return null;
    const scope = createHash("sha256").update(JSON.stringify([this.actor, node.id, node.sharedDocumentId])).digest("hex");
    const version = this.sessions.previewVersion?.(fileId) ?? "unopened";
    return { scope, token: `${scope}:${version}`, opened: this.cache!.data.mappings[node.id]?.bodyCached ?? false };
  }
  async preview(fileId: string): Promise<SigmaDocument | null> {
    await this.account();
    const node = this.find(fileId, "document");
    if (!node || node.state !== "active" || !node.sharedDocumentId || !this.sessions.preview) return null;
    const cache = this.cache!;
    const document = await this.sessions.preview(fileId, node.sharedDocumentId);
    this.checkAccount(cache);
    const current = this.find(fileId, "document");
    if (current?.state !== "active" || current.id !== node.id || current.sharedDocumentId !== node.sharedDocumentId) return null;
    return document;
  }
  async read(fileId: string): Promise<SigmaDocument | undefined> {
    await this.account();
    const node = this.find(fileId, "document");
    const pending = Object.values(this.cache?.data.operations ?? {}).filter(op => !op.complete).flatMap(op => op.items).find(item => item.local.kind === "document" && item.local.fileId === fileId);
    if (!node && pending?.sharedDocumentId && this.sessions.has(fileId)) return this.sessions.open(fileId, pending.sharedDocumentId);
    if (!node) {
      if (this.sessions.has(fileId) || fileId.startsWith("catalog_")) throw new Error("TARGET_UNAVAILABLE");
      return undefined;
    }
    const cache = this.cache!;
    const document = await this.sessions.open(fileId, node.sharedDocumentId!);
    this.checkAccount(cache);
    Object.assign(cache.data.mappings[node.id], { bodyCached: true, docId: document.docId });
    await cache.save();
    return document;
  }
  async details(target: LibrarySharingTarget): Promise<CatalogSharingDetails | null> {
    await this.online();
    const node = target.source === "shared" ? this.requireTarget(target.shared) : this.cache!.nodeForLocal(target.local);
    if (!node) { await this.validateLocal(target.source === "local" ? target.local : (() => { throw new Error("TARGET_UNAVAILABLE"); })()); return null; }
    const cache = this.cache!;
    const members = await this.sessions.request<import("@/lib/runtime/shared-catalog").CatalogMember[]>(`/catalog/nodes/${node.id}/members`);
    this.checkAccount(cache);
    return { target: cache.metadata(node).target, name: node.name, sharing: cache.metadata(node), members };
  }
  private async validateLocal(target: LocalSharingTarget): Promise<{ name: string; overview: WorkspaceOverview }> {
    if (target.kind === "document" && this.sessions.bindings().some(b => b.fileId === target.fileId)) throw new Error("TARGET_UNAVAILABLE");
    const overview = await this.rawOverview(target.kind === "document" ? undefined : target.workspaceId);
    if (target.kind === "workspace") {
      const workspace = overview.workspaces.find(w => w.id === target.workspaceId);
      if (!workspace) throw new Error("TARGET_UNAVAILABLE");
      return { name: workspace.name, overview };
    }
    if (target.kind === "folder") {
      const folder = overview.folders.find(f => f.id === target.folderId && f.workspaceId === target.workspaceId);
      if (!folder) throw new Error("TARGET_UNAVAILABLE");
      return { name: folder.name, overview };
    }
    const file = overview.files.find(f => f.fileId === target.fileId);
    if (!file) throw new Error("TARGET_UNAVAILABLE");
    return { name: file.title, overview };
  }
  async join(token: string) {
    return this.mutate(async cache => {
      const { catalogNodeId } = await this.sessions.request<{ catalogNodeId: CatalogNodeId }>("/catalog/invitations/accept", { token });
      this.checkAccount(cache);
      await this.refresh();
      const node = cache.data.nodes[catalogNodeId];
      if (!node) throw new Error("TARGET_UNAVAILABLE");
      const location = node.kind === "workspace" ? { workspaceId: cache.navigationId(node), folderId: null } : cache.location(node);
      return { target: cache.metadata(node).target, workspaceId: location.workspaceId, ...(node.kind === "folder" ? { folderId: cache.navigationId(node) } : {}), ...(node.kind === "document" ? { fileId: cache.navigationId(node) } : {}) };
    });
  }
  async invite(target: SharedTargetRef, role: Exclude<MemberRole, "owner">): Promise<{ token: string; tokenHash: string }> {
    return this.mutate(async cache => { this.requireTarget(target, cache); if (Object.values(cache.data.operations).some(op => !op.complete && (op.rootNodeId === target.catalogNodeId || op.items.some(item => item.nodeId === target.catalogNodeId)))) throw new Error("HIERARCHY_SHARE_IN_PROGRESS"); return this.sessions.request(`/catalog/nodes/${target.catalogNodeId}/invitations`, { role }); });
  }
  async changeMember(target: SharedTargetRef, userId: string, role: Exclude<MemberRole, "owner"> | null): Promise<void> {
    await this.mutate(async cache => { this.requireTarget(target, cache); await this.sessions.request(`/catalog/nodes/${target.catalogNodeId}/members`, { userId, role }); });
  }
  async revokeInvitation(target: SharedTargetRef, tokenHash: string): Promise<void> {
    await this.mutate(async cache => { this.requireTarget(target, cache); await this.sessions.request("/catalog/invitations/revoke", { tokenHash }); });
  }
  async end(target: SharedTargetRef, action: "stop" | "delete" | "leave"): Promise<void> {
    await this.mutate(async cache => {
      const node = this.requireTarget(target, cache);
      await this.sessions.request(`/catalog/nodes/${target.catalogNodeId}/${action === "leave" ? "leave" : "stop"}`, { delete: action === "delete" });
      this.checkAccount(cache);
      const mapping = cache.data.mappings[node.id];
      if (action === "stop" && node.ownerId === cache.data.actorId && node.kind === "document" && mapping?.local.kind === "document" && mapping.workspaceId) {
        await this.sessions.retainLocal(mapping.local.fileId);
        delete cache.data.mappings[node.id];
        await cache.save();
      }
    });
  }
  close(): void { ++this.visibilityGeneration; this.visible = false; if (this.timer) clearInterval(this.timer); ++this.generation; }
  async start(source: LocalSharingTarget): Promise<CatalogSharingDetails> {
    const target = await this.mutate(async cache => {
      const existing = cache.nodeForLocal(source);
      const pendingShare = cache.data.operations[localTargetKey(source)];
      if (existing?.state === "active" && (!pendingShare || pendingShare.complete)) return cache.metadata(existing).target;
      const { name, overview } = await this.validateLocal(source);
      if (source.kind === "document") {
        const document = await this.local.loadDocument(source.fileId);
        if (!document) throw new Error("TARGET_UNAVAILABLE");
        await this.sessions.start(source.fileId, document);
        await this.sessions.flush(source.fileId);
        await this.refresh();
        const node = cache.nodeForLocal(source);
        if (!node) throw new Error("TARGET_UNAVAILABLE");
        const file = overview.files.find(f => f.fileId === source.fileId)!;
        Object.assign(cache.data.mappings[node.id], { workspaceId: file.workspaceId, folderId: file.folderId });
        await cache.save();
        return cache.metadata(node).target;
      }
      const key = localTargetKey(source);
      let operation = cache.data.operations[key];
      if (!operation || operation.complete) {
        const selected = new Set<string>();
        if (source.kind === "folder") selected.add(source.folderId);
        const folders = overview.folders.filter(f => f.workspaceId === source.workspaceId);
        if (source.kind === "workspace") for (const folder of folders) selected.add(folder.id);
        else {
          let changed = true;
          while (changed) { changed = false; for (const folder of folders) if (folder.parentFolderId && selected.has(folder.parentFolderId) && !selected.has(folder.id)) { selected.add(folder.id); changed = true; } }
        }
        const items: ShareSourceItem[] = [];
        const pending = folders.filter(f => selected.has(f.id) && !(source.kind === "folder" && f.id === source.folderId));
        while (pending.length) {
          const index = pending.findIndex(f => !f.parentFolderId || !pending.some(p => p.id === f.parentFolderId));
          if (index < 0) throw new Error("LOCAL_HIERARCHY_CYCLE");
          const [folder] = pending.splice(index, 1);
          items.push({ key: folder.id, parentKey: folder.parentFolderId && !(source.kind === "folder" && folder.parentFolderId === source.folderId) ? folder.parentFolderId : null, kind: "folder", name: folder.name, local: { kind: "folder", workspaceId: folder.workspaceId, folderId: folder.id } });
        }
        for (const file of overview.files.filter(f => f.workspaceId === source.workspaceId && (source.kind === "workspace" || (f.folderId && selected.has(f.folderId))))) {
          items.push({ key: file.fileId, parentKey: file.folderId && !(source.kind === "folder" && file.folderId === source.folderId) ? file.folderId : null, kind: "document", name: file.title, local: { kind: "document", fileId: file.fileId } });
        }
        operation = { operationId: randomUUID(), source, name, items, complete: false };
        cache.data.operations[key] = operation;
        await cache.save();
      }
      await this.resumeShare(cache, operation, overview);
      await this.refresh();
      const node = cache.data.nodes[operation.rootNodeId!];
      if (!node) throw new Error("TARGET_UNAVAILABLE");
      return cache.metadata(node).target;
    });
    return (await this.details({ source: "shared", shared: target }))!;
  }
  private async resumeShare(cache: CatalogCache, operation: PendingHierarchyShare, overview: WorkspaceOverview): Promise<void> {
    this.checkAccount(cache);
    const begin = await this.sessions.request<HierarchyShareOperation>("/catalog/share/begin", { operationId: operation.operationId, kind: operation.source.kind, name: operation.name });
    this.checkAccount(cache);
    operation.rootNodeId = begin.rootNodeId;
    const source = operation.source;
    const sourceFolder = source.kind === "folder" ? overview.folders.find(folder => folder.id === source.folderId) : undefined;
    cache.data.mappings[begin.rootNodeId] = { nodeId: begin.rootNodeId, local: operation.source, workspaceId: operation.source.kind === "document" ? undefined : operation.source.workspaceId, folderId: sourceFolder?.parentFolderId, bodyCached: false };
    await cache.save();
    if (begin.state !== "complete") {
      for (const item of operation.items) {
        this.checkAccount(cache);
        const existing = cache.nodeForLocal(item.local);
        const binding = item.local.kind === "document" ? this.sessions.bindings().find(b => b.fileId === (item.local as { fileId: string }).fileId && b.actorId === cache.data.actorId) : undefined;
        const staged = await this.sessions.request<{ nodeId: CatalogNodeId; sharedDocumentId: string | null; existing: boolean }>("/catalog/share/stage", {
          operationId: operation.operationId, itemKey: item.key, parentItemKey: item.parentKey, kind: item.kind, name: item.name,
          ...(binding ? { existingSharedDocumentId: binding.sharedDocumentId } : existing ? { existingCatalogNodeId: existing.id } : {}),
        });
        this.checkAccount(cache);
        item.nodeId = staged.nodeId;
        if (staged.sharedDocumentId) item.sharedDocumentId = staged.sharedDocumentId;
        const file = item.local.kind === "document" ? overview.files.find(f => f.fileId === (item.local as { fileId: string }).fileId) : undefined;
        cache.data.mappings[staged.nodeId] = { nodeId: staged.nodeId, local: item.local, workspaceId: file?.workspaceId ?? (item.local.kind === "folder" ? item.local.workspaceId : undefined), folderId: file?.folderId, bodyCached: Boolean(binding), docId: file?.docId };
        await cache.save();
        if (item.local.kind === "document" && staged.sharedDocumentId) {
          const fileId = item.local.fileId;
          if (!this.sessions.has(fileId)) {
            // The same file serialization used by local saves captures the last durable edit.
            // No network request runs under the library-wide ledger lock.
            await this.local.runExclusive(fileId, async () => {
              const document = await this.local.loadDocument(fileId);
              if (!document) throw new Error("SOURCE_DOCUMENT_MISSING");
              await this.sessions.initialize(fileId, staged.sharedDocumentId!, operation.operationId, document, true);
            });
          }
          await this.sessions.flush(fileId);
          this.checkAccount(cache);
          cache.data.mappings[staged.nodeId].bodyCached = true;
          await cache.save();
        }
      }
      this.checkAccount(cache);
      // Drain every staged journal again after all uploads; the invitation remains inactive.
      for (const item of operation.items) if (item.local.kind === "document") {
        await this.sessions.flush(item.local.fileId);
        this.checkAccount(cache);
      }
      await this.sessions.request("/catalog/share/complete", { operationId: operation.operationId });
    }
    this.checkAccount(cache);
    await this.sessions.activate(operation.items.flatMap(item => item.local.kind === "document" ? [item.local.fileId] : []));
    this.checkAccount(cache);
    operation.complete = true;
    await cache.save();
  }
  async renameDocument(workspaceId: string, fileId: string, name: string): Promise<LocalWorkspaceOverviewResult | undefined> {
    await this.account();
    this.assertHierarchyMutable(fileId);
    if (!this.find(fileId, "document")) { if (this.sessions.has(fileId)) throw new Error("TARGET_UNAVAILABLE"); return undefined; }
    await this.rename(fileId, name);
    return this.overview(workspaceId);
  }
  private async rename(id: string, name: string): Promise<void> {
    await this.mutate(async () => { const node = this.find(id); if (!node) throw new Error("TARGET_UNAVAILABLE"); await this.sessions.request(`/catalog/nodes/${node.id}/rename`, { name }); });
  }
  private async remove(id: string): Promise<void> {
    await this.mutate(async () => { const node = this.find(id); if (!node) throw new Error("TARGET_UNAVAILABLE"); await this.sessions.request(`/catalog/nodes/${node.id}/${node.isShareRoot && node.role === "owner" ? "stop" : "delete"}`, node.isShareRoot && node.role === "owner" ? { delete: true } : {}); });
  }
  private async move(fileId: string, workspaceId: string, folderId?: string | null): Promise<LocalWorkspaceOverviewResult | undefined> {
    await this.account();
    this.assertHierarchyMutable(fileId, folderId ?? workspaceId);
    let source = this.find(fileId);
    const parent = this.find(folderId ?? workspaceId);
    if (!source && !parent) { this.rejectVirtual(workspaceId, folderId, fileId); if (this.sessions.has(fileId)) throw new Error("TARGET_UNAVAILABLE"); return undefined; }
    if (!source && parent) {
      if (parent.ownerId !== this.actor) throw new Error("CROSS_OWNER_MOVE");
      await this.start({ kind: "document", fileId });
      source = this.find(fileId);
    }
    if (!source) throw new Error("TARGET_UNAVAILABLE");
    if (!parent) {
      this.rejectVirtual(workspaceId, folderId);
      const raw = await this.rawOverview();
      if (!raw.workspaces.some(w => w.id === workspaceId) || (folderId && !raw.folders.some(f => f.id === folderId && f.workspaceId === workspaceId))) throw new Error("TARGET_UNAVAILABLE");
      if (source.ownerId !== this.actor) throw new Error("OWNER_REQUIRED");
    }
    const nodeId = source.id;
    await this.mutate(async cache => {
      const move = { nodeId, parentId: parent?.id ?? null, workspaceId, folderId: folderId ?? null };
      cache.data.moves[nodeId] = move;
      await cache.save();
      await this.resumeMove(cache, move);
    });
    return this.overview(workspaceId);
  }
  private async resumeMove(cache: CatalogCache, move: import("./catalog-cache").PendingCatalogMove): Promise<void> {
    this.checkAccount(cache);
    await this.sessions.request(`/catalog/nodes/${move.nodeId}/move`, { parentId: move.parentId });
    this.checkAccount(cache);
    const mapping = cache.data.mappings[move.nodeId];
    if (mapping) { mapping.workspaceId = move.workspaceId; mapping.folderId = move.folderId; }
    delete cache.data.moves[move.nodeId];
    await cache.save();
  }
  authority(): Partial<LibraryAuthority> {
    return {
      initializeWorkspace: async payload => {
        await this.account();
        const raw = await this.local.withLocalLibrary(() => this.local.initializeWorkspace(payload));
        const visible = new Set((await this.listFiles()).map(file => file.fileId));
        if (!visible.size) {
          return this.local.withLocalLibrary(async () => {
            const created = await this.local.createWorkspace(createCurrentLocaleTranslator("workspace")("defaultWorkspaceName"));
            if (created.state !== "ready") throw new Error("LOCAL_LIBRARY_UNAVAILABLE");
            const blank = await this.local.createDocument({ workspaceId: created.overview.activeWorkspaceId });
            return { openFileIds: [blank.file.fileId], activeFileId: blank.file.fileId };
          });
        }
        const saved = this.cache?.data.workspaceState ?? raw;
        const openFileIds = saved.openFileIds.filter(id => visible.has(id));
        const activeFileId = visible.has(saved.activeFileId) ? saved.activeFileId : openFileIds[0] ?? [...visible][0];
        const normalizedOpenFileIds = openFileIds.length ? openFileIds : [activeFileId];
        return { openFileIds: normalizedOpenFileIds, activeFileId, ...(saved.layout ? { layout: normalizeWorkspaceLayout(saved.layout, normalizedOpenFileIds, activeFileId, visible) } : {}) };
      },
      saveWorkspace: async state => {
        await this.account();
        if (!this.cache) return undefined;
        const visible = new Set((await this.listFiles()).map(file => file.fileId));
        if (!visible.has(state.activeFileId) || state.openFileIds.some(id => !visible.has(id))) return { ok: false, error: "TARGET_UNAVAILABLE" };
        this.cache.data.workspaceState = {
          openFileIds: [...state.openFileIds], activeFileId: state.activeFileId,
          ...(state.layout ? { layout: normalizeWorkspaceLayout(state.layout, state.openFileIds, state.activeFileId, visible) } : {}),
        };
        await this.cache.save();
        return { ok: true };
      },
      listFiles: () => this.listFiles(),
      getWorkspaceOverview: id => this.overview(id),
      renameWorkspace: async (id, name) => { await this.account(); this.assertHierarchyMutable(id); if (!this.find(id)) return undefined; await this.rename(id, name); return this.overview(id); },
      deleteWorkspace: async id => { await this.account(); this.assertHierarchyMutable(id); if (!this.find(id)) return undefined; await this.remove(id); return this.overview(); },
      deleteFile: async id => { await this.account(); this.assertHierarchyMutable(id); if (!this.find(id)) { if (this.sessions.has(id)) throw new Error("TARGET_UNAVAILABLE"); return undefined; } await this.remove(id); return { ok: true }; },
      deleteFolder: async (workspaceId, id) => {
        await this.account(); this.assertHierarchyMutable(id);
        if (this.find(id)) { await this.remove(id); return this.overview(workspaceId); }
        // A local folder may contain independently shared roots. Delete those
        // through the authority before removing local ledger rows.
        const local = await this.rawOverview(workspaceId);
        const projected = this.cache?.project(local, workspaceId);
        const folders = projected?.folders ?? local.folders;
        const removed = new Set([id]);
        for (;;) {
          const before = removed.size;
          for (const folder of folders) if (folder.workspaceId === workspaceId && folder.parentFolderId && removed.has(folder.parentFolderId)) removed.add(folder.id);
          if (before === removed.size) break;
        }
        const nodes = Object.values(this.cache?.data.nodes ?? {}).filter(node => {
          const location = this.cache!.location(node, local);
          return node.state === "active" && location.workspaceId === workspaceId && location.folderId && removed.has(location.folderId);
        });
        const nodeIds = new Set(nodes.map(node => node.id));
        const roots = nodes.filter(node => !node.parentId || !nodeIds.has(node.parentId));
        for (const node of roots) {
          this.assertHierarchyMutable(this.cache!.navigationId(node));
          if (!(node.isShareRoot ? node.capabilities.deleteRootShare : node.capabilities.deleteDescendants)) throw new Error("FORBIDDEN");
        }
        for (const node of roots) await this.remove(this.cache!.navigationId(node));
        return undefined;
      },
      createFolder: async (workspaceId, name, parentId) => {
        await this.account(); this.assertHierarchyMutable(parentId ?? workspaceId); const parent = this.find(parentId ?? workspaceId); if (!parent) { this.rejectVirtual(workspaceId, parentId); return undefined; }
        await this.mutate(async cache => { await this.createNode(cache, parent, "folder", name); });
        return this.overview(workspaceId);
      },
      updateFolder: async (workspaceId, id, patch) => {
        await this.account(); this.assertHierarchyMutable(id); if (!this.find(id)) { this.rejectVirtual(workspaceId, id); return undefined; }
        if (patch.parentFolderId !== undefined) await this.move(id, workspaceId, patch.parentFolderId);
        if (patch.name !== undefined) await this.rename(id, patch.name);
        return this.overview(workspaceId);
      },
      moveFileToFolder: (workspaceId, fileId, folderId) => this.move(fileId, workspaceId, folderId),
      moveFileToWorkspace: (fileId, workspaceId, folderId) => this.move(fileId, workspaceId, folderId),
      createFileFromDocument: async input => {
        await this.account(); this.assertHierarchyMutable(input.folderId ?? input.workspaceId ?? ""); const parent = this.find(input.folderId ?? input.workspaceId ?? "");
        if (!parent) { this.rejectVirtual(input.workspaceId, input.folderId); return undefined; }
        return this.mutate(async cache => {
          const intent = await this.createNode(cache, parent, "document", input.document.metadata.title, input.document);
          await this.refresh();
          const file = (await this.listFiles()).find(f => f.fileId === intent.fileId);
          if (!file) throw new Error("TARGET_UNAVAILABLE");
          return { file, document: (await this.read(intent.fileId!))! };
        });
      },
      duplicateFile: async fileId => {
        await this.account(); const node = this.find(fileId, "document"); if (!node) return undefined;
        const source = await this.read(fileId); if (!source) throw new Error("TARGET_UNAVAILABLE");
        const location = this.cache!.location(node);
        return this.local.createFileFromDocument({ ...location, document: { ...source, docId: createBlankDocument().docId, metadata: { ...source.metadata, title: createCurrentLocaleTranslator("workspace")("duplicatedTitle", { title: node.name }) } } });
      },
    };
  }
  private assertHierarchyMutable(...ids: string[]): void {
    for (const op of Object.values(this.cache?.data.operations ?? {})) {
      if (op.complete) continue;
      const protectedIds = [op.source.kind === "workspace" ? op.source.workspaceId : op.source.kind === "folder" ? op.source.folderId : op.source.fileId, ...op.items.map(item => item.key)];
      if (ids.some(id => protectedIds.includes(id))) throw new Error("HIERARCHY_SHARE_IN_PROGRESS");
    }
  }
  private async createNode(cache: CatalogCache, parent: CatalogNode, kind: "folder" | "document", name: string, document?: SigmaDocument): Promise<PendingCatalogCreate> {
    // mutate() refreshed authority after the caller captured its parent.
    const currentParent = cache.data.nodes[parent.id];
    if (!currentParent || currentParent.state !== "active") throw new Error("TARGET_UNAVAILABLE");
    if (!currentParent.capabilities.createChildren) throw new Error("FORBIDDEN");
    let intent = Object.values(cache.data.creates).find(item => !item.complete && item.parentId === parent.id && item.kind === kind && item.name === name && (kind !== "document" || item.document?.docId === document?.docId));
    if (!intent) {
      intent = { operationId: randomUUID(), parentId: parent.id, kind, name, complete: false, ...(document ? { document: structuredClone(document), fileId: `file_${randomUUID()}` } : {}) };
      cache.data.creates[intent.operationId] = intent;
      await cache.save();
    }
    await this.resumeCreate(cache, intent);
    return intent;
  }
  private async resumeCreate(cache: CatalogCache, intent: PendingCatalogCreate): Promise<void> {
    this.checkAccount(cache);
    const created = await this.sessions.request<{ nodeId: CatalogNodeId; sharedDocumentId: string | null }>("/catalog/nodes", { operationId: intent.operationId, parentId: intent.parentId, kind: intent.kind, name: intent.name });
    this.checkAccount(cache);
    intent.nodeId = created.nodeId;
    intent.sharedDocumentId = created.sharedDocumentId ?? undefined;
    if (intent.document && intent.fileId) {
      cache.data.mappings[created.nodeId] = { nodeId: created.nodeId, local: { kind: "document", fileId: intent.fileId }, bodyCached: false, docId: intent.document.docId };
    }
    await cache.save();
    if (intent.document && intent.fileId && created.sharedDocumentId) {
      this.checkAccount(cache);
      await this.sessions.initialize(intent.fileId, created.sharedDocumentId, intent.operationId, intent.document);
      this.checkAccount(cache);
      await this.sessions.flush(intent.fileId);
      this.checkAccount(cache);
      cache.data.mappings[created.nodeId].bodyCached = true;
    }
    intent.complete = true;
    // Preserve operation receipt, discard duplicate body only after durable initialization/ACK.
    delete intent.document;
    await cache.save();
  }
  async recoverPending(): Promise<void> {
    await this.mutate(async cache => {
      for (const intent of Object.values(cache.data.creates)) if (!intent.complete) await this.resumeCreate(cache, intent);
      for (const move of Object.values(cache.data.moves)) await this.resumeMove(cache, move);
      const overview = await this.rawOverview();
      for (const operation of Object.values(cache.data.operations)) if (!operation.complete) await this.resumeShare(cache, operation, overview);
    });
  }
  private rejectVirtual(...ids: (string | null | undefined)[]): void {
    if (ids.some(id => id === SHARED_ITEMS_WORKSPACE_ID || id?.startsWith("catalog_"))) throw new Error("TARGET_UNAVAILABLE");
  }
}
