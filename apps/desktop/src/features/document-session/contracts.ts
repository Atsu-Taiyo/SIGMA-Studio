import type { SigmaDocument } from "@/features/document";
export interface SessionTextPoint {
  blockId: string;
  offset: number;
}
export interface SessionSelection {
  anchor: SessionTextPoint;
  head: SessionTextPoint;
}
export interface RemoteSessionSelection extends SessionSelection {
  actorId: string;
  clientId?: string;
}

export interface SessionOverlayBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  pivot?: { x: number; y: number };
}

export interface SessionOverlayPresence {
  selectedShapeIds: string[];
  preview?: {
    kind: "move" | "resize" | "rotate" | "crop";
    shapes: Array<SessionOverlayBounds & { id: string }>;
  };
}

export interface RemoteSessionOverlayPresence extends SessionOverlayPresence {
  actorId: string;
  clientId: string;
  displayName: string;
  avatarSource?: string;
}

/** One saved version of a document whose versions are kept by its session's host (a shared document's server). */
export interface DocumentSessionVersionEntry {
  versionId: string;
  capturedAt: string;
  /** `auto`: kept while it was being edited. `manual`: saved by hand. `restore`: the state just before a restore. */
  kind: "auto" | "manual" | "restore";
}

/**
 * The versions a session's host keeps (#244). A shared document's versions live on its server, not in the
 * device's version history, so the history panel reads them here. Documents without it use the device's history.
 */
export interface DocumentSessionVersionHistory {
  /** Newest first. */
  list(): Promise<DocumentSessionVersionEntry[]>;
  get(versionId: string): Promise<SigmaDocument | null>;
  /** Whether this user may put everyone's document back to a version. Everyone may look. */
  canRestore(): boolean;
  /** Puts everyone's document back to the version. The restored document arrives as a new session. */
  restore(versionId: string): Promise<void>;
}

/** Host-neutral editing authority. Public editors need neither cloud nor Yjs. */
export interface DocumentSession {
  readonly writable: boolean;
  project(): SigmaDocument;
  change(before: SigmaDocument, after: SigmaDocument): SigmaDocument;
  restore(direction: "undo" | "redo"): SigmaDocument | null;
  restoreOperations?(operationIds: string[]): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  flush(): Promise<void>;
  exportDocument?(): Promise<SigmaDocument>;
  setSelection?(selection: SessionSelection | null): void;
  remoteSelections?(): RemoteSessionSelection[];
  setOverlayPresence?(presence: SessionOverlayPresence | null): void;
  remoteOverlayPresence?(): RemoteSessionOverlayPresence[];
  subscribePresence?(listener: () => void): () => void;
  resolveAssetSource?(source: string): string;
  /** The asset's own bytes as a `data:` URL, for code that parses it. An `<img>` uses `resolveAssetSource`. */
  readAssetSource?(source: string): Promise<string>;
  assetSourceVersion?(): number;
  subscribeAssets?(listener: () => void): () => void;
  /** Versions kept by the host instead of the device's version history. */
  readonly versionHistory?: DocumentSessionVersionHistory;
}
export interface DocumentSessionHost {
  /** Keep a mounted detached document current until its pane is removed. */
  retainVisibleFile?(fileId: string): () => void;
  get(fileId: string): DocumentSession | undefined;
  /** Optional active-view lifecycle. Cached sessions are not necessarily being viewed. */
  setActiveFile?(fileId: string | null): void | Promise<void>;
  /** Host-neutral authority for files whose session is temporarily unavailable. */
  isReadOnly?(fileId: string): boolean;
  /** Subscribe when session availability or file authority changes. */
  subscribeAuthority?(listener: () => void): () => void;
  /**
   * Resolves once `get` returns the session of a file the library lists as shared (`shared`),
   * rereading the host's sessions if needed, or once the host has found none. Resolves at
   * once for other files. Editors await it before showing a shared file they just loaded.
   */
  attachSession?(fileId: string, shared: boolean): Promise<void>;
}
