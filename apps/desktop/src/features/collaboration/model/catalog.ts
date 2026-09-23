import type { MemberRole } from "./protocol";

declare const localFileIdBrand: unique symbol;
declare const sharedDocumentIdBrand: unique symbol;
declare const catalogNodeIdBrand: unique symbol;

/** Device-local storage identity. Never send this as a server catalog identity. */
export type LocalFileId = string & { readonly [localFileIdBrand]: true };
/** Durable Object/R2 document identity. */
export type SharedDocumentId = string & {
  readonly [sharedDocumentIdBrand]: true;
};
/** Server catalog identity for a workspace, folder, or document entry. */
export type CatalogNodeId = string & { readonly [catalogNodeIdBrand]: true };

export type SharedTargetKind = "workspace" | "folder" | "document";
export type CatalogNodeState = "initializing" | "active" | "stopped" | "deleted";

export interface SharedTargetRef {
  kind: SharedTargetKind;
  catalogNodeId: CatalogNodeId;
  sharedDocumentId?: SharedDocumentId;
}

export interface SharedCapabilities {
  read: boolean;
  editDocument: boolean;
  createChildren: boolean;
  rename: boolean;
  move: boolean;
  deleteDescendants: boolean;
  invite: boolean;
  manageEditorViewer: boolean;
  appointAdmin: boolean;
  stopRootShare: boolean;
  deleteRootShare: boolean;
  restoreDocument: boolean;
  startHierarchyShare: boolean;
}

export interface CatalogNode {
  id: CatalogNodeId;
  kind: SharedTargetKind;
  parentId: CatalogNodeId | null;
  /** Direct sharing boundary, independent of its visible parent. */
  isShareRoot: boolean;
  ownerId: string;
  createdBy: string;
  name: string;
  sharedDocumentId: SharedDocumentId | null;
  state: CatalogNodeState;
  role: MemberRole;
  capabilities: SharedCapabilities;
  titleVersion: number;
  revision: number;
}

export interface CatalogTombstone {
  id: CatalogNodeId;
  deleted: true;
  revision: number;
}

export interface CatalogDelta {
  revision: number;
  nodes: CatalogNode[];
  tombstones: CatalogTombstone[];
}

export type HierarchyShareOperationState =
  | "staging"
  | "ready"
  | "complete"
  | "failed";

export interface HierarchyShareOperation {
  operationId: string;
  rootNodeId: CatalogNodeId;
  state: HierarchyShareOperationState;
  stagedCount: number;
  pendingDocumentIds: SharedDocumentId[];
}

export interface ServerCollaborationCapabilities {
  hierarchySharingEnabled: boolean;
  canStartDocumentShare: boolean;
  documentShareSource: "none" | "trial" | "entitlement";
  canStartHierarchyShare: boolean;
  hierarchyShareSource: "none" | "trial" | "entitlement";
}
