import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { SigmaDocument } from "@/features/document";
import type { CollaborationBridge, CollaborationEvent, CollaborationProfile, PresenceParticipant, SessionInfo, SharedBackup, SharedVersion } from "../model/bridge";
import type { CatalogDelta, CatalogNode } from "../model/catalog";
import { SharedDocument } from "../model/shared-document";
import { fromBase64, toBase64, MAX_DOCUMENT_BYTES, MAX_UPDATE_BYTES, type MemberRole, type OperationIdentity, type SaveState } from "../model/protocol";
import { readResponseJson, readResponseBytes, responseError, syncFailureStatus, retryDelay } from "../client/transport";
import { validateAcknowledgements, validateCatalogDelta, validateSnapshot, validateSync } from "../client/response-validation";
import { createSharedBrowserStore, type BrowserSharedRecord, type SharedBrowserStore } from "./journal";

export async function webRequest<T>(path: string, body?: unknown, actorId?: string): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(actorId ? { "X-Sigma-Actor": actorId } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw await responseError(response);
  if (actorId && response.headers.get("x-sigma-actor") !== actorId) { await response.body?.cancel(); throw new Error("ACCOUNT_CHANGED"); }
  return readResponseJson<T>(response, 24 * 1024 * 1024);
}
type Entry = {
  shared: SharedDocument; record: BrowserSharedRecord; info: SessionInfo;
  tail: Promise<unknown>; syncing?: Promise<void>; socket?: WebSocket;
  visible: boolean; retry?: ReturnType<typeof setTimeout>; failures: number;
};
const unavailable = (): never => { throw new Error("WEB_SHARED_ONLY"); };

