import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalSigmaDocStore,
  type LocalStoreChangeEvent,
} from "./local-sigma-doc-store";
import { readBlockHashRevisions } from "./block-hash-sidecar";
import { createBlankDocument } from "@/lib/blank-document";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { setAppLocale } from "@/lib/i18n";
import {
  aiWorkspaceTab,
  createSingleGroupWorkspaceLayout,
  splitWorkspaceGroupWithTab,
} from "@/lib/workspace-tab-groups";

const realFsWriteFile = fs.writeFile;

/** reconcileDocumentFile はprivateなので、テストからは薄い型で直接呼び出す。 */
interface StoreReconcileInternals {
  reconcileDocumentFile(fileId: string, onChange: (event: LocalStoreChangeEvent) => void): Promise<void>;
}

interface LibraryFixture {
  version: number;
  activeWorkspaceId: string;
  workspaces: Array<{ id: string; name: string; deletedAt: string | null }>;
  folders: Array<{ id: string; workspaceId: string; name: string; parentFolderId: string | null; deletedAt: string | null }>;
  files: Array<{
    fileId: string;
    workspaceId: string;
    folderId: string | null;
    docId: string;
    title?: string;
    documentPath?: string;
    revision: number;
    deletedAt: string | null;
  }>;
}

describe("LocalSigmaDocStore", () => {
  let userDataDir: string;
  let store: LocalSigmaDocStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-store-"));
    store = new LocalSigmaDocStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("numbers simultaneous new materials and stores the same titles in the documents and ledger", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const created = await Promise.all([store.createDocument({ title: "教材" }), store.createDocument({ title: "教材" }), store.createDocument({ title: "教材" })]);
    expect(created.map((record) => record.document.metadata.title).sort()).toEqual(["教材", "教材 2", "教材 3"]);
    for (const record of created) expect(record.file.title).toBe(record.document.metadata.title);
  });

  it("does not discard a blank draft if another writer saved content after it was inspected", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const created = await store.createDocument();
    const changed = { ...created.document, metadata: { ...created.document.metadata, title: "残す教材" } };
    const saved = await store.saveDocument(created.file.fileId, changed, { expectedRevision: created.file.revision });
    expect(saved.ok).toBe(true);
    expect(await store.deleteFile(created.file.fileId, { expectedRevision: created.file.revision })).toMatchObject({ ok: false, code: "revision-mismatch" });
    expect((await store.listFiles()).find((file) => file.fileId === created.file.fileId)?.title).toBe("残す教材");
  });

  it("creates a v4 local-only library.json and a fileId-based sample document", async () => {
    const workspace = await store.initializeWorkspace({ initialDocument: sampleDocument });
    const library = await readLibrary(userDataDir);
    const files = await store.listFiles();

    expect(workspace.openFileIds).toEqual([workspace.activeFileId]);
    expect(files).toHaveLength(1);
    expect(files[0]?.fileId).toBe(workspace.activeFileId);
    expect(files[0]?.docId).not.toBe(sampleDocument.docId);
    expect(files[0]?.documentPath).toBe(`documents/${encodeURIComponent(files[0]?.fileId ?? "")}.sigmadoc.json`);
    expect(library.version).toBe(4);
    expect(library.workspaces[0]).toMatchObject({ name: "マイ教材" });
    expect(library.files[0]?.fileId).toBe(files[0]?.fileId);
    for (const record of [...library.workspaces, ...library.files]) {
      expect(record).not.toHaveProperty("kind");
      expect(record).not.toHaveProperty("cloudState");
      expect(record).not.toHaveProperty("remoteRevision");
      expect(record).not.toHaveProperty("role");
      expect(record).not.toHaveProperty("memberCount");
    }
    await expect(fs.stat(path.join(userDataDir, "data", files[0]?.documentPath ?? ""))).resolves.toBeTruthy();
  });

  it("returns a local-only workspace overview", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      return;
    }
    expect(result.overview).not.toHaveProperty("currentUserId");
    for (const workspace of result.overview.workspaces) {
      expect(workspace).not.toHaveProperty("role");
      expect(workspace).not.toHaveProperty("ownerUserId");
      expect(workspace).not.toHaveProperty("memberCount");
    }
    for (const file of result.overview.files) {
      expect(file).not.toHaveProperty("canEdit");
    }
  });

  it("captures, lists, loads, skips unchanged saves, and deletes document versions", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const file = (await store.listFiles())[0]!;
    const changed = {
      ...sampleDocument,
      metadata: { ...sampleDocument.metadata, title: "履歴あり" },
    };
    const firstSave = await store.saveDocument(file.fileId, changed, {
      expectedRevision: file.revision,
      origin: "ai",
    });
    expect(firstSave.ok).toBe(true);
    expect(firstSave.versionCaptured).toBe(true);
    const firstVersions = await store.listDocumentVersions(file.fileId);
    expect(firstVersions).toHaveLength(1);
    expect(firstVersions[0]).toMatchObject({ origin: "ai", revision: firstSave.revision });
    expect((await store.getDocumentVersion(file.fileId, firstVersions[0]!.versionId))?.document.metadata.title).toBe("履歴あり");

    const unchangedSave = await store.saveDocument(file.fileId, {
      ...changed,
      updatedAt: "2099-01-01T00:00:00.000Z",
    }, { expectedRevision: firstSave.revision!, origin: "ai" });
    expect(unchangedSave.ok).toBe(true);
    expect(unchangedSave.versionCaptured).toBe(false);
    expect(await store.listDocumentVersions(file.fileId)).toHaveLength(1);

    const backup = await store.captureDocumentVersion(file.fileId, changed, {
      expectedRevision: unchangedSave.revision!,
      origin: "restore-backup",
    });
    expect(backup.ok).toBe(true);
    expect(await store.listDocumentVersions(file.fileId)).toHaveLength(2);
    expect(await store.deleteFile(file.fileId)).toEqual({ ok: true });
    expect(await store.listDocumentVersions(file.fileId)).toEqual([]);
  });

  it("captures a tab boundary against the latest version after an unversioned autosave", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const file = (await store.listFiles())[0]!;
    const first = { ...sampleDocument, metadata: { ...sampleDocument.metadata, title: "12:00 version" } };
    const firstSave = await store.saveDocument(file.fileId, first, { expectedRevision: file.revision, origin: "ai" });
    const autosaved = { ...first, metadata: { ...first.metadata, title: "12:01 autosave" } };
    const autosave = await store.saveDocument(file.fileId, autosaved, { expectedRevision: firstSave.revision!, origin: "user" });
    expect(autosave.versionCaptured).toBe(false);

    const boundary = await store.saveDocument(file.fileId, structuredClone(autosaved), {
      expectedRevision: autosave.revision!,
      origin: "tab-switch",
    });
    expect(boundary.versionCaptured).toBe(true);
    expect((await store.listDocumentVersions(file.fileId))[0]).toMatchObject({ origin: "tab-switch" });

    const duplicateBoundary = await store.saveDocument(file.fileId, structuredClone(autosaved), {
      expectedRevision: boundary.revision!,
      origin: "app-close",
    });
    expect(duplicateBoundary.versionCaptured).toBe(false);
  });

  it("reports canonical save success and advances revision when version sidecar capture fails", async () => {
    store = new LocalSigmaDocStore(userDataDir, {
      appendDocumentVersion: async () => {
        throw new Error("injected sidecar write/prune failure");
      },
    });
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const file = (await store.listFiles())[0]!;
    const firstDocument = {
      ...sampleDocument,
      metadata: { ...sampleDocument.metadata, title: "サイドカー失敗後" },
    };

    const firstSave = await store.saveDocument(file.fileId, firstDocument, {
      expectedRevision: file.revision,
    });
    expect(firstSave).toMatchObject({
      ok: true,
      revision: file.revision + 1,
      versionCaptured: false,
      versionCaptureError: "injected sidecar write/prune failure",
    });
    expect((await store.loadDocument(file.fileId))?.metadata.title).toBe("サイドカー失敗後");

    const secondSave = await store.saveDocument(file.fileId, {
      ...firstDocument,
      metadata: { ...firstDocument.metadata, title: "次の保存" },
    }, { expectedRevision: firstSave.revision! });
    expect(secondSave).toMatchObject({ ok: true, revision: file.revision + 2 });
  });

  it("reports canonical delete success when version sidecar cleanup fails", async () => {
    store = new LocalSigmaDocStore(userDataDir, {
      deleteDocumentVersions: async () => {
        throw new Error("injected sidecar cleanup failure");
      },
    });
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const file = (await store.listFiles())[0]!;
    const saved = await store.saveDocument(file.fileId, {
      ...sampleDocument,
      metadata: { ...sampleDocument.metadata, title: "履歴が残る削除済み教材" },
    }, { expectedRevision: file.revision });
    expect(saved.versionCaptured).toBe(true);
    const [version] = await store.listDocumentVersions(file.fileId);
    expect(version).toBeDefined();

    const deleted = await store.deleteFile(file.fileId);

    expect(deleted).toEqual({
      ok: true,
      versionCleanupError: "injected sidecar cleanup failure",
    });
    expect(await store.listFiles()).toEqual([]);
    expect(await store.listDocumentVersions(file.fileId)).toEqual([]);
    expect(await store.getDocumentVersion(file.fileId, version!.versionId)).toBeNull();
    expect(await store.listFiles()).toEqual([]);
  });

  it("does not rewrite or emit external changes while reading the active workspace", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const libraryPath = path.join(userDataDir, "data", "library.json");
    const before = await fs.stat(libraryPath);
    const events: Array<{ type: string }> = [];
    const unwatch = store.watch((event) => events.push(event));

    const overview = await store.getWorkspaceOverview();
    expect(overview.state).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = await fs.stat(libraryPath);
    expect(after.ino).toBe(before.ino);
    expect(events).toEqual([]);
    unwatch();
  });

  it("does not report its own library writes as external changes", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const overview = await store.getWorkspaceOverview();
    expect(overview.state).toBe("ready");
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";
    const events: Array<{ type: string }> = [];
    const unwatch = store.watch((event) => events.push(event));

    const renamed = await store.renameWorkspace(workspaceId, "更新後の名前");
    expect(renamed.state).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(events).toEqual([]);
    unwatch();
  });

  it("recreates a failed filesystem watcher with bounded backoff and reports permanent failure", async () => {
    type FakeWatcher = EventEmitter & { close: ReturnType<typeof vi.fn> };
    const fakeWatchers: FakeWatcher[] = [];
    const watchedPaths: string[] = [];
    const watchFactory = vi.fn((filename: string) => {
      watchedPaths.push(filename);
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.close = vi.fn();
      fakeWatchers.push(watcher);
      return watcher as unknown as FSWatcher;
    });
    const retryingStore = new LocalSigmaDocStore(userDataDir, {
      watchFactory,
      watchRetryBaseMs: 1,
      watchMaxRetries: 1,
    });
    const events: LocalStoreChangeEvent[] = [];
    const unwatch = retryingStore.watch((event) => events.push(event));

    expect(watchFactory).toHaveBeenCalledTimes(2);
    fakeWatchers[0]!.emit("error", new Error("documents watcher failed"));
    await vi.waitFor(() => expect(watchFactory).toHaveBeenCalledTimes(3));
    expect(fakeWatchers[0]!.close).toHaveBeenCalledOnce();
    expect(watchedPaths[2]).toBe(path.join(userDataDir, "data", "documents"));

    fakeWatchers[2]!.emit("error", new Error("documents watcher failed again"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "watcher",
      scope: "documents",
      change: "failed",
    })));

    expect(watchFactory).toHaveBeenCalledTimes(3);
    unwatch();
  });

  it("does not replace a malformed existing library with a new empty library", async () => {
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const malformedLibrary = '{"version":3,"files":[';
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(libraryPath, malformedLibrary, "utf8");

    await expect(store.initializeWorkspace({ initialDocument: sampleDocument }))
      .rejects.toThrow("教材ライブラリの索引が破損しています");
    await expect(fs.readFile(libraryPath, "utf8")).resolves.toBe(malformedLibrary);
    await expect(fs.readdir(path.join(dataDir, "documents"))).resolves.toEqual([]);
  });

  it("quarantines a library row whose fileId is not in the generated file ID format", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "..",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_1",
        title: "unsafe",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
    });

    expect((await store.listFiles()).map((file) => file.fileId)).not.toContain("..");
    const library = await readRawLibrary(userDataDir);
    expect(library.files).not.toContainEqual(expect.objectContaining({ fileId: ".." }));
    expect(library.quarantine).toEqual([expect.objectContaining({ fileId: ".." })]);
  });

  it("a file row missing deletedAt survives a read-modify-write", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_1",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_1",
        title: "欠損教材",
        documentPath: "documents/file_1.sigmadoc.json",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        // deletedAt is intentionally absent.
      }],
    });

    const files = await store.listFiles();
    expect(files.map((file) => file.fileId)).toContain("file_1");

    const library = await readRawLibrary(userDataDir);
    const persisted = library.files.find((file) => (file as Record<string, unknown>).fileId === "file_1") as Record<string, unknown> | undefined;
    expect(persisted).toBeDefined();
    expect(persisted?.deletedAt).toBeNull();
  });

  it("a file row with a non-numeric revision is repaired, not dropped", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_1",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_1",
        title: "壊れたリビジョン",
        documentPath: "documents/file_1.sigmadoc.json",
        revision: "5",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
    });

    const files = await store.listFiles();
    const file = files.find((item) => item.fileId === "file_1");
    expect(file).toBeDefined();
    expect(file?.revision).toBe(1);

    const library = await readRawLibrary(userDataDir);
    const persisted = library.files.find((item) => (item as Record<string, unknown>).fileId === "file_1") as Record<string, unknown> | undefined;
    expect(persisted?.revision).toBe(1);
  });

  it("an unknown future field on a row is still present after a write", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_1",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_1",
        title: "将来フィールド入り",
        documentPath: "documents/file_1.sigmadoc.json",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        futureFlag: "keep-me",
      }],
    });

    // このrowは既存の検証に照らして完全に正しいので、修復は発生しない。フィールド
    // 保持の修正だけを別途、実際の書き込みを1回発生させて検証する。
    const renamed = await store.renameWorkspace("workspace_1", "マイ教材2");
    expect(renamed.state).toBe("ready");

    const library = await readRawLibrary(userDataDir);
    const persisted = library.files.find((item) => (item as Record<string, unknown>).fileId === "file_1") as Record<string, unknown> | undefined;
    expect(persisted?.futureFlag).toBe("keep-me");
  });

  it("a row with no fileId is quarantined verbatim and is still present in library.json after a write", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: [
        {
          fileId: "file_ok",
          workspaceId: "workspace_1",
          folderId: null,
          docId: "doc_ok",
          title: "正常な教材",
          documentPath: "documents/file_ok.sigmadoc.json",
          revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          // fileId is intentionally absent: unrecoverable, must be quarantined verbatim.
          workspaceId: "workspace_1",
          folderId: null,
          docId: "doc_orphan",
          title: "fileId欠損教材",
          revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });

    const files = await store.listFiles();
    expect(files.map((file) => file.fileId)).toEqual(["file_ok"]);

    const library = await readRawLibrary(userDataDir);
    expect(library.files.map((file) => (file as Record<string, unknown>).fileId)).toEqual(["file_ok"]);
    expect(library.quarantine).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "fileId欠損教材" }),
    ]));
  });

  it("a file whose workspaceId no longer exists is re-homed and stays visible", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_orphan",
        workspaceId: "workspace_ghost",
        folderId: null,
        docId: "doc_orphan",
        title: "行き場のない教材",
        documentPath: "documents/file_orphan.sigmadoc.json",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
    });

    const files = await store.listFiles();
    expect(files.map((file) => file.fileId)).toContain("file_orphan");
    expect(files.find((file) => file.fileId === "file_orphan")?.workspaceId).toBe("workspace_1");

    const library = await readRawLibrary(userDataDir);
    const persisted = library.files.find((file) => (file as Record<string, unknown>).fileId === "file_orphan") as Record<string, unknown> | undefined;
    expect(persisted?.workspaceId).toBe("workspace_1");
  });

  it("files present but not an array is quarantined and logged", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }],
      folders: [],
      files: "not-an-array",
    });

    await expect(store.listFiles()).resolves.toBeDefined();

    const library = await readRawLibrary(userDataDir);
    expect(Array.isArray(library.files)).toBe(true);
    expect(library.quarantine).toEqual(expect.arrayContaining(["not-an-array"]));

    const logPath = path.join(userDataDir, "data", "logs", "ledger.log");
    const logContent = await fs.readFile(logPath, "utf8");
    expect(logContent).toContain("ledger-array-quarantined");
  });

  it("saves documents by fileId and increments the file revision", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    expect(file).toBeDefined();
    const document = await store.loadDocument(file.fileId);
    expect(document).not.toBeNull();

    const nextDocument: SigmaDocument = {
      ...(document as SigmaDocument),
      metadata: { title: "更新済み" },
      updatedAt: "2026-06-03T00:00:00.000Z",
    };

    expect((await store.saveDocument(file.fileId, nextDocument, { expectedRevision: file.revision })).ok).toBe(true);
    const library = await readLibrary(userDataDir);
    const updatedFile = library.files.find((item) => item.fileId === file.fileId);
    const loaded = await store.loadDocument(file.fileId);

    expect(updatedFile?.revision).toBe(file.revision + 1);
    expect(loaded?.metadata.title).toBe("更新済み");
    expect(await readWorkspace(userDataDir)).toEqual({
      id: "default",
      openFileIds: [file.fileId],
      activeFileId: file.fileId,
      layout: createSingleGroupWorkspaceLayout([file.fileId], file.fileId),
    });
  });

  it("persists V2 split layout and removes deleted document and AI tabs without flattening the remainder", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const first = (await store.listFiles())[0];
    const second = await store.createDocument({ title: "二つ目" });
    let layout = createSingleGroupWorkspaceLayout([first.fileId, second.file.fileId], first.fileId);
    layout = splitWorkspaceGroupWithTab(layout, `document:${second.file.fileId}`, "group-1", "right", "group-2", "split-1");
    layout = {
      ...layout,
      root: layout.root.kind === "split" ? { ...layout.root, ratio: 0.63 } : layout.root,
      groups: layout.groups.map((group) => group.id === "group-2"
        ? { ...group, tabs: [...group.tabs, aiWorkspaceTab("room-2", second.file.fileId)] }
        : group),
    };

    await expect(store.saveWorkspace({
      openFileIds: [first.fileId, second.file.fileId],
      activeFileId: first.fileId,
      layout,
    })).resolves.toEqual({ ok: true });
    const restored = await store.initializeWorkspace({ initialDocument: sampleDocument });
    expect(restored.layout).toEqual(layout);

    await expect(store.deleteFile(second.file.fileId, { expectedRevision: second.file.revision }))
      .resolves.toMatchObject({ ok: true });
    const workspace = await readWorkspace(userDataDir) as { layout: typeof layout };
    expect(workspace.layout.groups).toHaveLength(1);
    expect(workspace.layout.groups[0].tabs).toEqual([{ id: `document:${first.fileId}`, kind: "document", fileId: first.fileId }]);
    expect(workspace.layout.root).toEqual({ kind: "group", groupId: "group-1" });
  });

  it("loads the valid portion of a document and deduplicates an exact recovery backup", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    expect(file).toBeDefined();
    const rawDocument = {
      ...structuredClone(sampleDocument),
      pageLayout: {
        preset: "A4" as const,
        overlay: {
          overlaySnapshot: {
            version: 1 as const,
            shapes: [{
              id: "legacy_callout",
              type: "callout",
              x: 30,
              y: 40,
              props: { w: 180, h: 80, tailX: 90, tailY: 120, tailWidth: 28 },
            }],
            assets: {},
          },
        },
      },
    };
    const raw = JSON.stringify(rawDocument, null, 2);
    const documentPath = path.join(userDataDir, "data", file.documentPath ?? "");
    await fs.writeFile(documentPath, raw, "utf8");

    const first = await store.loadDocumentWithRecovery(file.fileId);
    const second = await store.loadDocumentWithRecovery(file.fileId);

    expect(first).toMatchObject({
      ok: true,
      revision: file.revision,
      document: { pageLayout: { overlay: { overlaySnapshot: { shapes: [] } } } },
      recoveryIssues: [expect.objectContaining({ kind: "overlayShape", id: "legacy_callout" })],
    });
    expect(second).toMatchObject({ ok: true });
    expect(await fs.readFile(documentPath, "utf8")).toBe(raw);
    const backupNames = await fs.readdir(path.join(userDataDir, "data", "recovery"));
    expect(backupNames).toHaveLength(1);
    expect(await fs.readFile(path.join(userDataDir, "data", "recovery", backupNames[0] ?? ""), "utf8")).toBe(raw);
  });

  it("reports schema violations with the offending values and the document path", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const documentPath = path.join(userDataDir, "data", file.documentPath ?? "");
    // 別ブランチ/新しいアプリで保存された未知のpresetは要素の除外では救えない。
    // 教材を開いたまま原因を出すため、UI が使える診断まで返す必要がある。
    await fs.writeFile(documentPath, JSON.stringify({
      ...structuredClone(sampleDocument),
      pageLayout: { preset: "scroll" },
    }), "utf8");

    await expect(store.loadDocumentWithRecovery(file.fileId)).resolves.toMatchObject({
      ok: false,
      failureKind: "schema",
      documentPath,
      title: file.title,
      failures: [expect.objectContaining({ path: "pageLayout.preset", received: '"scroll"' })],
    });
  });

  it("does not create a recovery backup for malformed JSON", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const documentPath = path.join(userDataDir, "data", file.documentPath ?? "");
    await fs.writeFile(documentPath, "{broken", "utf8");

    await expect(store.loadDocumentWithRecovery(file.fileId)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("JSON"),
      failureKind: "json",
      documentPath,
    });
    await expect(fs.readdir(path.join(userDataDir, "data", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(documentPath, "utf8")).toBe("{broken");
  });

  it("indexes untitled documents by their first content line", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const document: SigmaDocument = {
      ...createBlankDocument("無題の教材"),
      content: [
        { type: "paragraph", id: "p_auto_title", children: [{ type: "text", text: "一次関数のまとめ" }] },
      ],
      updatedAt: "2026-06-03T00:00:00.000Z",
    };

    const created = await store.createFileFromDocument({ document });
    expect(created.file.title).toBe("一次関数のまとめ");

    const nextDocument: SigmaDocument = {
      ...created.document,
      metadata: { title: "無題の教材" },
      content: [
        { type: "paragraph", id: "p_auto_title", children: [{ type: "text", text: "二次関数のまとめ" }] },
      ],
      updatedAt: "2026-06-04T00:00:00.000Z",
    };

    expect((await store.saveDocument(created.file.fileId, nextDocument, {
      expectedRevision: created.file.revision,
    })).ok).toBe(true);
    const file = (await store.listFiles()).find((item) => item.fileId === created.file.fileId);
    expect(file?.title).toBe("二次関数のまとめ");
  });

  it("updates folder hierarchy, moves files, and hides soft-deleted folders/files", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const overview = await store.getWorkspaceOverview();
    expect(overview.state).toBe("ready");
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";
    const fileId = overview.state === "ready" ? overview.overview.files[0]?.fileId ?? "" : "";

    const createdFolder = await store.createFolder(workspaceId, "単元1");
    expect(createdFolder.state).toBe("ready");
    const folderId = createdFolder.state === "ready" ? createdFolder.overview.folders[0]?.id ?? "" : "";
    const createdChild = await store.createFolder(workspaceId, "小単元", folderId);
    expect(createdChild.state).toBe("ready");
    const childId = createdChild.state === "ready"
      ? createdChild.overview.folders.find((folder) => folder.parentFolderId === folderId)?.id ?? ""
      : "";

    const moved = await store.moveFileToFolder(workspaceId, fileId, folderId);
    expect(moved.state).toBe("ready");
    expect(moved.state === "ready" ? moved.overview.files[0]?.folderId : null).toBe(folderId);

    const renamed = await store.updateFolder(workspaceId, childId, { name: "小単元A", parentFolderId: null });
    expect(renamed.state).toBe("ready");
    expect(renamed.state === "ready"
      ? renamed.overview.folders.find((folder) => folder.id === childId)?.name
      : null).toBe("小単元A");

    expect((await store.deleteFolder(workspaceId, childId)).state).toBe("ready");
    expect((await store.deleteFile(fileId)).ok).toBe(true);
    const finalOverview = await store.getWorkspaceOverview(workspaceId);
    const library = await readLibrary(userDataDir);

    expect(finalOverview.state).toBe("ready");
    expect(finalOverview.state === "ready" ? finalOverview.overview.files : []).toHaveLength(0);
    expect(finalOverview.state === "ready"
      ? finalOverview.overview.folders.some((folder) => folder.id === childId)
      : true).toBe(false);
    expect(library.files.find((file) => file.fileId === fileId)?.deletedAt).not.toBeNull();
    expect(library.folders.find((folder) => folder.id === childId)?.deletedAt).not.toBeNull();
  });

  it("deletes a workspace's folders/files, keeps document bodies on disk, moves activeWorkspaceId, and does not resurrect a default workspace afterward", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const firstOverview = await store.getWorkspaceOverview();
    const firstWorkspaceId = firstOverview.state === "ready" ? firstOverview.overview.activeWorkspaceId : "";

    const created = await store.createWorkspace("第2教材棚");
    expect(created.state).toBe("ready");
    const secondWorkspaceId = created.state === "ready" ? created.overview.activeWorkspaceId : "";
    expect(secondWorkspaceId).not.toBe(firstWorkspaceId);

    const folderResult = await store.createFolder(secondWorkspaceId, "単元A");
    expect(folderResult.state).toBe("ready");
    const folderId = folderResult.state === "ready" ? folderResult.overview.folders[0]?.id ?? "" : "";

    const fileCreated = await store.createFileFromDocument({
      document: createBlankDocument("第2教材棚の教材"),
      workspaceId: secondWorkspaceId,
      folderId,
    });
    const documentPath = path.join(userDataDir, "data", fileCreated.file.documentPath ?? "");
    await expect(fs.stat(documentPath)).resolves.toBeTruthy();

    const deleted = await store.deleteWorkspace(secondWorkspaceId);
    expect(deleted.state).toBe("ready");
    expect(deleted.state === "ready" ? deleted.overview.activeWorkspaceId : "").toBe(firstWorkspaceId);

    const library = await readLibrary(userDataDir);
    expect(library.activeWorkspaceId).toBe(firstWorkspaceId);
    expect(library.workspaces.find((workspace) => workspace.id === secondWorkspaceId)?.deletedAt).not.toBeNull();
    expect(library.folders.find((folder) => folder.id === folderId)?.deletedAt).not.toBeNull();
    expect(library.files.find((file) => file.fileId === fileCreated.file.fileId)?.deletedAt).not.toBeNull();
    // Store invariant: document body JSONs are never unlinked, only the ledger rows get deletedAt.
    await expect(fs.stat(documentPath)).resolves.toBeTruthy();

    // Gone from any subsequent overview lookup for that workspace id.
    const deletedWorkspaceOverview = await store.getWorkspaceOverview(secondWorkspaceId);
    expect(deletedWorkspaceOverview).toEqual({ state: "error", error: "ワークスペースが見つかりません。" });

    // ensureLibrary's auto-create branch must not fire: exactly one 「マイ教材」, not a fresh second one.
    const overviewAfter = await store.getWorkspaceOverview();
    expect(overviewAfter.state).toBe("ready");
    expect(overviewAfter.state === "ready" ? overviewAfter.overview.workspaces : []).toHaveLength(1);
    expect(library.workspaces.filter((workspace) => workspace.name === "マイ教材")).toHaveLength(1);
  });

  it("returns a clean error when deleting an already-deleted workspace", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const created = await store.createWorkspace("第2教材棚");
    const secondWorkspaceId = created.state === "ready" ? created.overview.activeWorkspaceId : "";

    expect((await store.deleteWorkspace(secondWorkspaceId)).state).toBe("ready");
    const result = await store.deleteWorkspace(secondWorkspaceId);
    expect(result).toEqual({ state: "error", error: "ワークスペースが見つかりません。" });
  });

  it("a soft-deleted personal マイ教材 is restored rather than replaced", async () => {
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_deleted",
      workspaces: [{
        id: "workspace_deleted",
        name: "マイ教材",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        deletedAt: "2026-06-01T00:00:00.000Z",
      }],
      folders: [],
      files: [{
        fileId: "file_restored",
        workspaceId: "workspace_deleted",
        folderId: null,
        docId: "doc_restored",
        title: "復元される教材",
        documentPath: "documents/file_restored.sigmadoc.json",
        revision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        // Deleted at the exact same instant as the workspace: this is a
        // cascade deletion (deleteWorkspace), not an independent user delete.
        deletedAt: "2026-06-01T00:00:00.000Z",
      }],
    });
    await fs.mkdir(path.join(userDataDir, "data", "documents"), { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, "data", "documents", "file_restored.sigmadoc.json"),
      JSON.stringify(createBlankDocument("復元される教材")),
      "utf8",
    );

    const files = await store.listFiles();

    expect(files.map((file) => file.fileId)).toEqual(["file_restored"]);
    const library = await readRawLibrary(userDataDir);
    expect(library.workspaces).toHaveLength(1);
    const restoredWorkspace = library.workspaces[0] as Record<string, unknown>;
    expect(restoredWorkspace.id).toBe("workspace_deleted");
    expect(restoredWorkspace.deletedAt).toBeNull();
    const restoredFile = library.files.find((file) => (file as Record<string, unknown>).fileId === "file_restored") as Record<string, unknown>;
    expect(restoredFile.deletedAt).toBeNull();

    const logPath = path.join(userDataDir, "data", "logs", "ledger.log");
    const logContent = await fs.readFile(logPath, "utf8");
    expect(logContent).toContain("workspace-auto-restored");
  });

  it("auto-creating a workspace appends a workspace-auto-created line to data/logs/ledger.log", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });

    const logPath = path.join(userDataDir, "data", "logs", "ledger.log");
    const logContent = await fs.readFile(logPath, "utf8");
    expect(logContent).toContain("workspace-auto-created");
  });

});

