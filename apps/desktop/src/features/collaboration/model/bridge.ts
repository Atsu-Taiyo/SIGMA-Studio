import type { SigmaDocument } from "@/features/document";
import type { SessionOverlayPresence } from "@/features/document-session/contracts";
import type { SharedApproval } from "./approval";
import type {
  MemberRole,
  OperationIdentity,
  SaveState,
  SharedBinding,
} from "./protocol";

export interface SessionInfo {
  binding: SharedBinding;
  state: string;
  role: MemberRole;
  status: SaveState;
  actorId: string;
  assets: Record<string, string>;
}
export interface CollaborationProfile {
  actorId: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}
export interface PresenceParticipant {
  clientId: string;
  actorId: string;
  role: MemberRole;
  profile: CollaborationProfile;
  state: PresenceState | null;
}
export interface CollaborationInfo {
  configured: boolean;
  user: CollaborationProfile | null;
  sessions: SessionInfo[];
  /** Local files still governed by a shared journal, including while signed out. */
  restrictedFileIds: string[];
}
export interface SharedBackup {
  id: string;
  epoch: number;
  created_at: string;
}
export interface PresenceState {
  pageId?: string;
  blockId?: string;
  selection?: {
    anchor: string;
    head: string;
    anchorBlockId: string;
    headBlockId: string;
  };
  overlay?: SessionOverlayPresence;
}
export type CollaborationEvent =
  | {
      type: "update";
      fileId: string;
      epoch: number;
      update: string;
      identity: OperationIdentity;
      approvalIds?: string[];
    }
  | { type: "status"; fileId: string; status: SaveState; role: MemberRole }
  | { type: "asset-ready"; fileId: string; assetId: string }
  | { type: "reset"; fileId: string }
  | {
      type: "roster";
      fileId: string;
      ownClientId: string;
      participants: PresenceParticipant[];
    };
export interface CollaborationBridge {
  info(): Promise<CollaborationInfo>;
  signInWithGoogle(): Promise<void>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  start(fileId: string, document: SigmaDocument): Promise<SessionInfo>;
  join(token: string): Promise<{ fileId: string }>;
  update(
    fileId: string,
    update: string,
    operationId: string,
    kind: "manual" | "undo" | "redo",
    epoch: number,
  ): Promise<void>;
  flush(fileId: string, online?: boolean): Promise<void>;
  approve(fileId: string, approval: SharedApproval): Promise<void>;
  members(
    fileId: string,
  ): Promise<{ user_id: string; role: MemberRole; email: string }[]>;
  invite(
    fileId: string,
    role: "editor" | "viewer",
  ): Promise<{ token: string; tokenHash: string }>;
  changeMember(
    fileId: string,
    userId: string,
    role: "editor" | "viewer" | null,
  ): Promise<void>;
  revokeInvitation(fileId: string, tokenHash: string): Promise<void>;
  backups(fileId: string): Promise<SharedBackup[]>;
  backup(fileId: string): Promise<void>;
  restore(fileId: string, backupId: string): Promise<void>;
  reload(fileId: string): Promise<void>;
  view(fileId: string | null): Promise<void>;
  visibleFiles?(fileIds: string[]): Promise<void>;
  presence(fileId: string, state: PresenceState | null): Promise<void>;
  end(fileId: string, action: "stop" | "delete" | "leave"): Promise<void>;
  copy(fileId: string): Promise<{ fileId: string }>;
  asset(fileId: string, assetId: string, source?: string): Promise<string>;
  onEvent(listener: (event: CollaborationEvent) => void): () => void;
}