export class BrowserSharedClient {
  readonly bridge: CollaborationBridge;
  private entries = new Map<string, Entry>();
  private listeners = new Set<(event: CollaborationEvent) => void>();
  private closed = false;
  private leases = new Map<string, () => void>();
  private request: <T>(route: string, body?: unknown) => Promise<T>;
  constructor(readonly user: CollaborationProfile, private readonly store: SharedBrowserStore = createSharedBrowserStore(),
    request = <T>(route: string, body?: unknown) => webRequest<T>(`/api/collaboration${route}`, body, user.actorId)) {
    this.request = request;
    this.bridge = {
      info: async () => ({ configured: true, user, sessions: [...this.entries.values()].map(entry => entry.info), restrictedFileIds: [...this.entries.keys()] }),
      signInWithGoogle: async () => unavailable(), cancelSignIn: async () => {}, signOut: async () => unavailable(), start: async () => unavailable(), join: async () => unavailable(),
      update: (file, update, operation, kind, epoch) => this.update(file, update, operation, kind, epoch),
      flush: (file, online) => this.flush(file, online), approve: async () => unavailable(),
      members: file => this.request(`/documents/${this.entry(file).record.sharedDocumentId}/members`),
      invite: async () => unavailable(), changeMember: async () => unavailable(), revokeInvitation: async () => unavailable(),
      backups: file => this.request<SharedBackup[]>(`/documents/${this.entry(file).record.sharedDocumentId}/backups`),
      version: async (file, id) => {
        const version = await this.request<SharedVersion>(`/documents/${this.entry(file).record.sharedDocumentId}/backups/${encodeURIComponent(id)}`);
        return { ...version, document: parseSigmaDocument(version.document) };
      },
      backup: async () => unavailable(), restore: async () => unavailable(), reload: async () => unavailable(),
      canRestoreVersion: () => false,
      view: async file => this.visible(file), visibleFiles: async files => this.visible(files[0] ?? null),
      presence: async (file, state) => {
        const entry = this.entry(file);
        if (entry.socket?.readyState === WebSocket.OPEN) entry.socket.send(JSON.stringify({ type: "awareness", state }));
      },
      end: async () => unavailable(), copy: async () => unavailable(),
      asset: (file, id, source) => this.asset(file, id, source),
      assetUrl: (file, id) => this.entry(file).record.assets[id]?.source ?? `/api/collaboration/documents/${this.entry(file).record.sharedDocumentId}/assets/${id}?actor=${encodeURIComponent(this.user.actorId)}`,
      onEvent: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
    };
  }
  private entry(file: string): Entry {
    if (this.closed) throw new Error("ACCOUNT_CHANGED");
    const entry = this.entries.get(file);
    if (!entry) throw new Error("SESSION_UNAVAILABLE");
    return entry;
  }
  private emit(event: CollaborationEvent) { if (!this.closed) this.listeners.forEach(listener => listener(event)); }
  private status(file: string, state: SaveState) {
    const entry = this.entries.get(file);
    if (!entry || this.closed) return;
    entry.info.status = state;
    entry.info.role = entry.record.role;
    this.emit({ type: "status", fileId: file, status: state, role: entry.record.role });
  }
  private serial<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ACCOUNT_CHANGED"));
    // Closing blocks new work, but already accepted edits must reach IndexedDB.
    const pending = entry.tail.catch(() => {}).then(run);
    entry.tail = pending;
    return pending;
  }
  async catalog(): Promise<CatalogNode[]> {
    const value = await this.request<CatalogDelta>("/catalog/delta", { since: 0, knownIds: [] });
    validateCatalogDelta(value);
    if (this.closed) throw new Error("ACCOUNT_CHANGED");
    return value.nodes.filter(node => node.state === "active" && node.capabilities.read);
  }
  async open(id: string): Promise<SessionInfo> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("INVALID_DOCUMENT_ID");
    // One writer owns the durable journal. Two tabs writing whole records would
    // otherwise overwrite each other's unsent edits while offline.
    const existing = [...this.entries.values()].find(entry => entry.record.sharedDocumentId === id);
    if (existing) return existing.info;
    const release = await this.store.acquire?.(this.user.actorId, id);
    try {
      if (this.closed) throw new Error("ACCOUNT_CHANGED");
      const info = await this.openRecord(id);
      if (release) this.leases.set(id, release);
      return info;
    } catch (error) { release?.(); throw error; }
  }
  private async openRecord(id: string): Promise<SessionInfo> {
    const cached = await this.store.get(this.user.actorId, id);
    const snapshot = await this.request<{ state: string; role: MemberRole; epoch: number }>(`/documents/${id}/snapshot`);
    if (this.closed) throw new Error("ACCOUNT_CHANGED");
    validateSnapshot(snapshot, id);
    if (cached && (cached.actorId !== this.user.actorId || cached.sharedDocumentId !== id)) throw new Error("ACCOUNT_CHANGED");
    if (cached && cached.epoch !== snapshot.epoch && cached.outbox.length) throw new Error("EPOCH_CHANGED");
    const shared = new SharedDocument(fromBase64(snapshot.state, MAX_DOCUMENT_BYTES));
    if (cached?.epoch === snapshot.epoch) shared.applyUpdate(fromBase64(cached.state, MAX_DOCUMENT_BYTES));
    if (shared.identity().sharedDocumentId !== id || shared.identity().epoch !== snapshot.epoch) { shared.destroy(); throw new Error("INVALID_SNAPSHOT_RESPONSE"); }
    const document = parseSigmaDocument(shared.project());
    const file = document.docId;
    const record: BrowserSharedRecord = {
      actorId: this.user.actorId, sharedDocumentId: id, epoch: snapshot.epoch, state: toBase64(shared.snapshot()), role: snapshot.role,
      outbox: cached?.epoch === snapshot.epoch ? cached.outbox : [], assets: cached?.assets ?? {},
    };
    await this.store.put(record);
    if (this.closed) { shared.destroy(); throw new Error("ACCOUNT_CHANGED"); }
    const info: SessionInfo = { binding: { sharedDocumentId: id, localFileId: file, docId: document.docId, epoch: record.epoch, protocol: 1 }, state: record.state, role: record.role,
      status: record.outbox.length ? "local-saved" : "saved", actorId: this.user.actorId, assets: Object.fromEntries(Object.entries(record.assets).map(([id, value]) => [id, value.source])) };
    this.entries.get(file)?.shared.destroy();
    this.entries.set(file, { shared, record, info, tail: Promise.resolve(), visible: false, failures: 0 });
    return info;
  }
  private async update(file: string, encoded: string, operationId: string, kind: "manual" | "undo" | "redo", epoch: number): Promise<void> {
    const entry = this.entry(file);
    await this.serial(entry, async () => {
      if (epoch !== entry.record.epoch) throw new Error("EPOCH_CHANGED");
      if (entry.record.role === "viewer") throw new Error("READ_ONLY");
      const candidate = new SharedDocument(entry.shared.snapshot());
      try {
        candidate.applyUpdate(fromBase64(encoded, MAX_UPDATE_BYTES));
        parseSigmaDocument(candidate.project());
        const identity = { actorId: this.user.actorId, operationId, kind };
        const next = { ...entry.record, state: toBase64(candidate.snapshot()), outbox: [...entry.record.outbox, { update: encoded, identity }] };
        await this.store.put(next);
        entry.record = next;
        entry.shared.applyUpdate(fromBase64(encoded, MAX_UPDATE_BYTES));
        this.status(file, "local-saved");
      } finally { candidate.destroy(); }
    });
    if (!this.closed) void this.flush(file).catch(() => {});
  }
  private async receive(file: string, update: string, identity: OperationIdentity): Promise<void> {
    const entry = this.entry(file);
    await this.serial(entry, async () => {
      const bytes = fromBase64(update, MAX_DOCUMENT_BYTES);
      const candidate = new SharedDocument(entry.shared.snapshot());
      try {
        candidate.applyUpdate(bytes);
        parseSigmaDocument(candidate.project());
        if (candidate.identity().epoch !== entry.record.epoch || candidate.identity().sharedDocumentId !== entry.record.sharedDocumentId) throw new Error("EPOCH_CHANGED");
        const next = { ...entry.record, state: toBase64(candidate.snapshot()) };
        await this.store.put(next);
        entry.record = next;
        entry.shared.applyUpdate(bytes);
        this.emit({ type: "update", fileId: file, epoch: entry.record.epoch, update, identity });
      } finally { candidate.destroy(); }
    });
  }
  async flush(file: string, online = false): Promise<void> {
    const entry = this.entry(file);
    await entry.tail;
    if (!entry.syncing) {
      entry.syncing = this.synchronize(file).catch(error => {
        this.status(file, syncFailureStatus(error));
        this.retry(file, error);
        throw error;
      }).finally(() => { entry.syncing = undefined; });
    }
    if (online) await entry.syncing;
    else await entry.syncing.catch(() => {});
  }
  private async synchronize(file: string): Promise<void> {
    const entry = this.entry(file);
    this.status(file, "syncing");
    const prefix = `/documents/${entry.record.sharedDocumentId}`;
    this.connect(file);
    const result = await this.request<{ update: string; role: MemberRole; epoch: number }>(`${prefix}/sync`, { protocol: 1, epoch: entry.record.epoch, vector: toBase64(entry.shared.vector()) });
    validateSync(result, entry.record.epoch);
    await this.serial(entry, async () => {
      const next = { ...entry.record, role: result.role };
      await this.store.put(next);
      entry.record = next;
    });
    await this.receive(file, result.update, { operationId: crypto.randomUUID(), actorId: "remote", kind: "manual" });
    if (entry.record.role === "viewer" && entry.record.outbox.length) throw new Error("READ_ONLY");
    for (const [id, asset] of Object.entries(entry.record.assets)) {
      if (!asset.pending) continue;
      const source = await fetch(asset.source);
      const bytes = await source.blob();
      const response = await fetch(`/api/collaboration${prefix}/assets/${id}`, { method: "PUT", body: bytes, headers: { "X-Sigma-Actor": this.user.actorId }, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw await responseError(response);
      if (response.headers.get("x-sigma-actor") !== this.user.actorId) { await response.body?.cancel(); throw new Error("ACCOUNT_CHANGED"); }
      await response.body?.cancel();
      await this.serial(entry, async () => {
        const next = { ...entry.record, assets: { ...entry.record.assets, [id]: { ...asset, pending: false } } };
        await this.store.put(next); entry.record = next;
      });
    }
    while (entry.record.outbox.length) {
      const operations = entry.record.outbox.slice(0, 1);
      const result = await this.request(`${prefix}/updates`, { protocol: 1, epoch: entry.record.epoch,
        operations: operations.map(item => ({ ...item.identity, update: item.update })) });
      validateAcknowledgements(result, operations.map(item => item.identity.operationId));
      await this.serial(entry, async () => {
        const next = { ...entry.record, outbox: entry.record.outbox.filter(item => !operations.some(sent => sent.identity.operationId === item.identity.operationId)) };
        await this.store.put(next); entry.record = next;
      });
    }
    entry.failures = 0;
    this.status(file, entry.record.outbox.length ? "local-saved" : "saved");
  }
  private connect(file: string) {
    const entry = this.entry(file);
    if (!entry.visible || entry.socket || typeof location === "undefined") return;
    const url = new URL(`/api/collaboration/documents/${entry.record.sharedDocumentId}/socket`, location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("actor", this.user.actorId);
    const socket = new WebSocket(url);
    entry.socket = socket;
    socket.onmessage = message => {
      if (this.closed || entry.socket !== socket) return;
      try {
        if (typeof message.data !== "string" || message.data.length > MAX_DOCUMENT_BYTES * 1.4) throw new Error("PAYLOAD_LIMIT");
        const event = JSON.parse(message.data);
        if (event.type === "update" && typeof event.update === "string" && typeof event.identity?.operationId === "string")
          void this.receive(file, event.update, event.identity).catch(() => this.status(file, "save-error"));
        if (event.type === "role" && ["owner", "admin", "editor", "viewer"].includes(event.role)) {
          void this.serial(entry, async () => {
            const next = { ...entry.record, role: event.role }; await this.store.put(next); entry.record = next; this.status(file, entry.info.status);
          }).catch(() => this.status(file, "save-error"));
        }
        if (event.type === "roster" && typeof event.ownClientId === "string" && Array.isArray(event.participants)) {
          const own = event.participants.find((participant: PresenceParticipant) => participant.clientId === event.ownClientId);
          if (own && own.actorId !== this.user.actorId) { socket.close(); this.status(file, "permission-error"); return; }
          this.emit({ type: "roster", fileId: file, ownClientId: event.ownClientId, participants: event.participants as PresenceParticipant[] });
        }
      } catch { socket.close(1002); }
    };
    socket.onclose = event => {
      if (this.closed || entry.socket !== socket) return;
      entry.socket = undefined;
      this.status(file, event.code === 4409 ? "epoch-error" : event.code === 4403 ? "permission-error" : "offline");
      if (![4403, 4409].includes(event.code)) this.retry(file);
    };
    socket.onerror = () => { if (!this.closed) this.status(file, "offline"); };
  }
  private retry(file: string, error?: unknown) {
    const entry = this.entries.get(file);
    if (!entry?.visible || this.closed || entry.retry || ["permission-error", "epoch-error", "sync-rejected"].includes(entry.info.status)) return;
    entry.retry = setTimeout(() => { entry.retry = undefined; if (!this.closed && entry.visible) void this.flush(file).catch(() => {}); }, retryDelay(++entry.failures, error));
  }
  visible(file: string | null) {
    for (const [id, entry] of this.entries) {
      entry.visible = file === id && !this.closed;
      if (!entry.visible) {
        clearTimeout(entry.retry); entry.retry = undefined;
        const socket = entry.socket; entry.socket = undefined; socket?.close();
      } else void this.flush(id).catch(() => {});
    }
  }
  private async asset(file: string, id: string, source?: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("INVALID_ASSET_ID");
    const entry = this.entry(file);
    if (source) {
      if (entry.record.role === "viewer") throw new Error("READ_ONLY");
      if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(source) || source.length > 28 * 1024 * 1024) throw new Error("INVALID_ASSET");
      await this.serial(entry, async () => {
        const next = { ...entry.record, assets: { ...entry.record.assets, [id]: { source, pending: true } } };
        await this.store.put(next); entry.record = next;
      });
      return source;
    }
    const cached = entry.record.assets[id];
    if (cached) return cached.source;
    const response = await fetch(`/api/collaboration/documents/${entry.record.sharedDocumentId}/assets/${id}`, { headers: { "X-Sigma-Actor": this.user.actorId }, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw await responseError(response);
    if (response.headers.get("x-sigma-actor") !== this.user.actorId) { await response.body?.cancel(); throw new Error("ACCOUNT_CHANGED"); }
    const bytes = await readResponseBytes(response, 20 * 1024 * 1024);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject;
      reader.readAsDataURL(new Blob([bytes as BlobPart], { type: response.headers.get("content-type") ?? "application/octet-stream" }));
    });
    await this.serial(entry, async () => { const next = { ...entry.record, assets: { ...entry.record.assets, [id]: { source: data, pending: false } } }; await this.store.put(next); entry.record = next; });
    return data;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.retry); entry.socket?.close();
      await entry.syncing?.catch(() => {}); await entry.tail.catch(() => {}); entry.shared.destroy();
    }
    this.leases.forEach(release => release()); this.leases.clear();
    this.listeners.clear(); this.entries.clear();
  }
  async release(file: string): Promise<void> {
    const entry = this.entry(file);
    entry.visible = false; clearTimeout(entry.retry);
    const socket = entry.socket; entry.socket = undefined; socket?.close();
    await entry.syncing?.catch(() => {}); await entry.tail;
    this.entries.delete(file); entry.shared.destroy();
    this.leases.get(entry.record.sharedDocumentId)?.(); this.leases.delete(entry.record.sharedDocumentId);
  }
  document(info: SessionInfo): SigmaDocument { return parseSigmaDocument(this.entry(info.binding.localFileId).shared.project()); }
}
