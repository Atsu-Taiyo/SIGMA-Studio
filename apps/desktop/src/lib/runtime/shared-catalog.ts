import type { CatalogNodeState, ServerCollaborationCapabilities, SharedCapabilities, SharedTargetRef } from "@/features/collaboration/model/catalog";
import type { MemberRole } from "@/features/collaboration/model/protocol";

/** Exact local selection survives authentication; never interpret a catalog id as a local id. */
export type LocalSharingTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "folder"; workspaceId: string; folderId: string }
  | { kind: "document"; fileId: string };
export type LibrarySharingTarget =
  | { source: "local"; local: LocalSharingTarget }
  | { source: "shared"; shared: SharedTargetRef };

export interface LibrarySharingMetadata {
  target: SharedTargetRef;
  ownerId: string;
  createdBy: string;
  role: MemberRole;
  capabilities: SharedCapabilities;
  state: CatalogNodeState;
  placement: "owned" | "incoming";
  isShareRoot: boolean;
  /** Complete metadata is available independently from the document body. */
  bodyCached?: boolean;
}
export interface SharedCatalogStatus {
  state: "signed-out" | "loading" | "ready" | "offline" | "error";
  actorId: string | null;
  revision: number;
  error?: string;
  capabilities?: ServerCollaborationCapabilities;
}
export interface CatalogMember {
  userId: string;
  email: string;
  role: MemberRole;
  direct: boolean;
  directRole: MemberRole | null;
  inheritanceSources: { catalogNodeId: import("@/features/collaboration/model/catalog").CatalogNodeId; name: string; role: MemberRole }[];
  hasHiddenInheritance: boolean;
}
export interface CatalogSharingDetails {
  target: SharedTargetRef;
  name: string;
  sharing: LibrarySharingMetadata;
  members: CatalogMember[];
}
export interface SharedCatalogBridge {
  billing(action: "checkout" | "portal"): Promise<void>;
  lockedDocumentCount?(): Promise<number>;
  recoverLocked(): Promise<{ saved: number; failed: number }>;
  status(): Promise<SharedCatalogStatus>;
  refresh(): Promise<SharedCatalogStatus>;
  /** Main owns the serialized five-second poll; cleanup must set false. */
  setVisible(visible: boolean): Promise<void>;
  start(target: LocalSharingTarget): Promise<CatalogSharingDetails>;
  details(target: LibrarySharingTarget): Promise<CatalogSharingDetails | null>;
  /** Accepts both legacy document and hierarchy tokens, without downloading bodies. */
  join(token: string): Promise<{ target: SharedTargetRef; workspaceId: string; folderId?: string; fileId?: string }>;
  invite(target: SharedTargetRef, role: Exclude<MemberRole, "owner">): Promise<{ token: string; tokenHash: string }>;
  changeMember(target: SharedTargetRef, userId: string, role: Exclude<MemberRole, "owner"> | null): Promise<void>;
  revokeInvitation(target: SharedTargetRef, tokenHash: string): Promise<void>;
  end(target: SharedTargetRef, action: "stop" | "delete" | "leave"): Promise<void>;
  onChange(listener: (status: SharedCatalogStatus) => void): () => void;
}

/** This is a navigation location, never a writable parent or a server identity. */
export const SHARED_ITEMS_WORKSPACE_ID = "shared-items";
