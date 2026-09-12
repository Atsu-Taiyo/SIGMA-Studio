import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensurePageLayout, type SigmaDocument } from "@/features/document";
import type { DesktopStorageChangeEvent } from "@/types/desktop";

import type { DocumentStorageChangeEvent } from "./document-lifecycle-types";
import { registerDocumentStorageSynchronization, type DocumentStorageSynchronizationOptions } from "./document-storage-sync";
import type { DegradedWatcherScope } from "./workspace-request";

const runtime = vi.hoisted(() => ({
  subscribe: vi.fn<(listener: (event: DesktopStorageChangeEvent) => void) => () => void>(),
  saveWorkspace: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/lib/runtime/app-runtime", () => ({ getAppRuntime: () => ({ library: { onChange: runtime.subscribe } }) }));
vi.mock("@/lib/storage", () => ({ saveWorkspaceState: runtime.saveWorkspace }));

const cleanups: Array<() => void> = [];
const releasePending: Array<() => void> = [];

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  releasePending.push(() => resolve(fallback));
  return { promise, resolve };
}

function documentWith(first = "元の段落", second = "次の段落"): SigmaDocument {
  return ensurePageLayout({
    version: "2.0", docId: "document-a", metadata: { title: "同期", styleUnits: { fontSize: "pt" } },
    content: [
      { type: "paragraph", id: "first", children: [{ type: "text", text: first }] },
      { type: "paragraph", id: "second", children: [{ type: "text", text: second }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
}

function setup() {
  let listener!: (event: DesktopStorageChangeEvent) => void;
  const unsubscribe = vi.fn();
  runtime.subscribe.mockImplementation((callback) => { listener = callback; return unsubscribe; });
  const order: string[] = [];
  let scopes: DegradedWatcherScope[] = [];
  const base = documentWith();
  const loaded = { document: documentWith("外部の段落"), observedRevision: 5 };
  const options: DocumentStorageSynchronizationOptions = {
    activeFileIdRef: { current: "file-a" }, documentRef: { current: base }, lastSyncedDocumentRef: { current: base },
    documentObservedRevisionRef: { current: 4 }, selectedIdRef: { current: "second" }, openFileIdsRef: { current: ["file-a"] },
    workspaceReadyRef: { current: true }, externalChangeFileIdsRef: { current: new Set() },
    pendingAutoAppliedProposalIdsByFileRef: { current: new Map() }, inFlightSavePromiseRef: { current: null },
    successfulDocumentSavesRef: { current: new Map() }, documentStorageChangeProcessorRef: { current: null },
    blockOperationPorts: { now: () => "2026-09-09T00:00:00.000Z", createId: (prefix) => `${prefix}-normalized` },
    refreshDocumentMetadatas: vi.fn(async () => { order.push("metadata"); }),
    refreshMcpEditProposals: vi.fn(async () => undefined),
    switchAwayFromDeletedFile: vi.fn(async () => { order.push("deleted"); }),
    loadWorkspaceDocument: vi.fn(async () => { order.push("load"); return loaded; }),
    isCurrentDocumentDirty: vi.fn(() => false),
    saveUnsavedEditBackup: vi.fn(async () => { order.push("backup"); return null; }),
    applyAutoApprovedExternalDocument: vi.fn((next) => {
      order.push("history"); options.documentRef.current = next.nextDocument;
      options.documentObservedRevisionRef.current = next.syncedRevision;
    }),
    applyMergedExternalDocument: vi.fn((next, _synced, revision) => {
      order.push("merge"); options.documentRef.current = next;
      options.documentObservedRevisionRef.current = revision;
    }),
    resetEditorDocument: vi.fn((next, _selection, revision) => {
      order.push("reset"); options.documentRef.current = next;
      options.documentObservedRevisionRef.current = revision ?? null;
    }),
    setOpenFileIds: vi.fn((ids) => { options.openFileIdsRef.current = ids; }),
    setActiveFileId: vi.fn((id) => { options.activeFileIdRef.current = id; }),
    setSaveState: vi.fn(), setStatusMessage: vi.fn(),
    setDegradedWatcherScopes: vi.fn((update) => { scopes = typeof update === "function" ? update(scopes) : update; }),
    dispatchDocumentStorageChange: vi.fn((event) => options.documentStorageChangeProcessorRef.current?.(event)),
    tEditor: ((key: string) => key) as DocumentStorageSynchronizationOptions["tEditor"],
  };
  const dispose = registerDocumentStorageSynchronization(options);
  cleanups.push(dispose);
  const change = (patch: Partial<DocumentStorageChangeEvent> = {}): DocumentStorageChangeEvent => ({
    type: "document", change: "changed", fileId: "file-a", timestamp: 1, ...patch,
  });
  const emit = (event = change()) => listener(event);
  const settled = async () => vi.waitFor(() => expect(options.externalChangeFileIdsRef.current.size).toBe(0));
  return { options, base, loaded, emit, change, settled, dispose, unsubscribe, order, scopes: () => scopes, listener: () => listener };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.saveWorkspace.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) dispose();
  for (const release of releasePending.splice(0)) release();
  await Promise.resolve();
});

describe("document storage synchronization", () => {
  it("routes workspace, proposals, and watcher health while respecting readiness", async () => {
    const h = setup();
    h.options.workspaceReadyRef.current = false;
    h.emit();
    expect(h.options.dispatchDocumentStorageChange).not.toHaveBeenCalled();
    h.options.workspaceReadyRef.current = true;
    h.listener()({ type: "workspace", timestamp: 1 });
    h.listener()({ type: "library", timestamp: 2 });
    h.listener()({ type: "mcpProposal", change: "changed", timestamp: 3 });
    h.listener()({ type: "watcher", scope: "documents", change: "failed", timestamp: 4 });
    expect(h.scopes()).toEqual(["documents"]);
    h.listener()({ type: "watcher", scope: "documents", change: "recovered", timestamp: 5 });
    h.listener()({ type: "documentVersion", fileId: "file-a", change: "captured", timestamp: 6 });
    expect(h.scopes()).toEqual([]);
    expect(h.options.refreshDocumentMetadatas).toHaveBeenCalledTimes(2);
    expect(h.options.refreshMcpEditProposals).toHaveBeenCalledTimes(1);
    expect(h.options.loadWorkspaceDocument).not.toHaveBeenCalled();
  });

  it("drains successive saves before reading and classifying the document", async () => {
    const h = setup();
    const first = deferred(undefined), second = deferred(undefined);
    const waitForFirst = vi.spyOn(first.promise, "catch");
    const waitForSecond = vi.spyOn(second.promise, "catch");
    h.options.inFlightSavePromiseRef.current = first.promise;
    h.emit();
    await vi.waitFor(() => expect(waitForFirst).toHaveBeenCalledOnce());
    expect(h.options.loadWorkspaceDocument).not.toHaveBeenCalled();
    h.options.inFlightSavePromiseRef.current = second.promise;
    first.resolve(undefined);
    // 2本目が未完了のまま待機されたことを確認する。単なる microtask 待ちは
    // ループが2本目を読む前に ref を空にでき、1回だけ待つ実装でも通ってしまう。
    await vi.waitFor(() => expect(waitForSecond).toHaveBeenCalledOnce());
    expect(h.options.loadWorkspaceDocument).not.toHaveBeenCalled();
    h.options.inFlightSavePromiseRef.current = null;
    second.resolve(undefined);
    await h.settled();
    expect(h.options.loadWorkspaceDocument).toHaveBeenCalledTimes(1);
    expect(h.options.documentRef.current).toEqual(h.loaded.document);
  });

  it.each(["dispose", "switch"] as const)("does not adopt after %s while loading", async (operation) => {
    const h = setup(), pending = deferred(h.loaded);
    vi.mocked(h.options.loadWorkspaceDocument).mockReturnValue(pending.promise);
    h.emit();
    await vi.waitFor(() => expect(h.options.loadWorkspaceDocument).toHaveBeenCalled());
    if (operation === "dispose") h.dispose();
    else h.options.activeFileIdRef.current = "file-b";
    pending.resolve(h.loaded);
    await h.settled();
    expect(h.options.documentRef.current).toBe(h.base);
    expect(h.options.resetEditorDocument).not.toHaveBeenCalled();
    expect(h.options.applyAutoApprovedExternalDocument).not.toHaveBeenCalled();
    expect(h.options.setSaveState).not.toHaveBeenCalled();
  });

  it("ignores an older notification without consuming the newer automation identities", async () => {
    const h = setup(), oldLoad = deferred(h.loaded), newLoad = deferred(h.loaded);
    vi.mocked(h.options.loadWorkspaceDocument).mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);
    h.options.pendingAutoAppliedProposalIdsByFileRef.current.set("file-a", ["p1"]);
    h.emit(h.change({ autoAppliedProposalIds: ["p1"] }));
    await vi.waitFor(() => expect(h.options.loadWorkspaceDocument).toHaveBeenCalledTimes(1));
    h.options.pendingAutoAppliedProposalIdsByFileRef.current.set("file-a", ["p1", "p2"]);
    h.emit(h.change({ timestamp: 2, autoAppliedProposalIds: ["p2"] }));
    await vi.waitFor(() => expect(h.options.loadWorkspaceDocument).toHaveBeenCalledTimes(2));
    oldLoad.resolve(h.loaded);
    await Promise.resolve();
    expect(h.options.pendingAutoAppliedProposalIdsByFileRef.current.get("file-a")).toEqual(["p1", "p2"]);
    newLoad.resolve(h.loaded);
    await vi.waitFor(() => expect(h.options.applyAutoApprovedExternalDocument).toHaveBeenCalledWith({
      nextDocument: h.loaded.document, syncedDocument: h.loaded.document, syncedRevision: 5, proposalIds: ["p1", "p2"],
    }));
    expect(h.options.pendingAutoAppliedProposalIdsByFileRef.current.has("file-a")).toBe(false);
    expect(h.options.saveUnsavedEditBackup).not.toHaveBeenCalled();
    expect(h.options.resetEditorDocument).not.toHaveBeenCalled();
  });

  it("retains the latest revision for a save echo without altering the current edit or history", async () => {
    const h = setup();
    h.options.documentRef.current = documentWith("保存後の入力");
    h.options.documentObservedRevisionRef.current = 7;
    h.options.successfulDocumentSavesRef.current.set("file-a", { fileId: "file-a", document: h.loaded.document, revision: 6, dirtyRevision: 1 });
    h.emit();
    await h.settled();
    expect(h.options.documentObservedRevisionRef.current).toBe(7);
    expect(h.options.lastSyncedDocumentRef.current).toEqual(h.loaded.document);
    expect(h.options.documentRef.current).toEqual(documentWith("保存後の入力"));
    expect(h.options.resetEditorDocument).not.toHaveBeenCalled();
    expect(h.options.applyMergedExternalDocument).not.toHaveBeenCalled();
  });

  it("accepts the disk revision even when it moves backwards for equivalent content", async () => {
    const h = setup();
    h.options.documentRef.current = { ...h.loaded.document, updatedAt: "2026-09-08T00:00:00.000Z" };
    h.options.documentObservedRevisionRef.current = 12;
    h.emit();
    await h.settled();
    expect(h.options.documentObservedRevisionRef.current).toBe(5);
    expect(h.options.lastSyncedDocumentRef.current).toEqual(h.loaded.document);
    expect(h.options.resetEditorDocument).not.toHaveBeenCalled();
  });

  it("merges an independent foreign edit without creating an undo entry or discarding local input", async () => {
    const h = setup();
    h.options.documentRef.current = documentWith("元の段落", "未保存の入力");
    vi.mocked(h.options.isCurrentDocumentDirty).mockReturnValue(true);
    h.emit();
    await h.settled();
    expect(h.options.documentRef.current).toEqual(documentWith("外部の段落", "未保存の入力"));
    expect(h.options.applyMergedExternalDocument).toHaveBeenCalledTimes(1);
    expect(h.options.applyAutoApprovedExternalDocument).not.toHaveBeenCalled();
    expect(h.options.resetEditorDocument).not.toHaveBeenCalled();
    expect(h.options.saveUnsavedEditBackup).not.toHaveBeenCalled();
  });

  it("backs up a conflicting foreign edit before resetting and saves both tab identities", async () => {
    const h = setup();
    h.options.documentRef.current = documentWith("競合する入力");
    vi.mocked(h.options.isCurrentDocumentDirty).mockReturnValue(true);
    vi.mocked(h.options.saveUnsavedEditBackup).mockImplementation(async () => { h.order.push("backup"); return { fileId: "backup-a" }; });
    h.emit();
    await h.settled();
    expect(h.order.indexOf("backup")).toBeLessThan(h.order.indexOf("reset"));
    expect(h.options.resetEditorDocument).toHaveBeenCalledWith(h.loaded.document, "second", 5);
    expect(runtime.saveWorkspace).toHaveBeenCalledWith({ openFileIds: ["file-a", "backup-a"], activeFileId: "file-a" });
    expect(h.options.setStatusMessage).toHaveBeenLastCalledWith("status.externalLoadedSetAside");
    expect(h.options.applyAutoApprovedExternalDocument).not.toHaveBeenCalled();
  });

  it("clears pending identities on deletion and delegates switching away", async () => {
    const h = setup();
    h.options.pendingAutoAppliedProposalIdsByFileRef.current.set("file-a", ["p1"]);
    h.emit(h.change({ change: "deleted" }));
    await h.settled();
    expect(h.options.pendingAutoAppliedProposalIdsByFileRef.current.size).toBe(0);
    expect(h.options.switchAwayFromDeletedFile).toHaveBeenCalledWith("file-a");
    expect(h.options.loadWorkspaceDocument).not.toHaveBeenCalled();
  });

  it("reports failed reads and releases the in-flight marker without adopting a document", async () => {
    const h = setup();
    h.options.pendingAutoAppliedProposalIdsByFileRef.current.set("file-a", ["p1"]);
    vi.mocked(h.options.loadWorkspaceDocument).mockResolvedValue(null);
    h.emit();
    await h.settled();
    expect(h.options.pendingAutoAppliedProposalIdsByFileRef.current.size).toBe(0);
    expect(h.options.setSaveState).toHaveBeenLastCalledWith("error");
    expect(h.options.setStatusMessage).toHaveBeenLastCalledWith("status.externalLoadFailed");
    expect(h.options.documentRef.current).toBe(h.base);
  });

  it("reports rejected reads and releases the in-flight marker", async () => {
    const h = setup();
    vi.mocked(h.options.loadWorkspaceDocument).mockRejectedValue(new Error("read failed"));
    h.emit();
    await vi.waitFor(() => expect(h.options.setStatusMessage).toHaveBeenCalledWith("read failed"));
    expect(h.options.externalChangeFileIdsRef.current.size).toBe(0);
    expect(h.options.documentRef.current).toBe(h.base);
  });

  it("unsubscribes without clearing a newer subscription's processor", () => {
    const h = setup();
    const newer = vi.fn();
    h.options.documentStorageChangeProcessorRef.current = newer;
    h.dispose();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.options.documentStorageChangeProcessorRef.current).toBe(newer);
  });
});