describe("LocalSigmaDocStore optimistic locking / runExclusive / block-hash sidecar", () => {
  let userDataDir: string;
  let store: LocalSigmaDocStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-store-lock-"));
    store = new LocalSigmaDocStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("returns the current file revision from loadDocumentWithRecovery", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;
    const saved = await store.saveDocument(file.fileId, {
      ...document,
      metadata: { title: "revisionを進める" },
    }, { expectedRevision: file.revision });

    expect(saved).toMatchObject({ ok: true, revision: file.revision + 1 });
    await expect(store.loadDocumentWithRecovery(file.fileId)).resolves.toMatchObject({
      ok: true,
      revision: file.revision + 1,
      document: { metadata: { title: "revisionを進める" } },
    });
  });

  it("rejects a save whose expectedRevision no longer matches the stored revision", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    // 他の保存が先に割り込んで revision が進んだ状態を再現する。
    await store.saveDocument(
      file.fileId,
      { ...document, metadata: { title: "先に保存された変更" } },
      { expectedRevision: file.revision },
    );

    const result = await store.saveDocument(
      file.fileId,
      { ...document, metadata: { title: "古い前提のままの変更" } },
      { expectedRevision: file.revision },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("revision-mismatch");
    expect(result.currentRevision).toBe(file.revision + 1);
    // 拒否された保存は反映されていない。
    expect((await store.loadDocument(file.fileId))?.metadata.title).toBe("先に保存された変更");
  });

  it("accepts a save when expectedRevision matches the currently stored revision", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    const result = await store.saveDocument(
      file.fileId,
      { ...document, metadata: { title: "整合性のある変更" } },
      { expectedRevision: file.revision },
    );

    expect(result.ok).toBe(true);
    expect(result.revision).toBe(file.revision + 1);
  });

  it("runExclusive serializes concurrent tasks for the same fileId in call order", async () => {
    const order: string[] = [];
    const first = store.runExclusive("file_a", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
      return "first";
    });
    const second = store.runExclusive("file_a", async () => {
      order.push("second-start");
      order.push("second-end");
      return "second";
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("runExclusive does not serialize tasks for different fileIds", async () => {
    const order: string[] = [];
    const slow = store.runExclusive("file_slow", async () => {
      order.push("slow-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow-end");
    });
    const fast = store.runExclusive("file_fast", async () => {
      order.push("fast-start");
      order.push("fast-end");
    });

    await Promise.all([slow, fast]);
    // 別fileIdの"fast"タスクは"slow"タスクの完了を待たずに先に終わる。
    expect(order.indexOf("fast-end")).toBeLessThan(order.indexOf("slow-end"));
  });

  it("runExclusive is reentrant: nesting the same fileId from within a locked callback does not deadlock", async () => {
    const result = await store.runExclusive("file_a", async () => {
      return store.runExclusive("file_a", async () => "nested-ok");
    });
    expect(result).toBe("nested-ok");
  });

  it("runExclusive queues a call from a different async chain even while the lock is held (no flag-based bypass)", async () => {
    // タスクA (承認フロー相当) がロック保持中に停止している間に、別連鎖のタスクB
    // (人間の自動保存相当) を投げる。Bは「実行中だから」とバイパスされてはならず、
    // Aの完了を待ってから実行されること。
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const taskA = store.runExclusive("file_a", async () => {
      order.push("A-start");
      await gateA;
      order.push("A-end");
    });

    // Aがロックを取得してgateAで停止した状態を確定させてから、別連鎖でBを開始する。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["A-start"]);
    const taskB = store.runExclusive("file_a", async () => {
      order.push("B-run");
    });

    // Bを投げてもAの実行区間には割り込まない。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["A-start"]);

    releaseA();
    await Promise.all([taskA, taskB]);
    expect(order).toEqual(["A-start", "A-end", "B-run"]);
  });

  it("a saveDocument from a different chain waits for an in-flight runExclusive section instead of interleaving", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 承認フロー相当: ロック保持中に読み込んだrevisionを前提に、停止後に保存する
    // (この内側のsaveDocumentは同一連鎖からの再入なのでデッドロックしないこと)。
    const approveLike = store.runExclusive(file.fileId, async () => {
      const current = (await store.listFiles()).find((item) => item.fileId === file.fileId)!;
      order.push("approve-read");
      await gate;
      const result = await store.saveDocument(
        file.fileId,
        { ...document, metadata: { title: "承認による保存" } },
        { expectedRevision: current.revision },
      );
      order.push("approve-saved");
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["approve-read"]);

    // 別連鎖からの人間autosave相当。承認フローの区間が終わるまで実行されないこと。
    const autosave = store.saveDocument(file.fileId, {
      ...document,
      metadata: { title: "人間の自動保存" },
    }, { expectedRevision: file.revision }).then((result) => {
      order.push("autosave-saved");
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["approve-read"]);

    release();
    const [approveResult, autosaveResult] = await Promise.all([approveLike, autosave]);

    // 承認フローが先に完走し、承認前のrevisionを束ねたautosaveはその後CASで拒否される。
    expect(order).toEqual(["approve-read", "approve-saved", "autosave-saved"]);
    expect(approveResult.ok).toBe(true);
    expect(autosaveResult).toMatchObject({
      ok: false,
      code: "revision-mismatch",
      currentRevision: file.revision + 1,
    });
    expect((await store.loadDocument(file.fileId))?.metadata.title).toBe("承認による保存");
    const finalFile = (await store.listFiles()).find((item) => item.fileId === file.fileId);
    expect(finalFile?.revision).toBe(file.revision + 1);
  });

  it("rejects a stale renderer save queued behind an approval-shaped runExclusive write", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const staleDocument = (await store.loadDocument(file.fileId)) as SigmaDocument;

    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const approvalWrite = store.runExclusive(file.fileId, async () => {
      const current = (await store.listFiles()).find((item) => item.fileId === file.fileId)!;
      await approvalGate;
      return store.saveDocument(file.fileId, {
        ...staleDocument,
        metadata: { title: "AIの変更" },
      }, { expectedRevision: current.revision });
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const staleAutosave = store.saveDocument(file.fileId, {
      ...staleDocument,
      metadata: { title: "承認前のautosave" },
    }, { expectedRevision: file.revision });

    releaseApproval();
    await expect(approvalWrite).resolves.toMatchObject({ ok: true, revision: file.revision + 1 });
    await expect(staleAutosave).resolves.toMatchObject({
      ok: false,
      code: "revision-mismatch",
      currentRevision: file.revision + 1,
    });
    expect((await store.loadDocument(file.fileId))?.metadata.title).toBe("AIの変更");
  });

  it("continues serializing subsequent tasks even after an earlier queued task throws", async () => {
    const failing = store.runExclusive("file_a", async () => {
      throw new Error("boom");
    });
    const after = store.runExclusive("file_a", async () => "still-runs");

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("still-runs");
  });

  it("writes a doc-block-hashes sidecar after each successful save and keeps only the latest 100 revisions", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    let document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    for (let i = 0; i < 105; i += 1) {
      const saveResult = await store.saveDocument(file.fileId, {
        ...document,
        metadata: { title: `revision ${i}` },
      }, { expectedRevision: file.revision + i });
      expect(saveResult.ok).toBe(true);
      document = (await store.loadDocument(file.fileId)) as SigmaDocument;
    }

    const history = await store.readDocumentBlockHashes(file.fileId);
    expect(history).not.toBeNull();
    expect(history?.fileId).toBe(file.fileId);
    const revisionKeys = Object.keys(history?.revisions ?? {}).map(Number).sort((a, b) => a - b);
    expect(revisionKeys).toHaveLength(100);

    const latestFile = (await store.listFiles()).find((item) => item.fileId === file.fileId);
    expect(latestFile?.revision).toBe(revisionKeys[revisionKeys.length - 1]);
    // 最も古い(初回保存直後の)revisionは剪定されて残っていない。
    expect(revisionKeys[0]).toBeGreaterThan(1);

    const latestHashes = history?.revisions[String(latestFile?.revision)];
    expect(latestHashes?.problem_complex_square_product_range).toEqual(expect.any(String));
  }, 15_000);

  it("readDocumentBlockHashes returns null when no sidecar has been written yet", async () => {
    await expect(store.readDocumentBlockHashes("file_never_saved")).resolves.toBeNull();
  });

  it("keeps the block-hash sidecar append-only and bounded", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    let document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    for (let i = 0; i < 205; i += 1) {
      const saveResult = await store.saveDocument(file.fileId, {
        ...document,
        metadata: { title: `revision ${i}` },
      }, { expectedRevision: file.revision + i });
      expect(saveResult.ok).toBe(true);
      document = (await store.loadDocument(file.fileId)) as SigmaDocument;
    }

    const sidecarPath = path.join(
      userDataDir,
      "data",
      "doc-block-hashes",
      `${encodeURIComponent(file.fileId)}.blockhashes.jsonl`,
    );
    const raw = await fs.readFile(sidecarPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    // 1 行 1 revision。追記型なので保存のたびにファイル全体を書き直さない。
    for (const line of lines) {
      const parsed = JSON.parse(line) as { revision: number; hashes: Record<string, string> };
      expect(typeof parsed.revision).toBe("number");
      expect(typeof parsed.hashes).toBe("object");
    }
    // 上限の 2 倍で圧縮するので、何回保存しても行数は有界。
    expect(lines.length).toBeLessThanOrEqual(200);
    // 圧縮後も読み側は直近 100 revision を返せる。
    const history = await store.readDocumentBlockHashes(file.fileId);
    expect(Object.keys(history?.revisions ?? {})).toHaveLength(100);
  }, 30_000);

  it("writes the sidecar where the proposal store reads it", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    const saved = await store.saveDocument(file.fileId, {
      ...document,
      metadata: { title: "sidecar reader parity" },
    }, { expectedRevision: file.revision });
    expect(saved.ok).toBe(true);
    const revision = saved.ok ? saved.revision : 0;

    // AI 提案の自動 rebase は `LocalMcpEditProposalStore` 側からこの履歴を読む。
    // 書き手と読み手が別々に定数とパーサを持っていた頃、書き手だけ形式を変えたら
    // 読み手が黙って何も読めなくなり、rebase が毎回 blind replay に落ちていた。
    // ここは「書いた場所を、提案ストアと同じ関数で読み直せる」ことを固定する。
    const revisions = await readBlockHashRevisions(
      path.join(userDataDir, "data", "doc-block-hashes"),
      file.fileId,
    );
    expect(revisions).not.toBeNull();
    expect(revisions?.[String(revision)]).toEqual(expect.objectContaining({
      problem_complex_square_product_range: expect.any(String),
    }));
  });

  it("keeps library.json no older than the document body (MCP cache premise)", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    const saveResult = await store.saveDocument(file.fileId, {
      ...document,
      metadata: { title: "mtime check" },
    }, { expectedRevision: file.revision });
    expect(saveResult.ok).toBe(true);

    // mcp/sigma-doc-mcp-store.ts の isDocumentCacheWriteConsistent は
    // 「本文の mtime ≤ 台帳の mtime」で「書き込み途中ではない」を判定する。
    // library.json を「変化時のみ書く」ようにしてもこの関係が崩れてはいけない。
    const libraryStat = await fs.stat(path.join(userDataDir, "data", "library.json"));
    const documentStat = await fs.stat(path.join(
      userDataDir,
      "data",
      "documents",
      `${encodeURIComponent(file.fileId)}.sigmadoc.json`,
    ));
    expect(documentStat.mtimeMs).toBeLessThanOrEqual(libraryStat.mtimeMs);
  });

  it("runExclusive serializes overlapping saves instead of failing the second on CAS", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    // 2 本を同時に投げる。fileId ロックで直列化されるので、2 本目は 1 本目が
    // 進めた revision に一致し、どちらも成功する。
    const [first, second] = await Promise.all([
      store.saveDocument(file.fileId, { ...document, metadata: { title: "first" } }, {
        expectedRevision: file.revision,
      }),
      store.saveDocument(file.fileId, { ...document, metadata: { title: "second" } }, {
        expectedRevision: file.revision + 1,
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const latest = (await store.listFiles()).find((item) => item.fileId === file.fileId);
    expect(latest?.revision).toBe(file.revision + 2);
  });
});

describe("LocalSigmaDocStore orphan document adoption (#312)", () => {
  let userDataDir: string;
  let store: LocalSigmaDocStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-store-orphans-"));
    store = new LocalSigmaDocStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("deleting library.json re-registers all existing bodies", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const titles = ["一次関数のまとめ", "二次関数のまとめ", "三次関数のまとめ"];
    const fileIds = titles.map((_title, index) => `file_${index}`);
    const documentsDir = path.join(userDataDir, "data", "documents");
    await fs.mkdir(documentsDir, { recursive: true });
    for (const [index, title] of titles.entries()) {
      const document: SigmaDocument = { ...createBlankDocument(title), updatedAt: now };
      await fs.writeFile(
        path.join(documentsDir, `${fileIds[index]}.sigmadoc.json`),
        JSON.stringify(document),
        "utf8",
      );
    }
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }],
      folders: [],
      files: fileIds.map((fileId, index) => ({
        fileId,
        workspaceId: "workspace_1",
        folderId: null,
        docId: `doc_${index}`,
        title: titles[index],
        documentPath: `documents/${fileId}.sigmadoc.json`,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })),
    });

    // Simulates the incident's recovery step: library.json is lost/deleted
    // while the document bodies on disk survive untouched.
    await fs.rm(path.join(userDataDir, "data", "library.json"));

    const files = await store.listFiles();
    const library = await readLibrary(userDataDir);

    expect(files.map((file) => file.title).sort()).toEqual([...titles].sort());
    expect(files.some((file) => file.title === "サンプル教材")).toBe(false);
    expect(library.workspaces).toHaveLength(1);
  });

  it("adoption skips fileIds already in the ledger, including soft-deleted ones", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const documentsDir = path.join(userDataDir, "data", "documents");
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.writeFile(
      path.join(documentsDir, "file_a.sigmadoc.json"),
      JSON.stringify(createBlankDocument("教材A")),
      "utf8",
    );
    await fs.writeFile(
      path.join(documentsDir, "file_b.sigmadoc.json"),
      JSON.stringify(createBlankDocument("教材B")),
      "utf8",
    );

    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "",
      workspaces: [],
      folders: [],
      files: [{
        fileId: "file_a",
        workspaceId: "workspace_gone",
        folderId: null,
        docId: "doc_a",
        title: "教材A(論理削除済み)",
        documentPath: "documents/file_a.sigmadoc.json",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      }],
    });

    const files = await store.listFiles();

    // Only the never-before-seen body (B) is adopted; A is already a known
    // fileId (soft-deleted) and must not be resurrected.
    expect(files.map((file) => file.fileId)).toEqual(["file_b"]);

    const library = await readRawLibrary(userDataDir);
    const rowsForA = library.files.filter((file) => (file as Record<string, unknown>).fileId === "file_a");
    expect(rowsForA).toHaveLength(1);
    expect((rowsForA[0] as Record<string, unknown>).deletedAt).not.toBeNull();
  });

  it("adoption skips unparseable bodies and logs orphan-adoption-skipped", async () => {
    const documentsDir = path.join(userDataDir, "data", "documents");
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.writeFile(path.join(documentsDir, "file_broken.sigmadoc.json"), "{not-json", "utf8");
    await fs.writeFile(
      path.join(documentsDir, "file_good.sigmadoc.json"),
      JSON.stringify(createBlankDocument("読み込める教材")),
      "utf8",
    );

    const files = await store.listFiles();

    expect(files.map((file) => file.fileId)).toEqual(["file_good"]);
    expect(files.some((file) => file.title === "サンプル教材")).toBe(false);

    const logPath = path.join(userDataDir, "data", "logs", "ledger.log");
    const logContent = await fs.readFile(logPath, "utf8");
    expect(logContent).toContain("orphan-adoption-skipped");
    expect(logContent).toContain("file_broken");
  });

  it("records an app-generated orphan JSON error in the locale active during recovery", async () => {
    const documentsDir = path.join(userDataDir, "data", "documents");
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.writeFile(path.join(documentsDir, "file_broken.sigmadoc.json"), "{not-json", "utf8");
    await fs.writeFile(
      path.join(documentsDir, "file_good.sigmadoc.json"),
      JSON.stringify(createBlankDocument("Readable material")),
      "utf8",
    );

    try {
      setAppLocale("en");
      await store.listFiles();
      const logContent = await fs.readFile(path.join(userDataDir, "data", "logs", "ledger.log"), "utf8");
      expect(logContent).toContain("The teaching-material JSON is malformed and could not be loaded.");
      expect(logContent).not.toContain("教材JSONの構文が壊れている");
    } finally {
      setAppLocale("ja");
    }
  });

  it("adoption does not run on a normal launch", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    await store.listFiles();

    const documentsDir = path.join(userDataDir, "data", "documents");
    await fs.writeFile(
      path.join(documentsDir, "file_dropped_in.sigmadoc.json"),
      JSON.stringify(createBlankDocument("後から追加された本文")),
      "utf8",
    );

    await store.listFiles();
    const secondFiles = await store.listFiles();

    expect(secondFiles.map((file) => file.fileId)).not.toContain("file_dropped_in");
    const library = await readLibrary(userDataDir);
    expect(library.files.some((file) => file.fileId === "file_dropped_in")).toBe(false);
  });
});

