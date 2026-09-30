import { describe, expect, it, vi } from "vitest";

import type { SigmaCommentThread, SigmaDocument } from "@/features/document";

import {
  IDLE_SHARED_RESCAN_MS,
  LOCAL_SCAN_CONCURRENCY,
  SHARED_SCAN_CONCURRENCY,
  WorkspaceCommentScanner,
  type CommentScanFile,
  type CommentScanRecord,
  type CommentScanStore,
} from "./workspace-comment-scanner";

const ME = { userId: "user-me", authorNames: ["山田 太郎"] };

function documentWith(...threadIds: string[]): SigmaDocument {
  const comments: SigmaCommentThread[] = threadIds.map((id) => ({
    id,
    anchor: { type: "document" },
    messages: [{ id: `m-${id}`, authorName: "佐藤", body: [{ type: "text", text: `@私 ${id}`, mentionUserId: ME.userId }], createdAt: "2026-09-01T00:00:00.000Z" }],
    createdAt: "2026-09-01T00:00:00.000Z",
  }));
  return { comments } as unknown as SigmaDocument;
}

function file(fileId: string, shared = false, revision = 1): CommentScanFile {
  return { fileId, revision, updatedAt: "2026-09-01T00:00:00.000Z", shared };
}

function setup(documents: Record<string, SigmaDocument | null | Error> = {}) {
  let clock = 1_000_000;
  const loadedLocal: string[] = [];
  const loadedShared: string[] = [];
  const read = async (fileId: string) => {
    const value = documents[fileId] ?? null;
    if (value instanceof Error) throw value;
    return value;
  };
  const deps = {
    loadLocal: vi.fn(async (fileId: string) => { loadedLocal.push(fileId); return read(fileId); }),
    loadShared: vi.fn(async (fileId: string) => { loadedShared.push(fileId); return read(fileId); }),
    now: () => clock,
  };
  const scanner = new WorkspaceCommentScanner(ME, deps);
  const signal = new AbortController().signal;
  return { scanner, deps, documents, loadedLocal, loadedShared, signal, advance: (ms: number) => { clock += ms; } };
}

