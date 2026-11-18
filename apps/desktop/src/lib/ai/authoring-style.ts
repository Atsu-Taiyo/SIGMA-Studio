/** Desktop authoring memory contract. No document or rendering core depends on it. */
export type AuthoringStyleSection = "style" | "procedure" | "tex" | "custom";

/** One learned habit. `user` items were written or changed by hand and are never touched automatically. */
export interface AuthoringStyleItemView {
  id: string;
  section: AuthoringStyleSection;
  text: string;
  origin: "auto" | "user";
  /** `summary`: added by the AI the user already uses. The others were counted on the device. */
  basis: "writing" | "corrections" | "summary" | null;
  support: number;
  documents: number;
  firstSeenAt: string;
  lastConfirmedAt: string;
}

/** A change the unattended review may not apply by itself; it waits for the user's decision. */
export interface AuthoringStylePendingView {
  id: string;
  kind: "add" | "rewrite" | "remove";
  reason: "contradicted" | "stale" | "limit";
  currentText: string;
  proposedText: string;
  support: number;
}

/** What became of text an accepted AI proposal wrote, and how many proposals were rejected. */
export interface AuthoringStyleOutcomes {
  kept: number;
  edited: number;
  reverted: number;
  rejected: number;
}

/** Whether the learned habits, notes and learning settings are kept in step with the signed-in account's other devices. */
export interface AuthoringStyleSyncView {
  /** The app was built with a collaboration server. */
  available: boolean;
  signedIn: boolean;
  /** Whether the signed-in account's plan includes sync. Null until the server has been asked. */
  pro: boolean | null;
  enabled: boolean;
  /**
   * `other-account`: these files were merged with a different account and wait for the user's decision.
   * `limit`: merging would exceed the memo limit, so nothing was changed. `unavailable`: the server does not offer it.
   * `pro-required`: the account's plan does not include sync, so nothing is sent.
   */
  state: "off" | "signed-out" | "pro-required" | "other-account" | "unavailable" | "limit" | "error" | "ok";
  /** What the page being shown is: the account's own, a shared workspace's (synced), or a workspace kept on this device. */
  scope: "account" | "shared" | "shared-view" | "device";
  lastSyncedAt: string | null;
  /**
   * Whether this member may reset the style and set the switches for everyone who shares the page. False for a
   * member of a shared workspace who is not an owner or admin: their switches then hold for this device only.
   */
  manage: boolean;
  /** How the switches stand for all members of a shared workspace. Null where there is no such thing. */
  wide: { enabled: boolean; aiSummary: boolean } | null;
}

/** A habit or note line another member of a shared workspace wrote. It is not given to this member's AI until approved. */
export interface AuthoringStyleMemberEntryView {
  id: string;
  kind: "item" | "note";
  text: string;
  /** This member chose not to use it. It stays out until approved after all. */
  declined: boolean;
}

export interface AuthoringStyleProfile {
  workspaceId: string | null;
  enabled: boolean;
  /** The review may send excerpts of the author's writing to the AI they already use. */
  aiSummary: boolean;
  /** The provider such a summary would be asked of; null until an AI request has been made. */
  aiSummaryProvider: "chatgpt" | "claude" | "antigravity" | null;
  userContent: string;
  userPath: string;
  revision: string;
  /** The learned memo as Markdown. Empty for the global scope: each habit lives in one workspace only. */
  generatedContent: string;
  generatedPath: string;
  generatedRevision: string;
  exampleCount: number;
  items: AuthoringStyleItemView[];
  pending: AuthoringStylePendingView[];
  usage: { characters: number; limit: number };
  outcomes: AuthoringStyleOutcomes;
  lastReviewedAt: string | null;
  reviewedDocuments: number;
  lastUpdate: { at: string; added: number; staged: number } | null;
  canUndo: boolean;
  /** Lines withheld from the AI because they look like injected instructions. */
  blockedLines: number;
  /** What other members of a shared workspace wrote and this member has not approved. Empty elsewhere. */
  memberEntries: AuthoringStyleMemberEntryView[];
  sync: AuthoringStyleSyncView;
}

export interface AuthoringStyleAPI {
  read(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  save(input: { workspaceId: string | null; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile>;
  saveLearned(input: { workspaceId: string; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile>;
  setEnabled(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile>;
  setAiSummary(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile>;
  reset(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  /** Run the background review now instead of waiting for its trigger. */
  review(workspaceId: string): Promise<AuthoringStyleProfile>;
  resolvePending(input: { workspaceId: string; id: string; approve: boolean }): Promise<AuthoringStyleProfile>;
  /** Remove one automatic item by id. Like deleting its line, it is not learned again. */
  removeItem(input: { workspaceId: string; id: string }): Promise<AuthoringStyleProfile>;
  undo(workspaceId: string): Promise<AuthoringStyleProfile>;
  /** Approve what other members wrote, so it is given to this member's AI, or decline it. */
  resolveMemberEntries(input: { workspaceId: string; ids: string[]; approve: boolean }): Promise<AuthoringStyleProfile>;
  /** Turn account sync on or off. Nothing is sent while it is off. */
  setSync(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile>;
  syncNow(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  /** Merge with the account now signed in, after the files were synced with a different one. */
  relinkSync(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  /** Delete the account's copy on the server and turn sync off. The files on this device stay. */
  deleteSynced(workspaceId: string | null): Promise<AuthoringStyleProfile>;
}

export const AUTHORING_STYLE_NOTE_LIMIT = 3000;