describe("LocalSigmaDocStore write durability (#B4)", () => {
  let userDataDir: string;
  let store: LocalSigmaDocStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-store-durability-"));
    store = new LocalSigmaDocStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("library.json.bak holds the previous contents after each ledger write", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const backupPath = path.join(dataDir, "library.json.bak");

    const overview = await store.getWorkspaceOverview();
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";
    const gen1 = await fs.readFile(libraryPath, "utf8");

    expect((await store.renameWorkspace(workspaceId, "改名1")).state).toBe("ready");
    const gen2 = await fs.readFile(libraryPath, "utf8");
    expect(await fs.readFile(backupPath, "utf8")).toBe(gen1);
    expect(gen2).not.toBe(gen1);

    expect((await store.renameWorkspace(workspaceId, "改名2")).state).toBe("ready");
    const gen3 = await fs.readFile(libraryPath, "utf8");
    expect(await fs.readFile(backupPath, "utf8")).toBe(gen2);
    expect(gen3).not.toBe(gen2);
  });

  it("a corrupt library.json with a valid .bak is restored, the corrupt bytes land in data/recovery/, and no workspace is auto-created", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const overview = await store.getWorkspaceOverview();
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";
    // .bak は「1世代前」を保持するローリングバックアップであり、同一内容の書き直しは
    // 節約される (#B4 5.)。initializeWorkspace直後の1回目のリネームでは.bakの中身は
    // まだ変わらない (直前の内容と同じため書き込みが省かれる) ので、.bakが実際に
    // 「改名前」世代を持つのは2回目のリネームの後になる。
    expect((await store.renameWorkspace(workspaceId, "改名前")).state).toBe("ready");
    expect((await store.renameWorkspace(workspaceId, "改名後")).state).toBe("ready");

    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const corrupted = "{not-json-at-all";
    await fs.writeFile(libraryPath, corrupted, "utf8");

    const restoredOverview = await store.getWorkspaceOverview();
    expect(restoredOverview.state).toBe("ready");
    expect(restoredOverview.state === "ready" ? restoredOverview.overview.workspaces.length : -1).toBe(1);
    expect(restoredOverview.state === "ready"
      ? restoredOverview.overview.workspaces[0]?.name
      : null).toBe("改名前");

    const recoveryDir = path.join(dataDir, "recovery");
    const recoveryFiles = (await fs.readdir(recoveryDir)).filter((name) => name.startsWith("library-"));
    expect(recoveryFiles).toHaveLength(1);
    expect(await fs.readFile(path.join(recoveryDir, recoveryFiles[0] ?? ""), "utf8")).toBe(corrupted);

    const logContent = await fs.readFile(path.join(dataDir, "logs", "ledger.log"), "utf8");
    expect(logContent).toContain("ledger-corrupt-preserved");
    expect(logContent).toContain("ledger-restored-from-backup");
  });

  it("returns the v3 .bak schema failure when library.json is corrupt without rewriting either ledger", async () => {
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const backupPath = path.join(dataDir, "library.json.bak");
    const corrupted = "{not-json-at-all";
    const backupRaw = JSON.stringify({
      version: 3,
      activeWorkspaceId: "",
      workspaces: [],
      folders: [],
      files: [],
    });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(libraryPath, corrupted, "utf8");
    await fs.writeFile(backupPath, backupRaw, "utf8");

    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ledger-schema-error");
    expect(result.state === "ledger-schema-error" ? result.failure : null).toMatchObject({
      libraryPath: backupPath,
      expectedVersion: 4,
      actualVersion: 3,
      violations: [expect.objectContaining({ path: "version" })],
    });
    await expect(fs.readFile(libraryPath, "utf8")).resolves.toBe(corrupted);
    await expect(fs.readFile(backupPath)).resolves.toEqual(Buffer.from(backupRaw));
    await expect(fs.readdir(path.join(dataDir, "documents"))).resolves.toEqual([]);
    const recoveryFiles = (await fs.readdir(path.join(dataDir, "recovery")))
      .filter((name) => name.startsWith("library-"));
    expect(recoveryFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(dataDir, "recovery", recoveryFiles[0] ?? ""), "utf8"))
      .resolves.toBe(corrupted);
  });

  it("a corrupt library.json with no .bak still throws and overwrites nothing", async () => {
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const malformedLibrary = '{"version":3,"files":[';
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(libraryPath, malformedLibrary, "utf8");

    await expect(store.initializeWorkspace({ initialDocument: sampleDocument }))
      .rejects.toThrow("教材ライブラリの索引が破損しています");
    await expect(fs.readFile(libraryPath, "utf8")).resolves.toBe(malformedLibrary);
    await expect(fs.readdir(path.join(dataDir, "documents"))).resolves.toEqual([]);
  });

  it("returns a structured error for a v3 .bak when library.json is missing without writing data", async () => {
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const backupPath = path.join(dataDir, "library.json.bak");
    const raw = JSON.stringify({
      version: 3,
      activeWorkspaceId: "",
      workspaces: [],
      folders: [],
      files: [],
    });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(backupPath, raw, "utf8");

    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ledger-schema-error");
    expect(result.state === "ledger-schema-error" ? result.failure : null).toMatchObject({
      libraryPath: backupPath,
      expectedVersion: 4,
      actualVersion: 3,
      violations: [expect.objectContaining({ path: "version" })],
    });
    await expectBackupSchemaViolationReadToBeWriteFree(dataDir, libraryPath, backupPath, raw);
  });

  it("creates a new library when both library.json and its .bak are missing", async () => {
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");

    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ready");
    await expect(fs.access(libraryPath)).resolves.toBeUndefined();
    expect((await readLibrary(userDataDir)).version).toBe(4);
    expect((await fs.readdir(path.join(dataDir, "documents"))).filter((name) => name.endsWith(".sigmadoc.json")))
      .toHaveLength(1);
  });

  it("restores a valid v4 .bak when library.json is missing", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const dataDir = path.join(userDataDir, "data");
    const documentsDir = path.join(dataDir, "documents");
    const libraryPath = path.join(dataDir, "library.json");
    const backupPath = path.join(dataDir, "library.json.bak");
    const backupLibrary = {
      version: 4,
      activeWorkspaceId: "workspace_backup",
      workspaces: [{
        id: "workspace_backup",
        name: "バックアップ教材",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }],
      folders: [{
        id: "folder_backup",
        workspaceId: "workspace_backup",
        parentFolderId: null,
        name: "保存フォルダ",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }],
      files: [{
        fileId: "file_backup",
        workspaceId: "workspace_backup",
        folderId: "folder_backup",
        docId: sampleDocument.docId,
        title: "保存教材",
        documentPath: "documents/file_backup.sigmadoc.json",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }],
    };
    const backupRaw = JSON.stringify(backupLibrary, null, 2);
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.writeFile(backupPath, backupRaw, "utf8");
    await fs.writeFile(
      path.join(documentsDir, "file_backup.sigmadoc.json"),
      JSON.stringify(sampleDocument),
      "utf8",
    );

    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ready");
    expect(result.state === "ready" ? result.overview : null).toMatchObject({
      activeWorkspaceId: "workspace_backup",
      workspaces: [expect.objectContaining({ id: "workspace_backup", name: "バックアップ教材" })],
      folders: [expect.objectContaining({ id: "folder_backup", name: "保存フォルダ" })],
      files: [expect.objectContaining({ fileId: "file_backup", title: "保存教材" })],
    });
    await expect(fs.access(libraryPath)).rejects.toThrow();
    await expect(fs.readFile(backupPath, "utf8")).resolves.toBe(backupRaw);
  });

  it("returns a structured error for a v3 ledger without modifying ledger files", async () => {
    const raw = JSON.stringify({
      version: 3,
      activeWorkspaceId: "",
      workspaces: [],
      folders: [],
      files: [],
    });
    const { dataDir, libraryPath } = await writeSchemaViolationLibrary(userDataDir, raw);

    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ledger-schema-error");
    expect(result.state === "ledger-schema-error" ? result.failure.violations[0]?.path : null)
      .toBe("version");
    await expectSchemaViolationReadToBeWriteFree(dataDir, libraryPath, raw);
  });

  it("returns a structured error for a legacy workspace field without modifying ledger files", async () => {
    const raw = JSON.stringify({
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{ id: "workspace_1", kind: "cloud" }],
      folders: [],
      files: [],
    });
    const { dataDir, libraryPath } = await writeSchemaViolationLibrary(userDataDir, raw);

    const result = await store.getWorkspaceOverview();

    expect(result.state).toBe("ledger-schema-error");
    expect(result.state === "ledger-schema-error" ? result.failure.violations[0]?.path : null)
      .toBe("workspaces[0].kind");
    await expectSchemaViolationReadToBeWriteFree(dataDir, libraryPath, raw);
  });

  it("throws for a v3 ledger during initialization and releases the ledger lock", async () => {
    const raw = JSON.stringify({
      version: 3,
      activeWorkspaceId: "",
      workspaces: [],
      folders: [],
      files: [],
    });
    const { dataDir } = await writeSchemaViolationLibrary(userDataDir, raw);

    await expect(store.initializeWorkspace({ initialDocument: sampleDocument }))
      .rejects.toMatchObject({
        failure: expect.objectContaining({
          expectedVersion: 4,
          violations: [expect.objectContaining({ path: "version" })],
        }),
      });
    await expect(fs.access(path.join(dataDir, "locks", "library.lock"))).rejects.toThrow();
  });

  it("document bodies are written atomically and leave no .tmp behind", async () => {
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    expect(file).toBeDefined();
    let document = (await store.loadDocument(file.fileId)) as SigmaDocument;

    for (let i = 0; i < 5; i += 1) {
      const result = await store.saveDocument(
        file.fileId,
        { ...document, metadata: { title: `保存${i}` } },
        { expectedRevision: file.revision + i },
      );
      expect(result.ok).toBe(true);
      document = (await store.loadDocument(file.fileId)) as SigmaDocument;
    }

    const documentsDir = path.join(userDataDir, "data", "documents");
    const entries = await fs.readdir(documentsDir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((name) => name.endsWith(".sigmadoc.json"))).toBe(true);
    expect(entries.some((name) => name.includes(".tmp"))).toBe(false);
    expect((await store.loadDocument(file.fileId))?.metadata.title).toBe("保存4");

    // atomicity自体を確認する: renameだけが失敗するケースでも、本文ファイルは
    // (plainなfs.writeFileで直接上書きするのではなく、tmpへ書いてからrenameする
    // ことで) 半端な内容に書き換わらず、直前の内容のまま残ること。
    const documentPath = path.join(documentsDir, `${encodeURIComponent(file.fileId)}.sigmadoc.json`);
    const beforeFailedWrite = await fs.readFile(documentPath, "utf8");
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated rename failure"));
    try {
      const crashResult = await store.saveDocument(
        file.fileId,
        { ...document, metadata: { title: "クラッシュ後" } },
        { expectedRevision: file.revision + 5 },
      );
      expect(crashResult.ok).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
    expect(await fs.readFile(documentPath, "utf8")).toBe(beforeFailedWrite);
    expect((await fs.readdir(documentsDir)).some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("a create whose body write fails leaves a visible ledger row, not an invisible orphan", async () => {
    // 先に1件正常に作っておき、ensureLibraryのサンプル教材自動生成分岐を通り過ぎて
    // おく — このテストはcreateFileFromDocument自身の行優先順序だけを見たいため。
    await store.initializeWorkspace({ initialDocument: sampleDocument });

    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [filePath] = args;
      if (typeof filePath === "string" && filePath.includes(path.join("data", "documents"))) {
        throw new Error("disk full (simulated)");
      }
      return realFsWriteFile(...args);
    });

    try {
      await expect(store.createFileFromDocument({
        document: createBlankDocument("本文書き込み失敗テスト"),
      })).rejects.toThrow("disk full");
    } finally {
      spy.mockRestore();
    }

    const library = await readLibrary(userDataDir);
    const row = library.files.find((item) => item.title === "本文書き込み失敗テスト");
    expect(row).toBeDefined();

    // 台帳の行は可視のまま残る (=孤児本文ではなく孤児"行"になる、診断可能な形)。
    const result = await store.loadDocumentWithRecovery(row!.fileId);
    expect(result.ok).toBe(false);
  });

  it("a freshly created document's body mtime never outpaces library.json's mtime", async () => {
    // MCPの読み込みキャッシュ (mcp/sigma-doc-mcp-store.ts の
    // isDocumentCacheWriteConsistent) は「本文のmtime <= 台帳のmtime」を、保存が
    // 競合中でないことの目印として使っている。作成経路は安全性のため行→本文の
    // 順で書くので本文の方が新しくなりがちだが、そのままだと新規作成教材が
    // 恒久的にキャッシュ対象外になってしまう (#B4での回帰)。作成後は台帳ファイルの
    // mtimeを本文の書き込み後まで進めて、この目印を壊さないこと。
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const created = await store.createFileFromDocument({ document: createBlankDocument("mtime確認用教材") });

    const dataDir = path.join(userDataDir, "data");
    const libraryStat = await fs.stat(path.join(dataDir, "library.json"));
    const documentStat = await fs.stat(path.join(dataDir, created.file.documentPath ?? ""));
    expect(documentStat.mtimeMs).toBeLessThanOrEqual(libraryStat.mtimeMs);
  });

  it("reconcile does not soft-delete a row whose body is missing inside the grace window", async () => {
    const recentCreatedAt = new Date().toISOString();
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: recentCreatedAt,
        updatedAt: recentCreatedAt,
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_pending",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_pending",
        title: "作成直後の教材",
        documentPath: "documents/file_pending.sigmadoc.json",
        revision: 1,
        createdAt: recentCreatedAt,
        updatedAt: recentCreatedAt,
        deletedAt: null,
      }],
    });
    // documents/file_pending.sigmadoc.json はまだ存在しない (=行が本文より先行している最中)。

    const events: LocalStoreChangeEvent[] = [];
    await (store as unknown as StoreReconcileInternals).reconcileDocumentFile(
      "file_pending",
      (event) => events.push(event),
    );

    const library = await readRawLibrary(userDataDir);
    const row = library.files.find((item) => (item as Record<string, unknown>).fileId === "file_pending") as Record<string, unknown>;
    expect(row.deletedAt).toBeNull();
    expect(events).toEqual([{ type: "document", fileId: "file_pending", change: "changed", timestamp: expect.any(Number) }]);

    const logContent = await fs.readFile(path.join(userDataDir, "data", "logs", "ledger.log"), "utf8");
    expect(logContent).toContain("file-body-missing");
  });

  it("reconcile keeps the row and only notifies when an external edit leaves the body unreadable", async () => {
    // AIやエディタが外部から本文を直している途中/直しきれていない状態。ここで例外を
    // 投げても void 呼び出しのウォッチャからは誰も受け取れないので、行は触らず
    // 変更通知だけ流して renderer に読み直させる。
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const [file] = await store.listFiles();
    const documentPath = path.join(userDataDir, "data", file.documentPath ?? "");

    for (const body of ["{broken", JSON.stringify({ ...structuredClone(sampleDocument), pageLayout: { preset: "scroll" } })]) {
      await fs.writeFile(documentPath, body, "utf8");
      const events: LocalStoreChangeEvent[] = [];
      await expect((store as unknown as StoreReconcileInternals).reconcileDocumentFile(
        file.fileId,
        (event) => events.push(event),
      )).resolves.toBeUndefined();

      expect(events).toEqual([{ type: "document", fileId: file.fileId, change: "changed", timestamp: expect.any(Number) }]);
      const [reloaded] = await store.listFiles();
      expect(reloaded).toMatchObject({ fileId: file.fileId, revision: file.revision, title: file.title });
      expect(await fs.readFile(documentPath, "utf8")).toBe(body);
    }

    const logContent = await fs.readFile(path.join(userDataDir, "data", "logs", "ledger.log"), "utf8");
    expect(logContent).toContain("file-body-unreadable-by-reconcile");
  });

  it("reconcile does soft-delete a row whose body is missing after the grace window has elapsed", async () => {
    const oldCreatedAt = "2020-01-01T00:00:00.000Z";
    await writeRawLibrary(userDataDir, {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_aged",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_aged",
        title: "古い教材",
        documentPath: "documents/file_aged.sigmadoc.json",
        revision: 1,
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
        deletedAt: null,
      }],
    });
    // documents/file_aged.sigmadoc.json は存在しない (外部で削除された想定)。

    const events: LocalStoreChangeEvent[] = [];
    await (store as unknown as StoreReconcileInternals).reconcileDocumentFile(
      "file_aged",
      (event) => events.push(event),
    );

    const library = await readRawLibrary(userDataDir);
    const row = library.files.find((item) => (item as Record<string, unknown>).fileId === "file_aged") as Record<string, unknown>;
    expect(row.deletedAt).not.toBeNull();
    expect(events).toEqual([{ type: "document", fileId: "file_aged", change: "deleted", timestamp: expect.any(Number) }]);

    const logContent = await fs.readFile(path.join(userDataDir, "data", "logs", "ledger.log"), "utf8");
    expect(logContent).toContain("file-soft-deleted-by-reconcile");
  });

  it("adoption is skipped when the ledger was restored from .bak", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const dataDir = path.join(userDataDir, "data");
    const documentsDir = path.join(dataDir, "documents");
    await fs.mkdir(documentsDir, { recursive: true });

    // file_kept: バックアップ世代の台帳が既に知っている、ソフトデリート済みの行。
    await fs.writeFile(
      path.join(documentsDir, "file_kept.sigmadoc.json"),
      JSON.stringify(createBlankDocument("削除済み教材")),
      "utf8",
    );
    // file_orphan: どの台帳行からも参照されていない孤児本文。もし孤児採用
    // (adoptOrphanDocumentFiles) が走ってしまえば新しい行として復活する
    // — .bak復元時にそれが起きないことを確認するのがこのテストの核心。
    await fs.writeFile(
      path.join(documentsDir, "file_orphan.sigmadoc.json"),
      JSON.stringify(createBlankDocument("孤児教材")),
      "utf8",
    );

    const backupLibrary = {
      version: 4,
      activeWorkspaceId: "workspace_1",
      workspaces: [{
        id: "workspace_1",
        name: "マイ教材",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }],
      folders: [],
      files: [{
        fileId: "file_kept",
        workspaceId: "workspace_1",
        folderId: null,
        docId: "doc_kept",
        title: "削除済み教材",
        documentPath: "documents/file_kept.sigmadoc.json",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      }],
    };
    await fs.writeFile(path.join(dataDir, "library.json.bak"), JSON.stringify(backupLibrary, null, 2), "utf8");
    // library.json 自体は存在しない (クラッシュ/誤操作で失われた想定)。.bak のみ残る。

    const files = await store.listFiles();
    expect(files).toEqual([]);

    // 復元済みの状態をディスクへ実際に書き戻させて、直接検証できるようにする。
    expect((await store.renameWorkspace("workspace_1", "マイ教材2")).state).toBe("ready");

    const library = await readRawLibrary(userDataDir);
    const keptRow = library.files.find((item) => (item as Record<string, unknown>).fileId === "file_kept") as Record<string, unknown>;
    expect(keptRow).toBeDefined();
    expect(keptRow.deletedAt).toBe(now);
    expect(library.files.some((item) => (item as Record<string, unknown>).fileId === "file_orphan")).toBe(false);

    const logContent = await fs.readFile(path.join(dataDir, "logs", "ledger.log"), "utf8");
    expect(logContent).toContain("ledger-restored-from-backup");
    expect(logContent).not.toContain("orphan-documents-adopted");
  });
});

