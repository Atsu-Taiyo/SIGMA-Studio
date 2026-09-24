import { getDesktopBridge } from "@/lib/desktop-bridge";
import * as Y from "yjs";
import type { SigmaDocument } from "@/features/document";
import type {
  DocumentSession,
  SessionSelection,
  RemoteSessionSelection,
  SessionOverlayPresence,
  RemoteSessionOverlayPresence,
} from "@/features/document-session/contracts";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import {
  SharedDocument,
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
} from "../model/shared-document";
import {
  fromBase64,
  toBase64,
  MAX_DOCUMENT_BYTES,
  type SaveState,
  type MemberRole,
} from "../model/protocol";
import type {
  CollaborationBridge,
  CollaborationEvent,
  SessionInfo,
  PresenceParticipant,
} from "../model/bridge";
import { isObject, type ObjectValue } from "../model/value";
import { richText } from "../model/rich-text";
import type { PresenceState } from "../model/bridge";
import {
  MAX_PRESENCE_MESSAGE_BYTES,
  MAX_PRESENCE_PREVIEW_SHAPES,
  MAX_PRESENCE_SHAPE_IDS,
} from "../model/presence";
import { shareProjection } from "./projection";
import { countPerformanceEvent, measurePerformance } from "@/lib/performance";

const EMPTY_ROSTER: PresenceParticipant[] = [];

