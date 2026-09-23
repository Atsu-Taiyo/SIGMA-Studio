import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import type { SigmaDocument } from "@/features/document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import type { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import {
  fromBase64,
  toBase64,
  MAX_ASSET_BYTES,
  MAX_UPDATE_BYTES,
  MAX_DOCUMENT_BYTES,
  type MemberRole,
  type SaveState,
  type OperationIdentity,
} from "../../src/features/collaboration/model/protocol";
import {
  isObject,
  type ObjectValue,
} from "../../src/features/collaboration/model/value";
import type {
  CollaborationEvent,
  CollaborationInfo,
  CollaborationProfile,
  PresenceParticipant,
  SessionInfo,
  PresenceState,
} from "../../src/features/collaboration/model/bridge";
import type { SharedApproval } from "../../src/features/collaboration/model/approval";
import { CollaborationAuth, collaborationConfig } from "./auth";
import { durableWrite, SharedDocumentJournal } from "./journal";

interface Session {
  journal: SharedDocumentJournal;
  role: MemberRole;
  status: SaveState;
  socket?: WebSocket;
  syncing?: Promise<void>;
  tail: Promise<unknown>;
  assets: Record<string, string>;
  stopped?: boolean;
  failed?: boolean;
  viewing?: boolean;
  clientId?: string;
  connectionGeneration?: number;
  lastSynchronizedAt?: number;
  presenceSocket?: WebSocket;
  presencePayload?: string;
  pendingAssetRevision?: number;
  uploadedAssetRevision?: number;
}
interface Registry {
  version: 1;
  retiredJournals?: string[];
  files: Record<
    string,
    {
      sharedDocumentId: string;
      actorId: string;
      role: MemberRole;
      operationId: string;
      initialized: boolean;
      staged?: boolean;
      journalDirectory?: string;
    }
  >;
}
export class CollaborationSessions {
  readonly directory: string;
  readonly auth: CollaborationAuth | null;
  private registry: Registry = { version: 1, files: {} };
  private sessions = new Map<string, Session>();
  private registryTail: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setInterval>;
  private viewedFileId: string | null = null;
  private visibleFileIds = new Set<string>();
  private readonly approverWindow = new AsyncLocalStorage<number>();
  private readonly approvalWindows = new Map<string, number>();
  constructor(
    userData: string,
    private readonly local: LocalSigmaDocStore,
    private readonly emit: (event: CollaborationEvent, approvalWindow?: number) => void,
  ) {
    this.directory = path.join(userData, "collaboration-v1");
    const config = collaborationConfig();
    this.auth = config ? new CollaborationAuth(this.directory, config) : null;
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.auth?.initialize();
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(path.join(this.directory, "registry.json"), "utf8"),
      );
      if (!isObject(value) || value.version !== 1 || !isObject(value.files))
        throw new Error("INVALID_REGISTRY");
      this.registry = value as unknown as Registry;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        // Preserve the invalid index; the independently checksummed journals remain authoritative.
        await fs
          .copyFile(
            path.join(this.directory, "registry.json"),
            path.join(this.directory, `registry-invalid-${Date.now()}.json`),
          )
          .catch(() => {});
        console.error(
          "[collaboration] rebuilding shared index from durable journals",
        );
      }
    }
    const folders = await fs
      .readdir(path.join(this.directory, "documents"), { withFileTypes: true })
      .catch(() => []);
    const recoveredEpochs = new Map<string, number>();
    let repaired = false;
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const retired = this.registry.retiredJournals?.includes(folder.name)
        || await fs.access(path.join(this.directory, "documents", folder.name, "retired.json")).then(() => true, () => false);
      if (retired) {
        for (const [fileId, entry] of Object.entries(this.registry.files)) {
          if ((entry.journalDirectory ?? entry.sharedDocumentId) === folder.name) {
            delete this.registry.files[fileId];
            repaired = true;
          }
        }
        continue;
      }
      try {
        const recovered = await SharedDocumentJournal.open(
          path.join(this.directory, "documents", folder.name),
        );
        const { binding } = recovered;
        const previous = this.registry.files[binding.localFileId];
        const previousEpoch = recoveredEpochs.get(binding.localFileId);
        if (!previous || (previousEpoch !== undefined && binding.epoch > previousEpoch)) {
          const intent = binding.epoch === 1
            ? await fs.readFile(path.join(this.directory, `initialize-${binding.localFileId}.json`), "utf8").then((raw) => JSON.parse(raw) as { operationId: string }).catch(() => null)
            : null;
          this.registry.files[binding.localFileId] = {
            sharedDocumentId: binding.sharedDocumentId,
            actorId: this.auth?.user()?.id ?? "recovery",
            role: "viewer",
            initialized: !intent,
            operationId: intent?.operationId ?? randomUUID(),
            journalDirectory: folder.name,
          };
          recoveredEpochs.set(binding.localFileId, binding.epoch);
          repaired = true;
        }
        recovered.document.destroy();
      } catch {
        /* The normal session open below reports corrupt registered journals. */
      }
    }
    if (repaired) await this.saveRegistry();
    for (const [fileId, entry] of Object.entries(this.registry.files)) {
      try {
        if (
          !/^[A-Za-z0-9_-]+$/.test(
            entry.journalDirectory ?? entry.sharedDocumentId,
          )
        )
          throw new Error("INVALID_BINDING");
        const journal = await SharedDocumentJournal.open(
          path.join(
            this.directory,
            "documents",
            entry.journalDirectory ?? entry.sharedDocumentId,
          ),
        );
        this.sessions.set(fileId, {
          journal,
          role: entry.role,
          status:
            this.auth?.user()?.id === entry.actorId
              ? "offline"
              : "permission-error",
          assets: {},
          tail: Promise.resolve(),
        });
        await this.loadAssets(fileId, false);
        await this.recoverPendingAssets(fileId);
      } catch {
        console.error(
          "[collaboration] local shared session unavailable; original data retained",
        );
      }
    }
    if (this.auth) {
      this.retry = setInterval(() => {
        if (this.auth?.user())
          for (const [fileId, session] of this.sessions)
            if (this.needsRetry(fileId, session))
              void this.flush(fileId, true).catch(() => {});
      }, 5000);
      this.retry.unref();
    }
  }
  private needsRetry(fileId: string, session: Session): boolean {
    const entry = this.registry.files[fileId];
    if (session.stopped || session.failed || entry.staged || entry.actorId !== this.auth?.user()?.id) return false;
    if (!entry.initialized || session.journal.outbox().length ||
      (session.pendingAssetRevision ?? 0) !== (session.uploadedAssetRevision ?? 0)) return true;
    // Closed clean documents are refreshed when opened. The live socket carries
    // edits; a slower reconciliation also detects missed delivery and revocation.
    return Boolean(session.viewing && (
      session.socket?.readyState !== WebSocket.OPEN ||
      Date.now() - (session.lastSynchronizedAt ?? 0) >= 60_000
    ));
  }
  private async recoverPendingAssets(fileId: string): Promise<void> {
    const session = this.require(fileId);
    const folder = path.join(this.directory, "assets", session.journal.binding.sharedDocumentId);
    const files = await fs.readdir(folder).catch(() => []);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const cached = JSON.parse(await fs.readFile(path.join(folder, file), "utf8")) as { uploaded: boolean };
      if (!cached.uploaded) { session.pendingAssetRevision = 1; break; }
    }
  }
  has(fileId: string): boolean {
    return Boolean(this.registry.files[fileId]);
  }
  withApproverInWindow<T>(windowId: number, run: () => Promise<T>): Promise<T> {
    return this.approverWindow.run(windowId, run);
  }
  isShared(fileId: string): boolean {
    return this.has(fileId);
  }
  project(fileId: string): SigmaDocument | undefined {
    const session = this.sessions.get(fileId);
    if (!session && this.has(fileId))
      throw new Error("SHARED_SESSION_UNAVAILABLE");
    return session
      ? parseSigmaDocument(session.journal.document.project())
      : undefined;
  }
  async boundarySave(
    fileId: string,
    document: SigmaDocument,
  ): Promise<{ ok: boolean; revision?: number; error?: string }> {
    const session = this.require(fileId);
    await session.tail;
    await session.journal.flush();
    // A legacy JSON save is never promoted into a CRDT mutation.
    if (!areSigmaDocumentsEquivalent(document, this.project(fileId)!))
      return { ok: false, error: "SHARED_SESSION_WRITE_REQUIRED" };
    return { ok: true, revision: 1 };
  }
  async info(): Promise<CollaborationInfo> {
    const user = this.auth?.user() ?? null;
    return {
      configured: Boolean(this.auth),
      user: user ? {
        actorId: user.id,
        ...(user.email ? { email: user.email } : {}),
        ...(user.displayName ? { displayName: user.displayName } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      } : null,
      sessions: user
        ? [...this.sessions.keys()]
            .filter((id) => this.registry.files[id].actorId === user.id)
            .map((id) => this.describe(id))
        : [],
      restrictedFileIds: [...this.sessions.keys()],
    };
  }
  describe(fileId: string): SessionInfo {
    const session = this.require(fileId);
    return {
      binding: session.journal.binding,
      state: toBase64(session.journal.document.snapshot()),
      role: session.role,
      status: session.status,
      actorId: this.registry.files[fileId].actorId,
      assets: { ...session.assets },
    };
  }
  async start(fileId: string, document: SigmaDocument): Promise<SessionInfo> {
    if (!this.auth?.user()) throw new Error("AUTH_REQUIRED");
    if (this.has(fileId)) {
      await this.flush(fileId, true);
      return this.describe(fileId);
    }
    const local = await this.local.loadDocument(fileId);
    if (!local || local.docId !== document.docId)
      throw new Error("INVALID_DOCUMENT");
    const intentPath = path.join(this.directory, `initialize-${fileId}.json`);
    let operationId: string;
    try {
      operationId = (
        JSON.parse(await fs.readFile(intentPath, "utf8")) as {
          operationId: string;
        }
      ).operationId;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
      operationId = randomUUID();
      await durableWrite(intentPath, JSON.stringify({ operationId }));
    }
    const created = await this.request<{ id: string; epoch: number }>(
      "/documents",
      { operationId },
    );
    const directory = path.join(this.directory, "documents", created.id);
    let journal: SharedDocumentJournal;
    try {
      journal = await SharedDocumentJournal.open(directory);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
      const shared = new SharedDocument();
      const normalized = await this.prepareInitialAssets(created.id, document);
      shared.initialize(JSON.parse(JSON.stringify(normalized)) as ObjectValue, {
        sharedDocumentId: created.id,
        epoch: created.epoch,
      });
      const binding = {
        localFileId: fileId,
        docId: document.docId,
        sharedDocumentId: created.id,
        epoch: created.epoch,
        protocol: 1 as const,
      };
      journal = await SharedDocumentJournal.create(directory, binding, shared);
    }
    if (
      journal.binding.localFileId !== fileId ||
      journal.binding.docId !== document.docId
    )
      throw new Error("SESSION_IDENTITY_MISMATCH");
    await durableWrite(
      path.join(directory, "initial-state.txt"),
      toBase64(journal.document.snapshot()),
    );
    this.registry.files[fileId] = {
      sharedDocumentId: created.id,
      actorId: this.auth.user()!.id,
      role: "owner",
      operationId,
      initialized: false,
    };
    await this.saveRegistry();
    this.sessions.set(fileId, {
      journal,
      role: "owner",
      status: "syncing",
      tail: Promise.resolve(),
      assets: {},
      viewing: (this.viewedFileId === fileId || this.visibleFileIds.has(fileId)),
    });
    await this.loadAssets(fileId, false);
    void this.flush(fileId, true).catch(() => {});
    return this.describe(fileId);
  }
  async retainLocal(fileId: string): Promise<void> {
    const entry = this.registry.files[fileId];
    if (!entry || entry.actorId !== this.actorId()) throw new Error("ACCOUNT_CHANGED");
    const session = this.require(fileId);
    await session.tail;
    await session.journal.compact();
    await this.loadAssets(fileId, false);
    const replace = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("sigma-doc-storage://")) {
        const source = session.assets[value.slice(20)];
        if (!source) throw new Error("MISSING_ASSET");
        return source;
      }
      if (Array.isArray(value)) return value.map(replace);
      if (!isObject(value)) return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    };
    const document = parseSigmaDocument(replace(this.project(fileId)!));
    await this.local.withLocalLibrary(async () => {
      const file = (await this.local.listFiles()).find(file => file.fileId === fileId);
      if (!file) throw new Error("LOCAL_SOURCE_MISSING");
      const saved = await this.local.saveDocument(fileId, document, { expectedRevision: file.revision });
      if (!saved.ok) throw new Error(saved.error ?? "LOCAL_SAVE_FAILED");
    });
    // Keep the receipt with its retired journal, but never reuse it for a new share.
    const intentPath = path.join(this.directory, `initialize-${fileId}.json`);
    const intent = await fs.readFile(intentPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (intent !== null) {
      await durableWrite(path.join(this.directory, "documents", entry.journalDirectory ?? entry.sharedDocumentId, "retired-initialize.json"), intent);
      await fs.rm(intentPath);
    }
    await durableWrite(path.join(this.directory, "documents", entry.journalDirectory ?? entry.sharedDocumentId, "retired.json"), JSON.stringify({ localFileId: fileId }));
    this.registry.retiredJournals = [...(this.registry.retiredJournals ?? []), entry.journalDirectory ?? entry.sharedDocumentId];
    delete this.registry.files[fileId];
    await this.saveRegistry();
    session.stopped = true;
    session.socket?.close();
    this.sessions.delete(fileId);
  }
  actorId(): string | null { return this.auth?.user()?.id ?? null; }
  bindings(): { fileId: string; sharedDocumentId: string; actorId: string; docId?: string }[] {
    return Object.entries(this.registry.files).map(([fileId, entry]) => ({ fileId, sharedDocumentId: entry.sharedDocumentId, actorId: entry.actorId, docId: this.sessions.get(fileId)?.journal.binding.docId }));
  }
  restrictCatalog(allowed: Map<string, MemberRole>): void {
    for (const [fileId, session] of this.sessions) {
      const entry = this.registry.files[fileId];
      if (entry.actorId !== this.actorId()) { session.socket?.close(); this.status(fileId, "permission-error"); continue; }
      const role = allowed.get(entry.sharedDocumentId);
      if (!role) { session.socket?.close(); this.status(fileId, "permission-error"); }
      else { session.role = role; if (session.status === "permission-error") this.status(fileId, "offline"); }
    }
  }
  async initializeCatalogDocument(fileId: string, sharedDocumentId: string, operationId: string, document: SigmaDocument, staged = false): Promise<void> {
    const actorId = this.actorId();
    if (!actorId) throw new Error("AUTH_REQUIRED");
    if (this.has(fileId)) {
      if (this.registry.files[fileId].actorId !== actorId || this.registry.files[fileId].sharedDocumentId !== sharedDocumentId) throw new Error("SESSION_IDENTITY_MISMATCH");
      return;
    }
    const directory = path.join(this.directory, "documents", sharedDocumentId);
    let journal: SharedDocumentJournal;
    try { journal = await SharedDocumentJournal.open(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const normalized = await this.prepareInitialAssets(sharedDocumentId, document);
      const shared = new SharedDocument();
      shared.initialize(JSON.parse(JSON.stringify(normalized)) as ObjectValue, { sharedDocumentId, epoch: 1 });
      journal = await SharedDocumentJournal.create(directory, { localFileId: fileId, docId: document.docId, sharedDocumentId, epoch: 1, protocol: 1 }, shared);
    }
    if (journal.binding.localFileId !== fileId || journal.binding.docId !== document.docId) throw new Error("SESSION_IDENTITY_MISMATCH");
    const initialPath = path.join(directory, "initial-state.txt");
    try { await fs.access(initialPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await durableWrite(initialPath, toBase64(journal.document.snapshot()));
    }
    if (actorId !== this.actorId()) throw new Error("ACCOUNT_CHANGED");
    this.registry.files[fileId] = { sharedDocumentId, actorId, role: "editor", operationId, initialized: false, staged };
    await this.saveRegistry();
    this.sessions.set(fileId, { journal, role: "editor", status: "syncing", tail: Promise.resolve(), assets: {}, viewing: (this.viewedFileId === fileId || this.visibleFileIds.has(fileId)) });
    await this.loadAssets(fileId, false);
  }
  async activateCatalogDocuments(fileIds: string[]): Promise<void> {
    for (const fileId of fileIds) {
      const entry = this.registry.files[fileId];
      if (!entry || entry.actorId !== this.actorId()) throw new Error("ACCOUNT_CHANGED");
      entry.staged = false;
    }
    await this.saveRegistry();
    for (const fileId of fileIds) await this.flush(fileId, true);
  }
  async openCatalogDocument(fileId: string, sharedDocumentId: string): Promise<SigmaDocument> {
    const actorId = this.actorId();
    if (!actorId) throw new Error("AUTH_REQUIRED");
    if (this.has(fileId)) {
      if (this.registry.files[fileId].actorId !== actorId) throw new Error("ACCOUNT_CHANGED");
      if (this.registry.files[fileId].sharedDocumentId !== sharedDocumentId) throw new Error("SESSION_IDENTITY_MISMATCH");
      const session = this.require(fileId);
      if (session.status === "permission-error") throw new Error("READ_ONLY");
      return this.project(fileId)!;
    }
    const snapshot = await this.request<{ state: string; role: MemberRole; epoch: number }>(`/documents/${sharedDocumentId}/snapshot`);
    if (actorId !== this.actorId()) throw new Error("ACCOUNT_CHANGED");
    const journalDirectory = `${sharedDocumentId}-${actorId}-epoch-${snapshot.epoch}`;
    const directory = path.join(this.directory, "documents", journalDirectory);
    let journal: SharedDocumentJournal;
    try { journal = await SharedDocumentJournal.open(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const shared = new SharedDocument(fromBase64(snapshot.state, MAX_DOCUMENT_BYTES));
      const document = parseSigmaDocument(shared.project());
      journal = await SharedDocumentJournal.create(directory, { localFileId: fileId, docId: document.docId, sharedDocumentId, epoch: snapshot.epoch, protocol: 1 }, shared);
    }
    if (journal.binding.localFileId !== fileId) throw new Error("SESSION_IDENTITY_MISMATCH");
    this.registry.files[fileId] = { sharedDocumentId, actorId, role: snapshot.role, operationId: randomUUID(), initialized: true, journalDirectory };
    await this.saveRegistry();
    this.sessions.set(fileId, { journal, role: snapshot.role, status: "syncing", tail: Promise.resolve(), assets: {}, viewing: (this.viewedFileId === fileId || this.visibleFileIds.has(fileId)) });
    await this.loadAssets(fileId, true);
    await this.flush(fileId, true);
    this.emit({ type: "reset", fileId });
    return this.project(fileId)!;
  }
  async join(token: string): Promise<{ fileId: string }> {
    const { sharedDocumentId } = await this.request<{
      sharedDocumentId: string;
    }>("/invitations/accept", { token });
    const existing = Object.entries(this.registry.files).find(
      ([, value]) => value.sharedDocumentId === sharedDocumentId,
    );
    if (existing) return { fileId: existing[0] };
    const snapshot = await this.request<{
      state: string;
      role: MemberRole;
      epoch: number;
    }>(`/documents/${sharedDocumentId}/snapshot`);
    const journalDirectory = snapshot.epoch === 1 ? sharedDocumentId : `${sharedDocumentId}-epoch-${snapshot.epoch}`;
    const directory = path.join(this.directory, "documents", journalDirectory);
    let journal: SharedDocumentJournal;
    try {
      // A previous attempt may have saved the journal before the index write failed.
      journal = await SharedDocumentJournal.open(directory);
      if (journal.binding.sharedDocumentId !== sharedDocumentId || journal.binding.epoch !== snapshot.epoch)
        throw new Error("SESSION_IDENTITY_MISMATCH");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const document = new SharedDocument(fromBase64(snapshot.state, MAX_DOCUMENT_BYTES));
      const projected = parseSigmaDocument(document.project());
      const created = await this.local.createFileFromDocument({ document: projected });
      if (!created.file) throw new Error("LOCAL_SAVE_FAILED");
      journal = await SharedDocumentJournal.create(directory, {
        localFileId: created.file.fileId,
        docId: projected.docId,
        sharedDocumentId,
        epoch: snapshot.epoch,
        protocol: 1,
      }, document);
    }
    const fileId = journal.binding.localFileId;
    this.registry.files[fileId] = {
      sharedDocumentId,
      actorId: this.auth!.user()!.id,
      role: snapshot.role,
      operationId: randomUUID(),
      initialized: true,
      journalDirectory,
    };
    await this.saveRegistry();
    this.sessions.set(fileId, {
      journal,
      role: snapshot.role,
      status: "syncing",
      tail: Promise.resolve(),
      assets: {},
      viewing: (this.viewedFileId === fileId || this.visibleFileIds.has(fileId)),
    });
    await this.loadAssets(fileId, true);
    await this.flush(fileId, true);
    return { fileId };
  }
  update(
    fileId: string,
    encoded: string,
    operationId: string,
    kind: "manual" | "undo" | "redo",
    epoch: number,
  ): Promise<void> {
    const session = this.require(fileId);
    return this.serial(session, async () => {
      if (epoch !== session.journal.binding.epoch || this.sessions.get(fileId) !== session)
        throw new Error("EPOCH_CHANGED");
      if (
        session.role === "viewer" ||
        session.stopped ||
        session.failed ||
        session.status === "permission-error" ||
        session.status === "epoch-error"
      )
        throw new Error("READ_ONLY");
      this.status(fileId, "local-saving");
      try {
        const update = fromBase64(encoded);
        const candidate = session.journal.document.prepareUpdate(
          update,
          (document) => {
            parseSigmaDocument(document);
          },
        );
        candidate.destroy();
        const identity: OperationIdentity = {
          operationId,
          actorId: this.registry.files[fileId].actorId,
          kind,
        };
        await session.journal.append(update, identity, true);
        this.emit({ type: "update", fileId, epoch: session.journal.binding.epoch, update: encoded, identity });
        this.status(fileId, "local-saved");
        void this.flush(fileId, true).catch(() => {});
      } catch (error) {
        session.failed = true;
        this.status(fileId, "save-error");
        throw error;
      }
    });
  }
  async flush(fileId: string, online = false): Promise<void> {
    const session = this.require(fileId);
    if (session.failed) throw new Error("LOCAL_SAVE_FAILED");
    if (!online) {
      await session.tail;
      await session.journal.flush();
      return;
    }
    if (session.stopped) throw new Error("DOCUMENT_UNAVAILABLE");
    if (session.syncing) return session.syncing;
    session.syncing = this.synchronize(fileId)
      .catch((error) => {
        this.status(
          fileId,
          /EPOCH/.test(String(error))
            ? "epoch-error"
            : /ACCESS|MEMBERSHIP|READ_ONLY|UNAVAILABLE|AUTH_REQUIRED/.test(
                  String(error),
                )
              ? "permission-error"
              : "offline",
        );
        throw error;
      })
      .finally(() => {
        session.syncing = undefined;
      });
    return session.syncing;
  }
  private async synchronize(fileId: string): Promise<void> {
    const session = this.require(fileId);
    const entry = this.registry.files[fileId];
    if (!this.auth?.user() || this.auth.user()!.id !== entry.actorId)
      throw new Error("AUTH_REQUIRED");
    const prefix = `/documents/${entry.sharedDocumentId}`;
    if (session.status !== "saved" || session.journal.outbox().length)
      this.status(fileId, "syncing");
    await session.tail;
    await this.uploadCachedAssets(fileId);
    if (!entry.initialized) {
      const initialFile = path.join(
        session.journal.directory,
        "initial-state.txt",
      );
      let state: string;
      try {
        state = await fs.readFile(initialFile, "utf8");
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        state = toBase64(session.journal.document.snapshot());
        await durableWrite(initialFile, state);
      }
      await this.request(`${prefix}/initialize`, {
        operationId: entry.operationId,
        state,
      });
      entry.initialized = true;
      await this.saveRegistry();
    }
    if (session.viewing && !entry.staged) await this.connect(fileId);
    const result = await this.request<{ update: string; role: MemberRole }>(
      `${prefix}/sync`,
      {
        protocol: 1,
        epoch: session.journal.binding.epoch,
        vector: toBase64(session.journal.document.vector()),
      },
    );
    session.role = result.role;
    if (entry.role !== result.role) {
      entry.role = result.role;
      await this.saveRegistry();
    }
    await this.receive(fileId, result.update, {
      operationId: randomUUID(),
      actorId: "remote",
      kind: "manual",
    });
    if (session.role === "viewer" && session.journal.outbox().length)
      throw new Error("READ_ONLY");
    while (session.journal.outbox().length) {
      let size = 0;
      const pending = session.journal
        .outbox()
        .slice(0, 32)
        .filter((item) => {
          size += item.update.length + 256;
          return size < MAX_UPDATE_BYTES * 1.4;
        });
      if (!pending.length) throw new Error("PAYLOAD_LIMIT");
      const result = await this.request<{
        acks: { operationId: string; seq: number }[];
      }>(`${prefix}/updates`, {
        protocol: 1,
        epoch: session.journal.binding.epoch,
        operations: pending.map((item) => ({
          ...item.identity,
          update: item.update,
        })),
      });
      if (!Array.isArray(result.acks) || result.acks.length !== pending.length)
        throw new Error("INVALID_ACK");
      for (let index = 0; index < pending.length; index++) {
        const ack = result.acks[index];
        if (
          ack.operationId !== pending[index].identity.operationId ||
          !Number.isSafeInteger(ack.seq)
        )
          throw new Error("INVALID_ACK");
        await session.journal.acknowledge(ack.operationId);
      }
    }
    await this.loadAssets(fileId, true);
    session.lastSynchronizedAt = Date.now();
    this.status(
      fileId,
      session.journal.outbox().length ? "local-saved" : "saved",
    );
  }
  private async receive(
    fileId: string,
    encoded: string,
    identity: OperationIdentity,
  ): Promise<void> {
    const session = this.require(fileId);
    await this.serial(session, async () => {
      const update = fromBase64(encoded, MAX_DOCUMENT_BYTES);
      // Snapshots/differences may be larger than a single outbound edit.
      const candidate = new SharedDocument(session.journal.document.snapshot());
      try {
        candidate.applyUpdate(update);
        parseSigmaDocument(candidate.project());
      } finally {
        candidate.destroy();
      }
      if (update.length <= 2) return;
      await session.journal.append(update, identity, false);
      let approvalIds: string[] | undefined;
      if (identity.kind === "ai" && identity.actorId === this.registry.files[fileId].actorId && /^[0-9a-f-]{36}$/i.test(identity.operationId)) {
        try { approvalIds = JSON.parse(await fs.readFile(path.join(session.journal.directory, `approval-${identity.operationId}.json`), "utf8")) as string[]; } catch { /* A different local window may not own this private proposal. */ }
      }
      this.emit({ type: "update", fileId, epoch: session.journal.binding.epoch, update: encoded, identity, approvalIds }, this.approvalWindows.get(identity.operationId));
    });
  }
  private async connect(fileId: string): Promise<void> {
    const session = this.require(fileId);
    if (
      session.socket?.readyState === WebSocket.OPEN ||
      session.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    if (!session.viewing) return;
    const generation = (session.connectionGeneration ?? 0) + 1;
    session.connectionGeneration = generation;
    const url = new URL(
      `/documents/${session.journal.binding.sharedDocumentId}/socket`,
      this.auth!.config.apiUrl,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const authorization = await this.auth!.authorization();
    if (
      this.sessions.get(fileId) !== session ||
      !session.viewing ||
      session.connectionGeneration !== generation
    ) return;
    const socket = new WebSocket(url, {
      headers: { Authorization: authorization },
      maxPayload: MAX_DOCUMENT_BYTES * 1.4,
      handshakeTimeout: 10_000,
    });
    session.socket = socket;
    socket.on("message", (data) => {
      if (this.sessions.get(fileId) !== session || session.stopped || session.socket !== socket) return;
      try {
        const event = JSON.parse(data.toString()) as {
          type: string;
          update?: string;
          identity?: OperationIdentity;
          role?: MemberRole;
          epoch?: number;
          clientId?: string;
          ownClientId?: string;
          participants?: PresenceParticipant[];
          state?: unknown;
        };
        if (event.type === "update" && event.update && event.identity)
          void this.receive(fileId, event.update, event.identity).catch(() =>
            this.status(fileId, "save-error"),
          );
        if (event.type === "role" && event.role) {
          session.role = event.role;
          if (this.registry.files[fileId].role !== event.role) {
            this.registry.files[fileId].role = event.role;
            void this.saveRegistry().catch(() =>
              this.status(fileId, "save-error"),
            );
          }
          this.status(fileId, session.status);
        }
        if (
          event.type === "roster" &&
          session.viewing &&
          typeof event.ownClientId === "string" && /^[0-9a-f-]{36}$/i.test(event.ownClientId) &&
          Array.isArray(event.participants)
        ) {
          session.clientId = event.ownClientId;
          this.emit({
            type: "roster",
            fileId,
            ownClientId: event.ownClientId,
            participants: event.participants.filter(isPresenceParticipant),
          });
        }
      } catch {
        socket.close(1002);
      }
    });
    socket.on("error", () => {
      if (this.sessions.get(fileId) === session && !session.stopped && session.socket === socket) this.status(fileId, "offline");
    });
    socket.on("close", (code) => {
      if (this.sessions.get(fileId) === session && !session.stopped && session.socket === socket) {
        session.socket = undefined;
        if (session.clientId) this.emit({ type: "roster", fileId, ownClientId: session.clientId, participants: [] });
        this.status(
          fileId,
          code === 4409
            ? "epoch-error"
            : code === 4403
              ? "permission-error"
              : "offline",
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  }
  async approve(fileId: string, approval: SharedApproval, approvalIds?: string[]): Promise<{ seq: number }> {
    const session = this.require(fileId);
    await this.flush(fileId, true);
    if (approvalIds) {
      const windowId = this.approverWindow.getStore();
      if (windowId !== undefined) this.approvalWindows.set(approval.operationId, windowId);
      await durableWrite(path.join(session.journal.directory, `approval-${approval.operationId}.json`), JSON.stringify(approvalIds));
    }
    // AI images follow the same immutable asset path. Stable hashes make retries identical.
    const prepared = await this.prepareInitialAssets(
      session.journal.binding.sharedDocumentId,
      approval,
    );
    const result = await this.request<{ update: string; operationId: string; seq: number }>(
      `/documents/${session.journal.binding.sharedDocumentId}/approve`,
      { ...prepared, protocol: 1, epoch: session.journal.binding.epoch },
    );
    await this.receive(fileId, result.update, {
      operationId: result.operationId,
      actorId: this.registry.files[fileId].actorId,
      kind: "ai",
    });
    return { seq: result.seq };
  }
  async action<T>(fileId: string, action: string, body?: unknown): Promise<T> {
    if (this.registry.files[fileId]?.actorId !== this.actorId()) throw new Error("ACCOUNT_CHANGED");
    return this.request<T>(
      `/documents/${this.require(fileId).journal.binding.sharedDocumentId}/${action}`,
      body,
    );
  }
  async signOut(): Promise<void> {
    await this.auth?.signOut();
    for (const [fileId, session] of this.sessions) {
      session.socket?.close();
      session.viewing = false;
      this.status(fileId, "permission-error");
    }
  }
  async backup(fileId: string): Promise<void> {
    await this.flush(fileId, true);
    await this.action(fileId, "backups", {});
  }
  async restore(fileId: string, backupId: string): Promise<void> {
    const session = this.require(fileId);
    const intent = path.join(
      session.journal.directory,
      `restore-${backupId}.json`,
    );
    let operationId: string;
    try {
      operationId = (
        JSON.parse(await fs.readFile(intent, "utf8")) as { operationId: string }
      ).operationId;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
      await this.flush(fileId, true);
      operationId = randomUUID();
      await durableWrite(intent, JSON.stringify({ operationId }));
    }
    await this.action(fileId, "restore", { backupId, operationId });
    await this.reload(fileId);
  }
  async reload(fileId: string): Promise<void> {
    const previous = this.require(fileId);
    await previous.syncing?.catch(() => {});
    await previous.tail;
    const snapshot = await this.action<{
      state: string;
      role: MemberRole;
      epoch: number;
    }>(fileId, "snapshot");
    if (snapshot.epoch === previous.journal.binding.epoch) {
      await this.flush(fileId, true);
      return;
    }
    const shared = new SharedDocument(
      fromBase64(snapshot.state, MAX_DOCUMENT_BYTES),
    );
    const binding = { ...previous.journal.binding, epoch: snapshot.epoch };
    if (
      shared.identity().sharedDocumentId !== binding.sharedDocumentId ||
      shared.identity().epoch !== binding.epoch
    )
      throw new Error("SESSION_IDENTITY_MISMATCH");
    const journalDirectory = `${binding.sharedDocumentId}-epoch-${binding.epoch}`;
    const directory = path.join(this.directory, "documents", journalDirectory);
    let journal: SharedDocumentJournal;
    try {
      journal = await SharedDocumentJournal.create(directory, binding, shared);
    } catch (error) {
      if (String(error).includes("SESSION_EXISTS")) {
        shared.destroy();
        journal = await SharedDocumentJournal.open(directory);
      } else throw error;
    }
    // The old epoch, including unsent edits, remains on disk for explicit local recovery.
    await previous.journal.compact();
    const entry = this.registry.files[fileId];
    this.registry.files[fileId] = {
      ...entry,
      journalDirectory,
      role: snapshot.role,
      initialized: true,
    };
    await this.saveRegistry();
    previous.stopped = true;
    previous.socket?.close();
    this.sessions.set(fileId, {
      journal,
      role: snapshot.role,
      status: "syncing",
      tail: Promise.resolve(),
      assets: previous.assets,
      viewing: previous.viewing,
    });
    this.emit({ type: "reset", fileId });
    await this.flush(fileId, true);
  }
  async presence(fileId: string, state: PresenceState | null): Promise<void> {
    const session = this.require(fileId);
    if (!session.viewing) return;
    if (session.socket?.readyState !== WebSocket.OPEN)
      await this.connect(fileId).catch(() => this.status(fileId, "offline"));
    const socket = session.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({ type: "awareness", state });
      if (session.presenceSocket === socket && session.presencePayload === payload) {
        // Protocol control frames keep transport alive without waking a
        // hibernating Durable Object or rebroadcasting unchanged awareness.
        socket.ping();
      } else {
        socket.send(payload);
        session.presenceSocket = socket;
        session.presencePayload = payload;
      }
    }
  }
  async visibleFiles(fileIds: string[]): Promise<void> {
    const added = fileIds.filter((id) => !this.visibleFileIds.has(id));
    this.visibleFileIds = new Set(fileIds);
    await this.view(this.viewedFileId);
    await Promise.all(added.filter((id) => id !== this.viewedFileId && this.sessions.get(id)?.viewing)
      .map((id) => this.flush(id, true).catch(() => {})));
  }
  async view(fileId: string | null): Promise<void> {
    this.viewedFileId = fileId;
    for (const [id, session] of this.sessions) {
      const active = (id === fileId || this.visibleFileIds.has(id)) && this.registry.files[id].actorId === this.auth?.user()?.id;
      if (session.viewing === active) continue;
      session.viewing = active;
      if (!active) {
        session.connectionGeneration = (session.connectionGeneration ?? 0) + 1;
        session.socket?.close(1000, "VIEW_CHANGED");
        session.socket = undefined;
      }
    }
    if (fileId) {
      const session = this.sessions.get(fileId);
      if (session?.viewing) {
        await session.syncing?.catch(() => {});
        await this.flush(fileId, true).catch(() => {});
      }
    }
  }
  async end(
    fileId: string,
    action: "stop" | "delete" | "leave",
  ): Promise<void> {
    await this.action(fileId, action, {});
    const session = this.require(fileId);
    session.stopped = true;
    session.socket?.close();
    this.status(fileId, "permission-error");
  }
  async copy(fileId: string): Promise<{ fileId: string }> {
    const result = await this.duplicate(fileId);
    if (!result.file) throw new Error("LOCAL_SAVE_FAILED");
    return { fileId: result.file.fileId };
  }
  async duplicate(
    fileId: string,
  ): ReturnType<LocalSigmaDocStore["createFileFromDocument"]> {
    await this.loadAssets(fileId, true);
    const session = this.require(fileId);
    const document = this.project(fileId)!;
    const replace = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(replace);
      if (!isObject(value)) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          key === "src" &&
          typeof child === "string" &&
          child.startsWith("sigma-doc-storage://")
            ? (session.assets[child.slice(20)] ??
              (() => {
                throw new Error("MISSING_ASSET");
              })())
            : replace(child),
        ]),
      );
    };
    const local = parseSigmaDocument(replace(document));
    local.docId = `doc_${randomUUID()}`;
    return this.local.createFileFromDocument({ document: local });
  }
  async asset(
    fileId: string,
    assetId: string,
    source?: string,
    download = true,
  ): Promise<string> {
    const session = this.require(fileId);
    if (download && this.registry.files[fileId]?.actorId !== this.actorId()) throw new Error("ACCOUNT_CHANGED");
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(assetId))
      throw new Error("INVALID_ASSET");
    const folder = path.join(
      this.directory,
      "assets",
      session.journal.binding.sharedDocumentId,
    );
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    if (source !== undefined) {
      if (session.role === "viewer") throw new Error("READ_ONLY");
      this.parseImage(source);
      try {
        const existing = JSON.parse(
          await fs.readFile(path.join(folder, `${assetId}.json`), "utf8"),
        ) as { source: string };
        if (existing.source !== source) throw new Error("IMMUTABLE_ASSET");
        return existing.source;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      await durableWrite(
        path.join(folder, `${assetId}.json`),
        JSON.stringify({ source, uploaded: false }),
      );
      session.pendingAssetRevision = (session.pendingAssetRevision ?? 0) + 1;
      session.assets[assetId] = source;
      return source;
    }
    if (session.assets[assetId]) return session.assets[assetId];
    try {
      const cached = JSON.parse(
        await fs.readFile(path.join(folder, `${assetId}.json`), "utf8"),
      ) as { source: string };
      session.assets[assetId] = cached.source;
      return cached.source;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    if (!download) throw new Error("MISSING_ASSET");
    const response = await this.requestRaw(
      `/documents/${session.journal.binding.sharedDocumentId}/assets/${assetId}`,
    );
    const type = response.headers.get("Content-Type");
    const value = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    this.parseImage(value);
    await durableWrite(
      path.join(folder, `${assetId}.json`),
      JSON.stringify({ source: value, uploaded: true }),
    );
    session.assets[assetId] = value;
    this.emit({ type: "asset-ready", fileId, assetId });
    return value;
  }
  async assetResponse(source: string): Promise<Response> {
    const match = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})\/?(?:\?ready=\d+)?$/.exec(
      source,
    );
    if (!match) return new Response(null, { status: 404 });
    for (const [fileId, session] of this.sessions) {
      if (this.registry.files[fileId]?.actorId !== this.actorId() || session.status === "permission-error") continue;
      if (
        !JSON.stringify(session.journal.document.project()).includes(
          `sigma-doc-storage://${match[1]}`,
        )
      )
        continue;
      try {
        const image = this.parseImage(await this.asset(fileId, match[1]));
        return new Response(image.bytes, {
          headers: {
            "Content-Type": image.type,
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    return new Response(null, { status: 404 });
  }
  private async prepareInitialAssets<T>(
    sharedId: string,
    document: T,
  ): Promise<T> {
    const result = structuredClone(document);
    const visit = async (value: unknown): Promise<void> => {
      if (Array.isArray(value)) {
        for (const child of value) await visit(child);
        return;
      }
      if (!isObject(value)) return;
      if (
        value.type === "image" &&
        typeof value.id === "string" &&
        isObject(value.props) &&
        typeof value.props.src === "string"
      ) {
        const source = value.props.src;
        if (source.startsWith("sigma-doc-storage://")) return;
        if (!source.startsWith("data:"))
          throw new Error("ASSET_SOURCE_UNAVAILABLE");
        const image = this.parseImage(source);
        const assetId = createHash("sha256").update(image.bytes).digest("hex");
        await this.requestRaw(`/documents/${sharedId}/assets/${assetId}`, {
          method: "PUT",
          headers: { "Content-Type": image.type },
          body: image.bytes,
        });
        const folder = path.join(this.directory, "assets", sharedId);
        await fs.mkdir(folder, { recursive: true });
        await durableWrite(
          path.join(folder, `${assetId}.json`),
          JSON.stringify({ source, uploaded: true }),
        );
        value.props.src = `sigma-doc-storage://${assetId}`;
      }
      for (const child of Object.values(value)) await visit(child);
    };
    await visit(result);
    return result;
  }
  private async loadAssets(fileId: string, download: boolean): Promise<void> {
    const sources = JSON.stringify(
      this.require(fileId).journal.document.project(),
    ).matchAll(/sigma-doc-storage:\/\/([A-Za-z0-9_-]+)/g);
    for (const match of sources) {
      try {
        await this.asset(fileId, match[1], undefined, download);
      } catch (error) {
        if (download) throw error;
      }
    }
  }
  private async uploadCachedAssets(fileId: string): Promise<void> {
    const session = this.require(fileId);
    const revision = session.pendingAssetRevision ?? 0;
    const folder = path.join(
      this.directory,
      "assets",
      session.journal.binding.sharedDocumentId,
    );
    let files: string[];
    try {
      files = await fs.readdir(folder);
    } catch {
      return;
    }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const item = JSON.parse(
        await fs.readFile(path.join(folder, file), "utf8"),
      ) as { source: string; uploaded: boolean };
      if (item.uploaded) continue;
      const image = this.parseImage(item.source);
      await this.requestRaw(
        `/documents/${session.journal.binding.sharedDocumentId}/assets/${file.slice(0, -5)}`,
        {
          method: "PUT",
          headers: { "Content-Type": image.type },
          body: image.bytes,
        },
      );
      await durableWrite(
        path.join(folder, file),
        JSON.stringify({ ...item, uploaded: true }),
      );
    }
    session.uploadedAssetRevision = revision;
  }
  private parseImage(source: string): {
    type: string;
    bytes: Uint8Array<ArrayBuffer>;
  } {
    if (
      source.startsWith("data:image/svg+xml,") ||
      source.startsWith("data:image/svg+xml;charset=utf-8,")
    ) {
      const bytes = new TextEncoder().encode(
        decodeURIComponent(source.slice(source.indexOf(",") + 1)),
      );
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES)
        throw new Error("INVALID_ASSET");
      return { type: "image/svg+xml", bytes };
    }
    const match =
      /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
        source,
      );
    if (!match || source.length > MAX_ASSET_BYTES * 1.4)
      throw new Error("INVALID_ASSET");
    const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES)
      throw new Error("INVALID_ASSET");
    return { type: match[1], bytes };
  }
  private require(fileId: string): Session {
    const session = this.sessions.get(fileId);
    if (!session) throw new Error("SHARED_SESSION_REQUIRED");
    return session;
  }
  private serial<T>(session: Session, run: () => Promise<T>): Promise<T> {
    const result = session.tail.then(run);
    session.tail = result.catch(() => {});
    return result;
  }
  private status(fileId: string, status: SaveState): void {
    const session = this.require(fileId);
    session.status = session.failed ? "save-error" : status;
    this.emit({
      type: "status",
      fileId,
      status: session.status,
      role: session.role,
    });
  }
  private saveRegistry(): Promise<void> {
    const data = JSON.stringify(this.registry);
    const next = this.registryTail.then(() =>
      durableWrite(path.join(this.directory, "registry.json"), data),
    );
    this.registryTail = next.catch(() => {});
    return next;
  }
  private async requestRaw(
    route: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.auth) throw new Error("COLLABORATION_NOT_CONFIGURED");
    const response = await fetch(new URL(route, this.auth.config.apiUrl), {
      ...options,
      headers: {
        ...options.headers,
        Authorization: await this.auth.authorization(),
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(error.error ?? `HTTP_${response.status}`);
    }
    return response;
  }
  async request<T>(route: string, body?: unknown): Promise<T> {
    const response = await this.requestRaw(
      route,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return response.json() as Promise<T>;
  }
  async close(): Promise<void> {
    this.auth?.cancelSignIn();
    if (this.retry) clearInterval(this.retry);
    for (const session of this.sessions.values()) {
      session.socket?.close();
      await session.tail;
      await session.journal.compact();
    }
  }
}

function isPresenceParticipant(value: unknown): value is PresenceParticipant {
  if (!isObject(value) || !isObject(value.profile)) return false;
  const profile = value.profile as unknown as CollaborationProfile;
  return (
    typeof value.clientId === "string" && /^[0-9a-f-]{36}$/i.test(value.clientId) &&
    typeof value.actorId === "string" && /^[0-9a-f-]{36}$/i.test(value.actorId) &&
    ["owner", "admin", "editor", "viewer"].includes(String(value.role)) &&
    profile.actorId === value.actorId &&
    (value.state === null || isObject(value.state))
  );
}