describe("WorkspaceCommentScanner", () => {
  it("collects related threads per document and leaves out documents without any", async () => {
    const { scanner, signal } = setup({ a: documentWith("t1"), b: documentWith(), c: documentWith("t2", "t3") });
    const files = [file("a"), file("b"), file("c", true)];
    await scanner.scan(files, { signal });
    const snapshot = scanner.snapshot(files);
    expect([...snapshot.keys()].sort()).toEqual(["a", "c"]);
    expect(snapshot.get("c")?.map((thread) => thread.threadId)).toEqual(["t2", "t3"]);
  });

  it("also collects threads I wrote in, not only the ones that mention me", async () => {
    const authored = { comments: [{
      id: "mine",
      anchor: { type: "document" },
      messages: [{ id: "m1", authorName: "山田 太郎", body: [{ type: "text", text: "質問です" }], createdAt: "2026-09-01T00:00:00.000Z" }],
      createdAt: "2026-09-01T00:00:00.000Z",
    }] } as unknown as SigmaDocument;
    const { scanner, signal } = setup({ a: authored });
    await scanner.scan([file("a")], { signal });
    expect(scanner.snapshot([file("a")]).get("a")?.map((thread) => [thread.threadId, thread.authored, thread.mentioned])).toEqual([["mine", true, false]]);
  });

  it("reads shared documents through the shared loader and local ones through the local loader", async () => {
    const { scanner, loadedLocal, loadedShared, signal } = setup({ a: documentWith("t1"), s: documentWith("t2") });
    await scanner.scan([file("a"), file("s", true)], { signal });
    expect(loadedLocal).toEqual(["a"]);
    expect(loadedShared).toEqual(["s"]);
  });

  it("does not reread unchanged local documents, but rereads when the revision changes", async () => {
    const { scanner, loadedLocal, documents, signal } = setup({ a: documentWith("t1") });
    await scanner.scan([file("a")], { signal });
    await scanner.scan([file("a")], { signal });
    expect(loadedLocal).toEqual(["a"]);
    documents.a = documentWith("t1", "t9");
    await scanner.scan([file("a", false, 2)], { signal });
    expect(loadedLocal).toEqual(["a", "a"]);
    expect(scanner.snapshot([file("a", false, 2)]).get("a")).toHaveLength(2);
  });

  it("rereads shared documents only after the ttl", async () => {
    const { scanner, loadedShared, advance, signal } = setup({ s: documentWith("t1") });
    await scanner.scan([file("s", true)], { signal, sharedTtlMs: 60_000 });
    advance(59_000);
    await scanner.scan([file("s", true)], { signal, sharedTtlMs: 60_000 });
    expect(loadedShared).toHaveLength(1);
    advance(1_000);
    await scanner.scan([file("s", true)], { signal, sharedTtlMs: 60_000 });
    expect(loadedShared).toHaveLength(2);
    await scanner.scan([file("s", true)], { signal, sharedTtlMs: 0 });
    expect(loadedShared).toHaveLength(3);
  });

  it("does not make local documents wait behind slow shared ones", async () => {
    const { scanner, deps, signal } = setup({ l1: documentWith("t1") });
    let releaseShared: () => void = () => {};
    const sharedGate = new Promise<void>((resolve) => { releaseShared = resolve; });
    deps.loadShared.mockImplementation(async () => { await sharedGate; return null; });
    const files = [...Array.from({ length: 20 }, (_, index) => file(`s${index}`, true)), file("l1")];
    const scanning = scanner.scan(files, { signal });
    await vi.waitFor(() => expect(scanner.snapshot(files).has("l1")).toBe(true));
    // 共有の読み込みが 1 件も終わっていなくても、ローカルの結果は出ている。
    expect(scanner.snapshot(files).has("s0")).toBe(false);
    releaseShared();
    await scanning;
  });

  it("reads shared documents with threads first, then unread ones, then ones without any", async () => {
    const { scanner, deps, advance, signal } = setup({ withThreads: documentWith("t1"), empty: documentWith() });
    const files = [file("withThreads", true), file("empty", true)];
    await scanner.scan(files, { signal, sharedTtlMs: 10 });
    advance(IDLE_SHARED_RESCAN_MS + 1);
    const order: string[] = [];
    deps.loadShared.mockImplementation(async (id) => { order.push(id); return null; });
    await scanner.scan([file("empty", true), file("fresh", true), file("withThreads", true)], { signal, sharedTtlMs: 10 });
    expect(order).toEqual(["withThreads", "fresh", "empty"]);
  });

  it("rereads shared documents without related threads much less often", async () => {
    const { scanner, loadedShared, advance, signal } = setup({ quiet: documentWith(), busy: documentWith("t1") });
    const files = [file("quiet", true), file("busy", true)];
    await scanner.scan(files, { signal, sharedTtlMs: 30_000 });
    advance(60_000);
    await scanner.scan(files, { signal, sharedTtlMs: 30_000 });
    expect(loadedShared.filter((id) => id === "quiet")).toHaveLength(1);
    expect(loadedShared.filter((id) => id === "busy")).toHaveLength(2);
    advance(IDLE_SHARED_RESCAN_MS);
    await scanner.scan(files, { signal, sharedTtlMs: 30_000 });
    expect(loadedShared.filter((id) => id === "quiet")).toHaveLength(2);
  });

  it("never reads more local or shared documents at once than their limits", async () => {
    const { scanner, deps, signal } = setup({});
    const running = { local: 0, shared: 0 };
    const peak = { local: 0, shared: 0 };
    const slow = (kind: "local" | "shared") => async () => {
      running[kind] += 1;
      peak[kind] = Math.max(peak[kind], running[kind]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running[kind] -= 1;
      return null;
    };
    deps.loadLocal.mockImplementation(slow("local"));
    deps.loadShared.mockImplementation(slow("shared"));
    await scanner.scan([
      ...Array.from({ length: 12 }, (_, index) => file(`l${index}`)),
      ...Array.from({ length: 20 }, (_, index) => file(`s${index}`, true)),
    ], { signal });
    expect(peak).toEqual({ local: LOCAL_SCAN_CONCURRENCY, shared: SHARED_SCAN_CONCURRENCY });
    expect(deps.loadLocal).toHaveBeenCalledTimes(12);
    expect(deps.loadShared).toHaveBeenCalledTimes(20);
  });

  it("keeps the previous result when a shared document cannot be read, and retries after the ttl", async () => {
    const { scanner, documents, advance, signal } = setup({ s: documentWith("t1") });
    const files = [file("s", true)];
    await scanner.scan(files, { signal, sharedTtlMs: 10 });
    documents.s = new Error("NETWORK_UNAVAILABLE");
    advance(20);
    await expect(scanner.scan(files, { signal, sharedTtlMs: 10 })).resolves.toBeUndefined();
    expect(scanner.snapshot(files).get("s")).toHaveLength(1);
    documents.s = documentWith();
    advance(20);
    await scanner.scan(files, { signal, sharedTtlMs: 10 });
    expect(scanner.snapshot(files).has("s")).toBe(false);
  });

  it("treats an unreadable local document as having no related threads without failing the scan", async () => {
    const { scanner, signal } = setup({ bad: null, ok: documentWith("t1") });
    const files = [file("bad"), file("ok")];
    await scanner.scan(files, { signal });
    expect([...scanner.snapshot(files).keys()]).toEqual(["ok"]);
  });

  it("forgets documents that are no longer listed", async () => {
    const { scanner, loadedLocal, signal } = setup({ a: documentWith("t1") });
    await scanner.scan([file("a")], { signal });
    await scanner.scan([], { signal });
    expect(scanner.snapshot([file("a")]).size).toBe(0);
    await scanner.scan([file("a")], { signal });
    expect(loadedLocal).toEqual(["a", "a"]);
  });

  it("stops starting new reads and stops reporting once aborted", async () => {
    const { scanner, deps } = setup({});
    const controller = new AbortController();
    const onProgress = vi.fn();
    deps.loadLocal.mockImplementation(async () => { controller.abort(); return null; });
    await scanner.scan(Array.from({ length: 9 }, (_, index) => file(`f${index}`)), { signal: controller.signal, onProgress });
    // 中断した後は、残りの教材の読み込みを始めない。
    expect(deps.loadLocal.mock.calls.length).toBeLessThan(9);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reports progress after each document", async () => {
    const { scanner, signal } = setup({ a: documentWith("t1"), b: documentWith("t2") });
    const onProgress = vi.fn();
    await scanner.scan([file("a"), file("b")], { signal, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  describe("with a store for earlier results", () => {
    function memoryStore(initial: Record<string, CommentScanRecord> | null = null) {
      let saved = initial;
      const store: CommentScanStore = {
        load: () => saved,
        save: vi.fn((records) => { saved = JSON.parse(JSON.stringify(records)); }),
      };
      return { store, saved: () => saved };
    }
    function scannerWith(store: CommentScanStore, documents: Record<string, SigmaDocument | null> = {}) {
      let clock = 1_000_000;
      const loadShared = vi.fn(async (fileId: string) => documents[fileId] ?? null);
      const loadLocal = vi.fn(async (fileId: string) => documents[fileId] ?? null);
      const scanner = new WorkspaceCommentScanner(ME, { loadLocal, loadShared, now: () => clock, store });
      return { scanner, loadLocal, loadShared, advance: (ms: number) => { clock += ms; } };
    }

    it("saves results when a scan ends and shows them again without reading the documents", async () => {
      const { store, saved } = memoryStore();
      const first = scannerWith(store, { a: documentWith("t1"), s: documentWith("t2") });
      const files = [file("a"), file("s", true)];
      await first.scanner.scan(files, { signal: new AbortController().signal });
      expect(Object.keys(saved() ?? {}).sort()).toEqual(["a", "s"]);

      const second = scannerWith(store);
      expect([...second.scanner.snapshot(files).keys()].sort()).toEqual(["a", "s"]);
      await second.scanner.scan(files, { signal: new AbortController().signal });
      expect(second.loadLocal).not.toHaveBeenCalled();
      expect(second.loadShared).not.toHaveBeenCalled();
    });

    it("rereads a saved document whose revision changed, and drops ones that are no longer listed", async () => {
      const { store, saved } = memoryStore();
      const first = scannerWith(store, { a: documentWith("t1"), gone: documentWith("t2") });
      await first.scanner.scan([file("a"), file("gone")], { signal: new AbortController().signal });

      const second = scannerWith(store, { a: documentWith("t1", "t9") });
      await second.scanner.scan([file("a", false, 2)], { signal: new AbortController().signal });
      expect(second.loadLocal).toHaveBeenCalledWith("a");
      expect(second.scanner.snapshot([file("a", false, 2)]).get("a")).toHaveLength(2);
      expect(Object.keys(saved() ?? {})).toEqual(["a"]);
    });

    it("does not write when nothing was read", async () => {
      const { store } = memoryStore();
      const { scanner } = scannerWith(store, { a: documentWith("t1") });
      await scanner.scan([file("a")], { signal: new AbortController().signal });
      expect(store.save).toHaveBeenCalledTimes(1);
      await scanner.scan([file("a")], { signal: new AbortController().signal });
      expect(store.save).toHaveBeenCalledTimes(1);
    });
  });
});