export class RendererDocumentSession implements DocumentSession {
  readonly shared: SharedDocument;
  private readonly undo: Y.UndoManager;
  private listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private activeApprovalIds?: string[];
  private kind: "manual" | "undo" | "redo" = "manual";
  private composing = false;
  private queued: CollaborationEvent[] = [];
  private statusListeners = new Set<() => void>();
  private presenceListeners = new Set<() => void>();
  private assetListeners = new Set<() => void>();
  private participants = new Map<string, PresenceParticipant>();
  private ownClientId?: string;
  private rosterCache: PresenceParticipant[] = EMPTY_ROSTER;
  private selection: SessionSelection | null = null;
  private overlayPresence: SessionOverlayPresence | null = null;
  private lastPresence = "";
  private presenceSentAt = 0;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private pendingPresence: PresenceState | null | undefined;
  private presenceSending = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private active = false;
  private readonly aiOrigin = Symbol("approved-by-this-actor");
  // A replica-local view cache, not a server revision or an editable JSON store.
  private projectionVersion = 0;
  private projectedVersion = -1;
  private projection?: SigmaDocument;
  /**
   * Replica-local pixels for assets whose reference has not reached the main
   * journal yet. The CRDT always contains only sigma-doc-storage:// ids.
   */
  private readonly pendingAssetPreviews = new Map<string, string>();
  private readonly assetReadyVersions = new Map<string, number>();
  private assetRevision = 0;
  private destroyed = false;
  status: SaveState;
  role: MemberRole;
  constructor(
    readonly info: SessionInfo,
    private readonly bridge: CollaborationBridge,
    private readonly commitView: (notify: () => void) => void = notify => notify(),
  ) {
    this.shared = new SharedDocument(
      fromBase64(info.state, MAX_DOCUMENT_BYTES),
    );
    this.role = info.role;
    this.status = info.status;
    this.undo = this.shared.createUndoManager(
      new Set([LOCAL_ORIGIN, this.aiOrigin]),
    );
    this.undo.on("stack-item-added", ({ stackItem }) => {
      if (this.activeApprovalIds?.length) stackItem.meta.set("approvalIds", this.activeApprovalIds);
    });
    this.shared.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.projectionVersion += 1;
      if (origin !== LOCAL_ORIGIN && origin !== this.undo) return;
      const operationId = crypto.randomUUID();
      const kind = this.kind;
      this.status = "local-saving";
      this.notifyStatus();
      this.pending = this.pending
        .then(() =>
          this.bridge.update(
            info.binding.localFileId,
            toBase64(update),
            operationId,
            kind,
            info.binding.epoch,
          ),
        )
        .catch(() => {
          this.status = "save-error";
          this.notifyStatus();
          throw new Error("LOCAL_SAVE_FAILED");
        });
      void this.pending.catch(() => {});
    });
  }
  get writable(): boolean {
    return (
      this.role !== "viewer" &&
      !["permission-error", "save-error", "epoch-error"].includes(this.status)
    );
  }
  project(): SigmaDocument {
    if (this.projectedVersion !== this.projectionVersion || !this.projection) {
      this.projection = measurePerformance("DocumentSession.project", () => shareProjection(
        this.projection,
        parseSigmaDocument(this.shared.project()),
      ));
      this.projectedVersion = this.projectionVersion;
    }
    return this.projection;
  }
  change(before: SigmaDocument, after: SigmaDocument): SigmaDocument {
    if (!this.writable) throw new Error("READ_ONLY");
    const next = JSON.parse(JSON.stringify(after)) as ObjectValue;
    const assets: Promise<unknown>[] = [];
    const addedAssetIds: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!isObject(value)) return;
      if (
        isObject(value.props) &&
        typeof value.props.src === "string" &&
        value.props.src.startsWith("sigma-doc-storage://")
      )
        value.props.src = canonicalAssetSource(value.props.src);
      if (
        value.type === "image" &&
        typeof value.id === "string" &&
        isObject(value.props) &&
        typeof value.props.src === "string" &&
        value.props.src.startsWith("data:")
      ) {
        const source = value.props.src;
        const existing = Object.entries(this.info.assets).find(
          ([, preview]) => preview === source,
        );
        const assetId = existing?.[0] ?? crypto.randomUUID();
        if (existing) {
          value.props.src = `sigma-doc-storage://${assetId}`;
          Object.values(value).forEach(visit);
          return;
        }
        this.info.assets[assetId] = value.props.src;
        this.pendingAssetPreviews.set(assetId, source);
        addedAssetIds.push(assetId);
        assets.push(
          this.bridge.asset(
            this.info.binding.localFileId,
            assetId,
            source,
          ),
        );
        value.props.src = `sigma-doc-storage://${assetId}`;
      }
      Object.values(value).forEach(visit);
    };
    visit(next);
    if (assets.length)
      this.pending = this.pending.then(() => Promise.all(assets));
    this.shared.change(JSON.parse(JSON.stringify(before)) as ObjectValue, next);
    if (addedAssetIds.length) {
      // The update listener above appends bridge.update after the durable asset
      // write. Keep the data URL visible until both have reached main, then
      // notify only image adapters so Chromium retries the authorized URL.
      const ready = this.pending;
      void ready.then(() => {
        if (this.destroyed) return;
        let changed = false;
        for (const assetId of addedAssetIds)
          changed = this.pendingAssetPreviews.delete(assetId) || changed;
        if (!changed) return;
        this.notifyAssets();
      }).catch(() => {});
    }
    return this.project();
  }
  restore(direction: "undo" | "redo"): SigmaDocument | null {
    if (!this.writable) return null;
    this.kind = direction;
    this.undo.stopCapturing();
    const stack = direction === "undo" ? this.undo.undoStack : this.undo.redoStack;
    this.activeApprovalIds = stack.at(-1)?.meta.get("approvalIds") as string[] | undefined;
    try {
      const item = direction === "undo" ? this.undo.undo() : this.undo.redo();
      const ids = this.activeApprovalIds;
      const storage = getDesktopBridge()?.storage;
      if (item && ids?.length && storage) {
        void this.pending.then(() => direction === "undo" ? storage.markMcpEditProposalsReverted?.(ids) : storage.markMcpEditProposalsReapplied?.(ids)).catch(() => {});
      }
      return item ? this.project() : null;
    } finally {
      this.activeApprovalIds = undefined;
      this.kind = "manual";
      this.undo.stopCapturing();
    }
  }
  receive(event: CollaborationEvent): void {
    if (this.destroyed) return;
    if (event.fileId !== this.info.binding.localFileId) return;
    if (event.type === "roster") {
      if (!this.active) return;
      this.ownClientId = event.ownClientId;
      this.participants = new Map(
        event.participants.map((participant) => [participant.clientId, participant]),
      );
      this.updateRosterCache();
      this.presenceListeners.forEach((listener) => listener());
      return;
    }
    if (event.type === "status") {
      const writable = this.writable;
      this.status = event.status;
      this.role = event.role;
      this.notifyStatus();
      if (writable !== this.writable)
        this.notifyDocument();
      return;
    }
    if (event.type === "asset-ready") {
      this.assetReadyVersions.set(
        event.assetId,
        (this.assetReadyVersions.get(event.assetId) ?? 0) + 1,
      );
      this.notifyAssets();
      return;
    }
    if (event.type !== "update") return;
    if (event.epoch !== this.info.binding.epoch) return;
    if (this.composing) {
      this.queued.push(event);
      return;
    }
    const ownApproval =
      event.identity.actorId === this.info.actorId &&
      event.identity.kind === "ai" && Boolean(event.approvalIds?.length);
    if (ownApproval) this.undo.stopCapturing();
    this.activeApprovalIds = ownApproval ? event.approvalIds : undefined;
    const version = this.projectionVersion;
    this.shared.applyUpdate(
      fromBase64(event.update, MAX_DOCUMENT_BYTES),
      ownApproval ? this.aiOrigin : REMOTE_ORIGIN,
    );
    this.activeApprovalIds = undefined;
    if (ownApproval) this.undo.stopCapturing();
    // Main persistence and the server both echo local updates. Yjs already
    // deduplicates them; do not re-project or synchronously render that echo.
    if (version === this.projectionVersion) {
      countPerformanceEvent("DocumentSession.duplicateUpdateIgnored");
      return;
    }
    this.notifyDocument();
    this.presenceListeners.forEach((listener) => listener());
  }
  composition(active: boolean): void {
    this.composing = active;
    if (!active) {
      const events = this.queued;
      this.queued = [];
      events.forEach((event) => this.receive(event));
    }
  }
  async restoreOperations(operationIds: string[]): Promise<boolean> {
    if (!this.writable || !operationIds.length) return false;
    const requested = new Set(operationIds);
    const original = this.undo.undoStack;
    const selected = original.filter((item) => (item.meta.get("approvalIds") as string[] | undefined)?.some((id) => requested.has(id)));
    const covered = new Set(selected.flatMap((item) => item.meta.get("approvalIds") as string[]));
    if (operationIds.some((id) => !covered.has(id))) return false;
    // Only the selected transactions are undone. Later manual edits and peers'
    // transactions stay in place and in the ordinary undo history.
    this.undo.stopCapturing();
    this.undo.undoStack = [...selected];
    try {
      while (this.undo.undoStack.length) this.restore("undo");
    } finally {
      this.undo.undoStack = original.filter((item) => !selected.includes(item));
      this.undo.stopCapturing();
      this.notifyDocument();
    }
    await this.pending;
    await getDesktopBridge()?.storage.markMcpEditProposalsReverted?.([...covered]);
    return true;
  }
  private notifyDocument(): void {
    // Only a changed document (or write permission) needs an atomic view commit.
    // Status, presence and duplicate echoes must not flush pending local renders.
    this.commitView(() => this.listeners.forEach(listener => listener()));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  subscribePresence(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }
  resolveAssetSource(source: string): string {
    if (!source.startsWith("sigma-doc-storage://")) return source;
    const canonical = canonicalAssetSource(source);
    const assetId = canonical.slice(20);
    const preview = this.pendingAssetPreviews.get(assetId);
    if (preview) return preview;
    const readyVersion = this.assetReadyVersions.get(assetId);
    return readyVersion ? `${canonical}?ready=${readyVersion}` : canonical;
  }
  assetSourceVersion(): number {
    return this.assetRevision;
  }
  subscribeAssets(listener: () => void): () => void {
    this.assetListeners.add(listener);
    return () => {
      this.assetListeners.delete(listener);
    };
  }
  setSelection(selection: SessionSelection | null): void {
    this.selection = selection;
    this.queuePresence(selection === null);
  }
  setOverlayPresence(presence: SessionOverlayPresence | null): void {
    const normalized = presence?.selectedShapeIds.length ? structuredClone(presence) : null;
    const ending = normalized === null || (
      this.overlayPresence?.preview !== undefined && normalized.preview === undefined
    );
    this.overlayPresence = normalized;
    this.queuePresence(ending);
  }
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.queuePresence(true, true);
      this.heartbeat = setInterval(() => this.queuePresence(false, true), 10_000);
    } else {
      clearInterval(this.heartbeat);
      clearTimeout(this.presenceTimer);
      this.heartbeat = undefined;
      this.presenceTimer = undefined;
      this.participants.clear();
      this.ownClientId = undefined;
      this.rosterCache = EMPTY_ROSTER;
      this.queueExplicitPresence(null, true);
      this.presenceListeners.forEach((listener) => listener());
    }
  }
  private buildPresence(): PresenceState | null {
    const value = this.selection;
    const encode = (point: SessionSelection["anchor"]): string | undefined => {
      const fragment = this.shared.getRichFragment(point.blockId, "children");
      if (!fragment) return;
      const text = richText(fragment);
      return toBase64(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(
            text,
            Math.min(text.length, Math.max(0, point.offset)),
          ),
        ),
      );
    };
    const anchor = value && encode(value.anchor);
    const head = value && encode(value.head);
    const textState: PresenceState | null =
      value && anchor && head
        ? {
            blockId: value.head.blockId,
            selection: {
              anchor,
              head,
              anchorBlockId: value.anchor.blockId,
              headBlockId: value.head.blockId,
            },
          }
        : null;
    if (!textState && !this.overlayPresence) return null;
    return fitPresenceStateToWireBudget({
      ...(textState ?? {}),
      ...(this.overlayPresence ? { overlay: this.overlayPresence } : {}),
    });
  }
  private queuePresence(immediate = false, heartbeat = false): void {
    if (!this.active) return;
    const state = this.buildPresence();
    const serialized = JSON.stringify(state);
    if (
      !heartbeat &&
      serialized === this.lastPresence &&
      Date.now() - this.presenceSentAt < 9_000
    )
      return;
    this.queueExplicitPresence(state, immediate || state === null);
  }
  private queueExplicitPresence(state: PresenceState | null, immediate: boolean): void {
    this.pendingPresence = state;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    const delay = immediate ? 0 : Math.max(0, 50 - (Date.now() - this.presenceSentAt));
    if (delay === 0) {
      this.drainPresence();
      return;
    }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.drainPresence();
    }, delay);
  }
  private drainPresence(): void {
    if (this.presenceSending || this.pendingPresence === undefined) return;
    const state = this.pendingPresence;
    this.pendingPresence = undefined;
    this.presenceSending = true;
    this.lastPresence = JSON.stringify(state);
    this.presenceSentAt = Date.now();
    void this.bridge.presence(this.info.binding.localFileId, state)
      .catch(() => {})
      .finally(() => {
        this.presenceSending = false;
        if (this.pendingPresence !== undefined)
          this.queueExplicitPresence(this.pendingPresence, this.pendingPresence === null);
      });
  }
  remoteSelections(): RemoteSessionSelection[] {
    const result: RemoteSessionSelection[] = [];
    for (const participant of this.participants.values()) {
      if (participant.clientId === this.ownClientId) continue;
      const selection = participant.state?.selection;
      if (!selection) continue;
      try {
        const anchor = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(fromBase64(selection.anchor, 2048)),
          this.shared.doc,
        );
        const head = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(fromBase64(selection.head, 2048)),
          this.shared.doc,
        );
        if (anchor && head)
          result.push({
            actorId: participant.actorId,
            clientId: participant.clientId,
            anchor: { blockId: selection.anchorBlockId, offset: anchor.index },
            head: { blockId: selection.headBlockId, offset: head.index },
          });
      } catch {
        /* Malformed or expired ephemeral data never affects the document. */
      }
    }
    return result;
  }
  remoteOverlayPresence(): RemoteSessionOverlayPresence[] {
    const result: RemoteSessionOverlayPresence[] = [];
    for (const participant of this.participants.values()) {
      if (participant.clientId === this.ownClientId || !participant.state?.overlay) continue;
      const profile = participant.profile;
      result.push({
        ...structuredClone(participant.state.overlay),
        actorId: participant.actorId,
        clientId: participant.clientId,
        displayName: profile.displayName || profile.email || participant.actorId,
        ...(profile.avatarUrl ? {
          avatarSource: `sigma-collaboration-profile://avatar?url=${encodeURIComponent(profile.avatarUrl)}`,
        } : {}),
      });
    }
    return result;
  }
  roster(): PresenceParticipant[] {
    return this.rosterCache;
  }
  private updateRosterCache(): void {
    this.rosterCache = [...this.participants.values()].filter(
      (participant) => participant.clientId !== this.ownClientId,
    );
  }
  async flush(): Promise<void> {
    await this.pending;
    await this.bridge.flush(this.info.binding.localFileId);
  }
  async exportDocument(): Promise<SigmaDocument> {
    await this.flush();
    const document = structuredClone(this.project());
    const visit = async (value: unknown): Promise<void> => {
      if (Array.isArray(value)) {
        await Promise.all(value.map(visit));
        return;
      }
      if (!isObject(value)) return;
      if (
        typeof value.src === "string" &&
        value.src.startsWith("sigma-doc-storage://")
      )
        value.src = await this.bridge.asset(
          this.info.binding.localFileId,
          canonicalAssetSource(value.src).slice(20),
        );
      await Promise.all(Object.values(value).map(visit));
    };
    await visit(document);
    return document;
  }
  destroy(): void {
    this.destroyed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.presenceTimer);
    if (this.active) this.queueExplicitPresence(null, true);
    this.undo.destroy();
    this.shared.destroy();
    this.listeners.clear();
    this.statusListeners.clear();
    this.presenceListeners.clear();
    this.assetListeners.clear();
    this.pendingAssetPreviews.clear();
    this.assetReadyVersions.clear();
    this.participants.clear();
    this.rosterCache = EMPTY_ROSTER;
  }
  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener();
  }
  private notifyAssets(): void {
    this.assetRevision += 1;
    for (const listener of this.assetListeners) listener();
  }
}

function canonicalAssetSource(source: string): string {
  return source.replace(/\?.*$/, "");
}

export function fitPresenceStateToWireBudget(state: PresenceState): PresenceState {
  const next = structuredClone(state);
  if (next.overlay) {
    next.overlay.selectedShapeIds = next.overlay.selectedShapeIds.slice(0, MAX_PRESENCE_SHAPE_IDS);
    if (next.overlay.preview)
      next.overlay.preview.shapes = next.overlay.preview.shapes.slice(0, MAX_PRESENCE_PREVIEW_SHAPES);
  }
  const fits = () => new TextEncoder().encode(JSON.stringify({ type: "awareness", state: next })).byteLength <= MAX_PRESENCE_MESSAGE_BYTES;
  while (next.overlay?.preview?.shapes.length && !fits()) next.overlay.preview.shapes.pop();
  if (next.overlay?.preview && next.overlay.preview.shapes.length === 0) delete next.overlay.preview;
  while (next.overlay?.selectedShapeIds.length && !fits()) next.overlay.selectedShapeIds.pop();
  if (next.overlay?.selectedShapeIds.length === 0) delete next.overlay;
  if (!fits()) delete next.overlay;
  return next;
}
