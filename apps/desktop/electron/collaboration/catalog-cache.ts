import type { WorkspaceLayoutV2 } from "@/lib/workspace-tab-groups";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CatalogDelta, CatalogNode, CatalogNodeId } from "@/features/collaboration/model/catalog";
import type { LocalSharingTarget, LibrarySharingMetadata } from "@/lib/runtime/shared-catalog";
import { SHARED_ITEMS_WORKSPACE_ID } from "@/lib/runtime/shared-catalog";
import type { SigmaDocument } from "@/features/document";
import type { DocumentMetadata, WorkspaceOverview } from "@/lib/runtime/types";
import { durableWrite } from "./journal";

export interface CatalogMapping {
  nodeId: CatalogNodeId;
  local: LocalSharingTarget;
  /** Owner location retained separately from the server hierarchy. */
  workspaceId?: string;
  folderId?: string | null;
  bodyCached: boolean;
  docId?: string;
}
export interface ShareSourceItem {
  key: string;
  parentKey: string | null;
  kind: "folder" | "document";
  name: string;
  local: LocalSharingTarget;
  nodeId?: CatalogNodeId;
  sharedDocumentId?: string;
}
export interface PendingHierarchyShare {
  operationId: string;
  source: LocalSharingTarget;
  name: string;
  items: ShareSourceItem[];
  rootNodeId?: CatalogNodeId;
  complete: boolean;
}
export interface PendingCatalogCreate {
  operationId: string;
  parentId: CatalogNodeId;
  kind: "folder" | "document";
  name: string;
  fileId?: string;
  document?: SigmaDocument;
  nodeId?: CatalogNodeId;
  sharedDocumentId?: string;
  complete: boolean;
}
export interface PendingCatalogMove {
  nodeId: CatalogNodeId;
  parentId: CatalogNodeId | null;
  workspaceId: string;
  folderId: string | null;
}
interface CatalogData {
  version: 1;
  actorId: string;
  revision: number;
  workspaceState?: { openFileIds: string[]; activeFileId: string; layout?: WorkspaceLayoutV2 };
  nodes: Record<string, CatalogNode>;
  mappings: Record<string, CatalogMapping>;
  operations: Record<string, PendingHierarchyShare>;
  creates: Record<string, PendingCatalogCreate>;
  moves: Record<string, PendingCatalogMove>;
}
export class CatalogCache {
  private tail: Promise<void> = Promise.resolve();
  private constructor(readonly file: string, readonly data: CatalogData) {}
  static async open(directory: string, actorId: string): Promise<CatalogCache> {
    const file = path.join(directory, `catalog-${createHash("sha256").update(actorId).digest("hex")}.json`);
    let data: CatalogData;
    try {
      data = JSON.parse(await fs.readFile(file, "utf8")) as CatalogData;
      data.creates ??= {};
      data.moves ??= {};
      if (data.version !== 1 || data.actorId !== actorId || !data.nodes || !data.mappings || !data.operations)
        throw new Error("INVALID_CATALOG_CACHE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      data = { version: 1, actorId, revision: 0, nodes: {}, mappings: {}, operations: {}, creates: {}, moves: {} };
    }
    return new CatalogCache(file, data);
  }
  save(): Promise<void> {
    const serialized = JSON.stringify(this.data);
    const next = this.tail.then(() => durableWrite(this.file, serialized));
    this.tail = next.catch(() => {});
    return next;
  }
  apply(delta: CatalogDelta): void {
    for (const node of delta.nodes) {
      if (!this.data.nodes[node.id] || this.data.nodes[node.id].revision <= node.revision)
        this.data.nodes[node.id] = node;
      if (node.kind === "document" && !this.data.mappings[node.id]) {
        this.data.mappings[node.id] = {
          nodeId: node.id, local: { kind: "document", fileId: `file_${randomUUID()}` }, bodyCached: false,
        };
      }
    }
    for (const tombstone of delta.tombstones) {
      if ((this.data.nodes[tombstone.id]?.revision ?? -1) <= tombstone.revision) delete this.data.nodes[tombstone.id];
    }
    // Retain mappings and caches after revocation so regrant reuses identity/outbox.
    this.data.revision = Math.max(this.data.revision, delta.revision);
  }
  nodeForLocal(target: LocalSharingTarget): CatalogNode | undefined {
    const mapping = Object.values(this.data.mappings).find(item => this.data.nodes[item.nodeId]?.state === "active" && localTargetKey(item.local) === localTargetKey(target));
    return mapping && this.data.nodes[mapping.nodeId];
  }
  metadata(node: CatalogNode): LibrarySharingMetadata {
    return {
      target: { kind: node.kind, catalogNodeId: node.id, ...(node.sharedDocumentId ? { sharedDocumentId: node.sharedDocumentId } : {}) },
      isShareRoot: node.isShareRoot,
      ownerId: node.ownerId, createdBy: node.createdBy, role: node.role,
      capabilities: node.capabilities, state: Object.values(this.data.operations).some(op => !op.complete && (op.rootNodeId === node.id || op.items.some(item => item.nodeId === node.id))) ? "initializing" : node.state,
      placement: node.ownerId === this.data.actorId ? "owned" : "incoming",
      ...(node.kind === "document" ? { bodyCached: this.data.mappings[node.id]?.bodyCached ?? false } : {}),
    };
  }
  navigationId(node: CatalogNode): string {
    const local = this.data.mappings[node.id]?.local;
    if (node.kind === "document" && local?.kind === "document") return local.fileId;
    if (node.ownerId === this.data.actorId && local) {
      if (local.kind === "workspace") return local.workspaceId;
      if (local.kind === "folder") return local.folderId;
    }
    return `catalog_${node.id}`;
  }
  location(node: CatalogNode, local?: WorkspaceOverview): { workspaceId: string; folderId: string | null } {
    if (node.kind === "workspace") return { workspaceId: this.navigationId(node), folderId: null };
    let parent = node.parentId ? this.data.nodes[node.parentId] : undefined;
    const folderId = parent?.kind === "folder" ? this.navigationId(parent) : null;
    const seen = new Set<string>([node.id]);
    let root = node;
    let current: CatalogNode | undefined = parent;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.kind === "workspace") return { workspaceId: this.navigationId(current), folderId };
      root = current;
      parent = current.parentId ? this.data.nodes[current.parentId] : undefined;
      current = parent;
    }
    // A standalone shared folder stays in its owner's local workspace. New
    // descendants have no local placement; derive it from the current root so
    // a move also overrides any stale placement saved on a descendant.
    const mapping = this.data.mappings[root.id];
    if (root.ownerId === this.data.actorId && mapping?.workspaceId) {
      const target = mapping.local;
      const originalFolder = target.kind === "folder"
        ? local?.folders.find(folder => folder.id === target.folderId && folder.workspaceId === mapping.workspaceId)
        : undefined;
      return {
        workspaceId: mapping.workspaceId,
        folderId: root.id === node.id
          ? mapping.folderId !== undefined ? mapping.folderId : originalFolder?.parentFolderId ?? folderId
          : folderId,
      };
    }
    if (root.ownerId === this.data.actorId && local) {
      const target = mapping?.local;
      const original = target?.kind === "document"
        ? local.files.find(file => file.fileId === target.fileId)
        : undefined;
      const workspace = local.workspaces.find(w => w.id === original?.workspaceId && !w.sharing)
        ?? local.workspaces.find(w => !w.sharing && w.id !== SHARED_ITEMS_WORKSPACE_ID);
      if (workspace) return { workspaceId: workspace.id, folderId: root.id === node.id ? original?.folderId ?? null : folderId };
    }
    return { workspaceId: SHARED_ITEMS_WORKSPACE_ID, folderId };
  }
  ensureOwnerLocations(local: WorkspaceOverview): void {
    const sharedWorkspaceIds = new Set(Object.values(this.data.nodes).filter(node => node.kind === "workspace").map(node => this.navigationId(node)));
    const personal = local.workspaces.filter(w => !sharedWorkspaceIds.has(w.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // The oldest personal workspace is the original library home, even after renaming.
    const fallback = personal[0];
    for (const node of Object.values(this.data.nodes)) {
      if (node.ownerId !== this.data.actorId || node.kind === "workspace" || (node.parentId && this.data.nodes[node.parentId])) continue;
      const mapping = this.data.mappings[node.id];
      if (mapping?.workspaceId && local.workspaces.some(w => w.id === mapping.workspaceId)) continue;
      const target = mapping?.local;
      const original = target?.kind === "document" ? local.files.find(f => f.fileId === target.fileId)
        : target?.kind === "folder" ? local.folders.find(f => f.id === target.folderId) : undefined;
      const workspaceId = original?.workspaceId ?? fallback?.id;
      if (!workspaceId) continue;
      this.data.mappings[node.id] = { ...mapping, nodeId: node.id,
        local: target ?? { kind: "folder", workspaceId, folderId: this.navigationId(node) },
        bodyCached: mapping?.bodyCached ?? false, workspaceId,
        folderId: original && "parentFolderId" in original ? original.parentFolderId : original && "folderId" in original ? original.folderId : null };
    }
  }
  project(local: WorkspaceOverview, requested?: string | null, hiddenFileIds: ReadonlySet<string> = new Set()): WorkspaceOverview {
    const nodes = Object.values(this.data.nodes).filter(node => node.state === "active");
    const pendingIds = new Set(Object.values(this.data.operations).filter(op => !op.complete).flatMap(op => op.items.map(item => item.nodeId)));
    const pendingFiles = new Set(Object.values(this.data.mappings).filter(m => pendingIds.has(m.nodeId)).flatMap(m => m.local.kind === "document" ? [m.local.fileId] : []));
    const mappedFiles = new Set(Object.values(this.data.mappings).filter(m => !pendingIds.has(m.nodeId)).flatMap(m => m.local.kind === "document" ? [m.local.fileId] : []));
    const workspaces = local.workspaces.map(w => ({ ...w }));
    const folders = local.folders.map(f => ({ ...f }));
    const files = local.files.filter(f => !mappedFiles.has(f.fileId) && (!hiddenFileIds.has(f.fileId) || pendingFiles.has(f.fileId)));
    const pendingLocal = new Set(Object.values(this.data.operations).filter(op => !op.complete).flatMap(op => [localTargetKey(op.source), ...op.items.map(item => localTargetKey(item.local))]));
    for (const workspace of workspaces) if (pendingLocal.has(localTargetKey({ kind: "workspace", workspaceId: workspace.id }))) workspace.sharingPending = true;
    for (const folder of folders) if (pendingLocal.has(localTargetKey({ kind: "folder", workspaceId: folder.workspaceId, folderId: folder.id }))) folder.sharingPending = true;
    for (const file of files) if (pendingLocal.has(localTargetKey({ kind: "document", fileId: file.fileId }))) file.sharingPending = true;
    const stamp = new Date(0).toISOString();
    let hasSharedItems = false;
    for (const node of nodes) {
      const id = this.navigationId(node);
      const sharing = this.metadata(node);
      const location = this.location(node, local);
      if (location.workspaceId === SHARED_ITEMS_WORKSPACE_ID) hasSharedItems = true;
      if (node.kind === "workspace") {
        const prior = workspaces.find(w => w.id === id);
        if (prior) Object.assign(prior, { name: node.name, sharing });
        else workspaces.push({ id, name: node.name, createdAt: stamp, updatedAt: stamp, sharing });
      } else if (node.kind === "folder") {
        const prior = folders.find(f => f.id === id);
        const value = { id, ...location, parentFolderId: location.folderId, name: node.name, fileCount: 0, createdAt: stamp, updatedAt: stamp, sharing };
        if (prior) Object.assign(prior, value); else folders.push(value);
      } else {
        const mapping = this.data.mappings[node.id];
        const prior = local.files.find(f => f.fileId === id);
        files.push({ ...prior, fileId: id, ...location, docId: mapping?.docId ?? "", title: node.name, revision: prior?.revision ?? 1, createdAt: prior?.createdAt ?? stamp, updatedAt: prior?.updatedAt ?? stamp, sharing } satisfies DocumentMetadata);
      }
    }
    if (hasSharedItems) workspaces.push({ id: SHARED_ITEMS_WORKSPACE_ID, name: createCurrentLocaleTranslator("workspace")("sharedItems"), createdAt: stamp, updatedAt: stamp });
    const folderCounts = new Map<string, number>();
    for (const file of files) {
      if (!file.folderId) continue;
      const key = JSON.stringify([file.workspaceId, file.folderId]);
      folderCounts.set(key, (folderCounts.get(key) ?? 0) + 1);
    }
    for (const folder of folders) folder.fileCount = folderCounts.get(JSON.stringify([folder.workspaceId, folder.id])) ?? 0;
    const activeWorkspaceId = requested && workspaces.some(w => w.id === requested) ? requested : local.activeWorkspaceId;
    return { activeWorkspaceId, workspaces, folders: folders.filter(f => f.workspaceId === activeWorkspaceId), files: files.filter(f => f.workspaceId === activeWorkspaceId) };
  }
}
export function localTargetKey(target: LocalSharingTarget): string {
  return target.kind === "document" ? `document:${target.fileId}` : target.kind === "folder" ? `folder:${target.workspaceId}:${target.folderId}` : `workspace:${target.workspaceId}`;
}
