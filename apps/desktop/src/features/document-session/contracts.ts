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
   * The library lists this file as shared, but `get` has no session for it yet. Ask the
   * host to attach one; `subscribeAuthority` listeners hear when it does.
   */
  requestSession?(fileId: string): void;
}
