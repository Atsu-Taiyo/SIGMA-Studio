/** Desktop authoring memory contract. No document or rendering core depends on it. */
export type AuthoringStyleSection = "style" | "procedure" | "tex" | "custom";

/** One learned habit. `user` items were written or changed by hand and are never touched automatically. */
export interface AuthoringStyleItemView {
  id: string;
  section: AuthoringStyleSection;
  text: string;
  origin: "auto" | "user";
  basis: "writing" | "corrections" | null;
  support: number;
  documents: number;
  status: "active" | "stale";
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

export interface AuthoringStyleProfile {
  workspaceId: string | null;
  enabled: boolean;
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
}

export interface AuthoringStyleAPI {
  read(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  save(input: { workspaceId: string | null; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile>;
  saveLearned(input: { workspaceId: string; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile>;
  setEnabled(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile>;
  reset(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  /** Run the background review now instead of waiting for its trigger. */
  review(workspaceId: string): Promise<AuthoringStyleProfile>;
  resolvePending(input: { workspaceId: string; id: string; approve: boolean }): Promise<AuthoringStyleProfile>;
  undo(workspaceId: string): Promise<AuthoringStyleProfile>;
}

export const AUTHORING_STYLE_NOTE_LIMIT = 3000;
