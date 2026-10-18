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
  /** 本人が決めた名前があればそれ、なければ Google の名前。 */
  displayName?: string;
  /** 本人が名前を決めているときの Google の名前。名前を変える前のコメントを自分のものと見分けるのに使う。 */
  providerDisplayName?: string;
  /** Google のアイコン。 */
  avatarUrl?: string;
  /** 本人が決めたアイコンの版 (無ければ Google のアイコン)。表示は `collaborationAvatarSource`。 */
  avatarVersion?: number;
}
/** 共有サーバーの `/profile` `/profiles/lookup` の 1 人ぶん。 */
export interface CollaborationProfileRecord {
  userId: string;
  /** 本人が決めた名前。無ければ `providerDisplayName` (Google の名前) で表示する。 */
  displayName?: string;
  providerDisplayName?: string;
  avatarVersion: number;
  providerAvatarUrl?: string;
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
  /** Absent from servers before automatic versions (#244): every entry was a manual backup. */
  kind?: "auto" | "manual" | "restore";
}
/** One version's content, for looking at it before restoring. */
export interface SharedVersion extends SharedBackup {
  document: unknown;
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
  version(fileId: string, backupId: string): Promise<SharedVersion>;
  backup(fileId: string): Promise<void>;
  restore(fileId: string, backupId: string): Promise<void>;
  reload(fileId: string): Promise<void>;
  view(fileId: string | null): Promise<void>;
  visibleFiles?(fileIds: string[]): Promise<void>;
  presence(fileId: string, state: PresenceState | null): Promise<void>;
  end(fileId: string, action: "stop" | "delete" | "leave"): Promise<void>;
  copy(fileId: string): Promise<{ fileId: string }>;
  asset(fileId: string, assetId: string, source?: string): Promise<string>;
  /** 自分のプロフィール (名前・アイコン) を取り直す。 */
  profile?(): Promise<CollaborationProfileRecord | null>;
  /** 自分の名前を変える。null や空白だけなら Google の名前へ戻す。 */
  updateProfile?(input: { displayName: string | null }): Promise<CollaborationProfileRecord>;
  /** 自分のアイコンを変える (256px 四方の WebP/PNG/JPEG)。 */
  setAvatar?(bytes: Uint8Array, type: "image/webp" | "image/png" | "image/jpeg"): Promise<CollaborationProfileRecord>;
  /** 自分のアイコンをやめて Google のアイコンへ戻す。 */
  clearAvatar?(): Promise<CollaborationProfileRecord>;
  /** 共有している相手の名前とアイコン。見えない人は返らない。 */
  profiles?(userIds: string[]): Promise<CollaborationProfileRecord[]>;
  onEvent(listener: (event: CollaborationEvent) => void): () => void;
}