describe("ledger serialization", () => {
  let userDataDir: string;
  // テスト用に短縮したロックのチューニング (本番の既定値は staleMs=10s/timeoutMs=15s)。
  const FAST_LOCK = { staleMs: 2_000, timeoutMs: 4_000, heartbeatMs: 100 };

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-store-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("two store instances over one data dir never lose ledger rows", async () => {
    // vitest の1プロセス内でも、別々の LocalSigmaDocStore インスタンスは
    // 独立したin-processキューを持つ — つまりこれは file-lock.ts 経由の
    // クロスプロセスロック機構を実際に運動させる。
    const storeA = new LocalSigmaDocStore(userDataDir, { ledgerLock: FAST_LOCK });
    const storeB = new LocalSigmaDocStore(userDataDir, { ledgerLock: FAST_LOCK });

    // 先に1件だけ確立しておき、両インスタンスが同じ土台 (デフォルトワークスペース+
    // サンプル教材1件) を見ている状態から、後続の10件+10件の並行作成に集中する。
    await storeA.initializeWorkspace({ initialDocument: sampleDocument });

    const creates: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      creates.push(storeA.createDocument({ title: `A-${i}` }));
    }
    for (let i = 0; i < 10; i += 1) {
      creates.push(storeB.createDocument({ title: `B-${i}` }));
    }
    await Promise.all(creates);

    const expectedCount = 1 + 20;
    const library = await readLibrary(userDataDir);
    expect(library.files).toHaveLength(expectedCount);
    expect(new Set(library.files.map((file) => file.fileId)).size).toBe(expectedCount);

    const documentsDir = path.join(userDataDir, "data", "documents");
    const bodies = await fs.readdir(documentsDir);
    expect(bodies).toHaveLength(expectedCount);
  });

  it("a stale-snapshot rewrite from a second instance cannot rewind newly appended rows", async () => {
    const storeA = new LocalSigmaDocStore(userDataDir, { ledgerLock: FAST_LOCK });
    const storeB = new LocalSigmaDocStore(userDataDir, { ledgerLock: FAST_LOCK });

    await storeA.initializeWorkspace({ initialDocument: sampleDocument });
    const overview = await storeA.getWorkspaceOverview();
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";
    expect(workspaceId).not.toBe("");

    // B が新規作成 (台帳への行追加) している間に、A側では
    // getWorkspaceOverview/renameWorkspace という「台帳全体を読み直して書き戻す」
    // 操作を割り込ませる。B の新規行が A のこれらの操作に巻き戻されないこと。
    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i += 1) {
      operations.push(storeB.createDocument({ title: `B-${i}` }));
      operations.push(storeA.getWorkspaceOverview());
      operations.push(storeA.renameWorkspace(workspaceId, `改名-${i}`));
    }
    await Promise.all(operations);

    const expectedCount = 1 + 8;
    const library = await readLibrary(userDataDir);
    expect(library.files).toHaveLength(expectedCount);
    expect(new Set(library.files.map((file) => file.fileId)).size).toBe(expectedCount);

    const documentsDir = path.join(userDataDir, "data", "documents");
    const bodies = await fs.readdir(documentsDir);
    expect(bodies).toHaveLength(expectedCount);
  });

  it("recovers abandoned v2 lock metadata under native ownership and logs it once", async () => {
    const store = new LocalSigmaDocStore(userDataDir, {
      ledgerLock: { staleMs: 200, timeoutMs: 3_000, heartbeatMs: 50 },
    });
    const dataDir = path.join(userDataDir, "data");
    const locksDir = path.join(dataDir, "locks");
    await fs.mkdir(locksDir, { recursive: true });
    const lockPath = path.join(locksDir, "library.lock");
    // v2 の排他権は .mutex にある。OS ロックを持たない残骸は PID が生存中でも
    // 回収できるが、旧 v1 の生存 PID は次のテストのとおり保護する。
    const bogusPayload = {
      version: 2,
      lockId: "bogus-lock-id",
      pid: process.pid,
      host: os.hostname(),
      op: "pre-existing-bogus",
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(bogusPayload), "utf8");

    const workspace = await store.initializeWorkspace({ initialDocument: sampleDocument });
    expect(workspace.activeFileId).toEqual(expect.any(String));

    const logContent = await fs.readFile(path.join(dataDir, "logs", "ledger.log"), "utf8");
    const events = logContent.trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(events.filter((entry) => entry.event === "ledger-lock-broken")).toHaveLength(1);
  });

  it("a live-owner lock causes a clear timeout error rather than a clobber", async () => {
    const store = new LocalSigmaDocStore(userDataDir, {
      ledgerLock: { staleMs: 10_000, timeoutMs: 200, heartbeatMs: 50 },
    });
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const dataDir = path.join(userDataDir, "data");
    const libraryPath = path.join(dataDir, "library.json");
    const before = await fs.readFile(libraryPath, "utf8");

    const locksDir = path.join(dataDir, "locks");
    await fs.mkdir(locksDir, { recursive: true });
    const lockPath = path.join(locksDir, "library.lock");
    // このテストプロセス自身のpid = 確実に生存中なので、staleMs/pid死亡どちらの
    // 判定でも奪われない「今まさに使用中」のロックを再現する。
    const livePayload = {
      version: 1,
      lockId: "live-owner-lock-id",
      pid: process.pid,
      host: os.hostname(),
      op: "long-running",
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(livePayload), { flag: "wx" });

    const result = await store.renameWorkspace("does-not-matter", "改名できないはず");
    expect(result.state).toBe("error");
    expect(result.state === "error" ? result.error : "").toMatch(/タイムアウト/);

    const after = await fs.readFile(libraryPath, "utf8");
    expect(after).toBe(before);
  });

  it("the lock is released when the transaction throws", async () => {
    const store = new LocalSigmaDocStore(userDataDir, { ledgerLock: FAST_LOCK });
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const overview = await store.getWorkspaceOverview();
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";

    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [filePath] = args;
      if (typeof filePath === "string" && filePath.includes("library.json") && !filePath.includes(".bak")) {
        throw new Error("simulated write failure inside the ledger transaction");
      }
      return realFsWriteFile(...args);
    });
    let failing: Awaited<ReturnType<typeof store.renameWorkspace>>;
    try {
      failing = await store.renameWorkspace(workspaceId, "失敗するはずの改名");
    } finally {
      spy.mockRestore();
    }
    expect(failing.state).toBe("error");

    const lockPath = path.join(userDataDir, "data", "locks", "library.lock");
    await expect(fs.access(lockPath)).rejects.toThrow();

    // ロックが解放されていれば、続く操作は (前の失敗を待たされることなく) すぐ成功する。
    const following = await store.renameWorkspace(workspaceId, "成功するはずの改名");
    expect(following.state).toBe("ready");
  });

  it("nested ledger operations join the outer transaction without deadlocking", async () => {
    // initializeWorkspace (withLedger) → readWorkspace → saveWorkspaceWithLibrary
    // (これ自身も withLedger) というネストしたトランザクションを実際に運動させる。
    // join が壊れていれば、同じ in-process キューを内側から待つ形になり
    // 自己デッドロックしてタイムアウトまで進行が止まる。timeoutMsを短く設定し、
    // それよりずっと速く完了することでjoinが機能していることを確認する。
    const store = new LocalSigmaDocStore(userDataDir, {
      ledgerLock: { staleMs: 5_000, timeoutMs: 300, heartbeatMs: 50 },
    });
    const startedAt = Date.now();
    const workspace = await store.initializeWorkspace({ initialDocument: sampleDocument });
    const elapsed = Date.now() - startedAt;

    expect(workspace.activeFileId).toEqual(expect.any(String));
    expect(elapsed).toBeLessThan(300);
  });
});

async function readLibrary(userDataDir: string): Promise<LibraryFixture> {
  return JSON.parse(await fs.readFile(path.join(userDataDir, "data", "library.json"), "utf8")) as LibraryFixture;
}

async function readWorkspace(userDataDir: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(userDataDir, "data", "workspace.json"), "utf8")) as unknown;
}

interface RawLibraryFixture {
  version: number;
  activeWorkspaceId: string;
  workspaces: unknown[];
  folders: unknown[];
  // Intentionally `unknown`, not `unknown[]`: some fixtures deliberately write a
  // non-array value here to exercise the whole-array-quarantine path.
  files: unknown;
  quarantine?: unknown[];
}

interface RawLibrary {
  version: number;
  activeWorkspaceId: string;
  workspaces: unknown[];
  folders: unknown[];
  files: unknown[];
  quarantine?: unknown[];
}

/** ここで書くのは意図的に壊れた/未来のフィールドを含む library.json であり、
 * parseLibrary の寛容さを検証するためのもの。LibraryFixture 型の厳密さでは
 * これらの形は表現できないため、専用の緩い型を使う。 */
async function writeRawLibrary(userDataDir: string, value: RawLibraryFixture): Promise<void> {
  const dataDir = path.join(userDataDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "library.json"), JSON.stringify(value, null, 2), "utf8");
}

async function readRawLibrary(userDataDir: string): Promise<RawLibrary> {
  return JSON.parse(await fs.readFile(path.join(userDataDir, "data", "library.json"), "utf8")) as RawLibrary;
}

async function writeSchemaViolationLibrary(
  userDataDir: string,
  raw: string,
): Promise<{ dataDir: string; libraryPath: string }> {
  const dataDir = path.join(userDataDir, "data");
  const libraryPath = path.join(dataDir, "library.json");
  await fs.mkdir(path.join(dataDir, "recovery"), { recursive: true });
  await fs.writeFile(libraryPath, raw, "utf8");
  return { dataDir, libraryPath };
}

async function expectSchemaViolationReadToBeWriteFree(
  dataDir: string,
  libraryPath: string,
  expectedRaw: string,
): Promise<void> {
  await expect(fs.readFile(libraryPath, "utf8")).resolves.toBe(expectedRaw);
  await expect(fs.readdir(path.join(dataDir, "recovery"))).resolves.toEqual([]);
  await expect(fs.access(path.join(dataDir, "library.json.bak"))).rejects.toThrow();
}

async function expectBackupSchemaViolationReadToBeWriteFree(
  dataDir: string,
  libraryPath: string,
  backupPath: string,
  expectedRaw: string,
): Promise<void> {
  await expect(fs.access(libraryPath)).rejects.toThrow();
  await expect(fs.readFile(backupPath)).resolves.toEqual(Buffer.from(expectedRaw));
  await expect(fs.readdir(path.join(dataDir, "documents"))).resolves.toEqual([]);
  await expect(fs.access(path.join(dataDir, "recovery"))).rejects.toThrow();
}
