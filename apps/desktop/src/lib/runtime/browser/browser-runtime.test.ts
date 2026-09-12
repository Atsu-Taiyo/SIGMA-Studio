import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBlankDocument } from "@/lib/blank-document";
import { sampleDocument } from "@/lib/sample-document";
import type { DesktopStorageChangeEvent } from "@/types/desktop";

import { createBrowserRuntime } from "./browser-runtime";
import { createStorageChangeChannel } from "./change-channel";
import { createMemoryStoreBackend } from "./memory-backend";
import type { BrowserStoreBackend } from "./store-backend";
import type { AppRuntime } from "../types";

function createRuntime(backend: BrowserStoreBackend): AppRuntime {
  return createBrowserRuntime({
    backend,
    channel: createStorageChangeChannel(),
    persistent: true,
  });
}

function failVersionWrites(backend: BrowserStoreBackend, message: string): BrowserStoreBackend {
  return {
    read: (stores, run) => backend.read(stores, run),
    write: (stores, run) => backend.write(stores, (tx) => run({
      ...tx,
      put: (store, key, value) => (
        store === "documentVersionMetadata" || store === "documentVersionSnapshots"
          ? Promise.reject(new Error(message))
          : tx.put(store, key, value)
      ),
      delete: (store, key) => (
        store === "documentVersionMetadata" || store === "documentVersionSnapshots"
          ? Promise.reject(new Error(message))
          : tx.delete(store, key)
      ),
    })),
  };
}

function installTestWebLocks(): void {
  const queues = new Map<string, Promise<void>>();
  vi.stubGlobal("navigator", {
    locks: {
      request<T>(name: string, run: () => Promise<T>): Promise<T> {
        const prior = queues.get(name) ?? Promise.resolve();
        const next = prior.catch(() => undefined).then(run);
        const tail = next.then(() => undefined, () => undefined);
        queues.set(name, tail);
        void tail.then(() => {
          if (queues.get(name) === tail) queues.delete(name);
        });
        return next;
      },
    },
  });
}

describe("browser runtime", () => {
  let backend: BrowserStoreBackend;
  let runtime: AppRuntime;

  beforeEach(() => {
    backend = createMemoryStoreBackend();
    runtime = createRuntime(backend);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("numbers new materials without diverging from the document title", async () => {
    await runtime.library.initializeWorkspace();
    const first = await runtime.library.createDocument({ title: "教材" });
    const second = await runtime.library.createDocument({ title: "教材" });
    expect(first.metadata.title).toBe("教材");
    expect(second.metadata.title).toBe("教材 2");
    expect(second.document.metadata.title).toBe(second.metadata.title);
  });

  it("retains a draft changed after the close operation inspected it", async () => {
    await runtime.library.initializeWorkspace();
    const created = await runtime.library.createDocument();
    await runtime.library.saveDocument(created.fileId, { ...created.document, metadata: { title: "残す教材" } }, { expectedRevision: created.metadata.revision });
    expect(await runtime.library.deleteFile(created.fileId, { expectedRevision: created.metadata.revision })).toMatchObject({ ok: false, code: "revision-mismatch" });
    expect((await runtime.library.listFiles()).find((file) => file.fileId === created.fileId)?.title).toBe("残す教材");
  });

  it("reports itself as the web target with browser storage", () => {
    expect(runtime.target).toBe("web");
    expect(runtime.capabilities).toMatchObject({
      desktopStorage: false,
      browserStorage: true,
      mcpProposals: false,
    });
  });

  it("opens the English guide and calculator test on first start", async () => {
    const initialized = await runtime.library.initializeWorkspace();

    expect(initialized.ok).toBe(true);
    const files = await runtime.library.listFiles();
    expect(files.map((file) => file.title)).toEqual([
      "Sigma Studio basics",
      "Math Test – Calculator Questions",
    ]);
    expect(initialized.ok && initialized.state.openFileIds).toEqual(files.map((file) => file.fileId));
    expect(initialized.ok && initialized.state.activeFileId).toBe(files[0].fileId);

    const guide = await runtime.library.loadDocumentWithRecovery(files[0].fileId);
    expect(guide.ok && JSON.stringify(guide.document)).toContain("Write and format content in a block editor.");
    expect(guide.ok && JSON.stringify(guide.document)).toContain("Drop it beside another block to create columns.");
    expect(guide.ok && JSON.stringify(guide.document)).toContain("use your browser’s print dialog to save it as a PDF.");
    expect(guide.ok && JSON.stringify(guide.document)).not.toMatch(/[ぁ-んァ-ン一-龯]/);

    const overview = await runtime.workspace.listOverview();
    expect(overview.state).toBe("ready");
    expect(overview.state === "ready" && overview.overview.workspaces).toHaveLength(1);
  });

  it("does not duplicate the initial documents when starting again", async () => {
    await runtime.library.initializeWorkspace();
    await runtime.library.initializeWorkspace();

    expect(await runtime.library.listFiles()).toHaveLength(2);
  });

  it("replaces the distributed legacy calculator test with the current pinned material", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    expect(initialized.ok).toBe(true);
    const files = await runtime.library.listFiles();
    const mathFile = files.find((file) => file.title === "Math Test – Calculator Questions");
    expect(mathFile).toBeDefined();

    const current = await runtime.library.loadDocumentWithRecovery(mathFile!.fileId);
    expect(current.ok).toBe(true);
    const legacy = current.ok
      ? {
          ...current.document,
          content: [{
            id: "p_91633144-59ac-4fae-9ce4-3ba48d128db9",
            type: "paragraph" as const,
            children: [],
          }],
        }
      : createBlankDocument("Math Test – Calculator Questions");
    await backend.write(["documents"], (tx) => tx.put("documents", mathFile!.fileId, {
      fileId: mathFile!.fileId,
      document: legacy,
      updatedAt: legacy.updatedAt ?? new Date().toISOString(),
    }));

    const restored = await runtime.library.initializeWorkspace();
    const migrated = await runtime.library.loadDocumentWithRecovery(mathFile!.fileId);

    expect(restored.ok && restored.state.openFileIds).toContain(mathFile!.fileId);
    expect(migrated.ok && migrated.document.docId).toBe(legacy.docId);
    expect(migrated.ok && migrated.revision).toBe(2);
    expect(migrated.ok && migrated.document.content[0]?.id).toBe("ai3_sat_title");
    expect(migrated.ok && JSON.stringify(migrated.document)).toContain("ai_coord_problem_retry");
  });

  it("restores the two pinned tabs on every start without closing the current tab", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    expect(initialized.ok).toBe(true);
    const pinnedFileIds = initialized.ok ? initialized.state.openFileIds : [];
    const current = await runtime.library.createDocument({ title: "作業中" });
    await runtime.library.saveWorkspace({ openFileIds: [current.fileId], activeFileId: current.fileId });

    const restored = await runtime.library.initializeWorkspace();

    expect(restored.ok && restored.state.openFileIds).toEqual([...pinnedFileIds, current.fileId]);
    expect(restored.ok && restored.state.activeFileId).toBe(current.fileId);
  });

  it("recreates a pinned document after it is deleted", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const deletedFileId = initialized.ok ? initialized.state.openFileIds[0] : "";
    await runtime.library.deleteFile(deletedFileId);

    const restored = await runtime.library.initializeWorkspace();
    const files = await runtime.library.listFiles();

    expect(files.map((file) => file.title)).toEqual([
      "Sigma Studio basics",
      "Math Test – Calculator Questions",
    ]);
    expect(restored.ok && restored.state.openFileIds).toHaveLength(2);
    expect(restored.ok && restored.state.openFileIds[0]).not.toBe(deletedFileId);
  });

  /** 「再読み込みしても消えない」の最小形。保管層を共有した別ランタイムから読み直す。 */
  it("keeps documents across a fresh runtime over the same store", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    const saved = await runtime.library.saveDocument(
      fileId,
      { ...createBlankDocument("保存した教材"), docId: "doc_persisted" },
      { expectedRevision: 1 },
    );
    expect(saved).toMatchObject({ ok: true, revision: 2 });

    const reopened = createRuntime(backend);
    const restored = await reopened.library.initializeWorkspace();

    expect(restored.ok && restored.state.activeFileId).toBe(fileId);
    const loaded = await reopened.library.loadDocumentWithRecovery(fileId);
    expect(loaded.ok && loaded.document.docId).toBe("doc_persisted");
    expect(loaded.ok && loaded.revision).toBe(2);
    expect((await reopened.library.listFiles()).find((file) => file.fileId === fileId)?.title).toBe("保存した教材");
  });

  it("skips stored version metadata with an invalid capturedAt", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    await backend.write(["documentVersionMetadata", "documentVersionSnapshots"], async (tx) => {
      await tx.put("documentVersionMetadata", `${fileId}:version_bad`, {
        fileId,
        versionId: "version_bad",
        revision: 1,
        capturedAt: "not-a-date",
        origin: "user",
      });
      await tx.put(
        "documentVersionSnapshots",
        `${fileId}:version_bad`,
        createBlankDocument("不正な日時の版"),
      );
    });

    await expect(runtime.library.listDocumentVersions(fileId)).resolves.toEqual([]);
    await expect(runtime.library.getDocumentVersion(fileId, "version_bad")).resolves.toBeNull();
  });

  it("captures a tab boundary against the latest version after an unversioned autosave", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    const first = createBlankDocument("12:00 version");
    const firstSave = await runtime.library.saveDocument(fileId, first, { expectedRevision: 1, origin: "ai" });
    const autosaved = createBlankDocument("12:01 autosave");
    const autosave = await runtime.library.saveDocument(fileId, autosaved, { expectedRevision: firstSave.revision!, origin: "user" });
    expect(autosave.versionCaptured).toBe(false);

    const boundary = await runtime.library.saveDocument(fileId, structuredClone(autosaved), {
      expectedRevision: autosave.revision!,
      origin: "tab-switch",
    });
    expect(boundary.versionCaptured).toBe(true);
    expect((await runtime.library.listDocumentVersions(fileId))[0]).toMatchObject({ origin: "tab-switch" });

    const duplicateBoundary = await runtime.library.saveDocument(fileId, structuredClone(autosaved), {
      expectedRevision: boundary.revision!,
      origin: "app-close",
    });
    expect(duplicateBoundary.versionCaptured).toBe(false);
  });

  it("rejects a save that was built from an older revision", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    const document = createBlankDocument("最初");
    await runtime.library.saveDocument(fileId, document, { expectedRevision: 1 });

    const stale = await runtime.library.saveDocument(fileId, createBlankDocument("あとから"), {
      expectedRevision: 1,
    });

    expect(stale).toMatchObject({ ok: false, code: "revision-mismatch", currentRevision: 2 });
    expect((await runtime.library.listFiles())[0].title).toBe("最初");
  });

  it("keeps a canonical save successful when version capture fails", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    const failingRuntime = createRuntime(failVersionWrites(backend, "quota exceeded"));

    const saved = await failingRuntime.library.saveDocument(
      fileId,
      createBlankDocument("正本は保存済み"),
      { expectedRevision: 1 },
    );

    expect(saved).toMatchObject({
      ok: true,
      revision: 2,
      versionCaptured: false,
      versionCaptureError: "quota exceeded",
    });
    const loaded = await runtime.library.loadDocumentWithRecovery(fileId);
    expect(loaded.ok && loaded.document.metadata.title).toBe("正本は保存済み");
    expect(loaded.ok && loaded.revision).toBe(2);
  });

  it("serializes canonical save and version capture across browser runtimes", async () => {
    installTestWebLocks();
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    let releaseFirstVersionWrite!: () => void;
    let reportFirstVersionWrite!: () => void;
    const firstVersionWriteStarted = new Promise<void>((resolve) => {
      reportFirstVersionWrite = resolve;
    });
    const firstVersionWriteReleased = new Promise<void>((resolve) => {
      releaseFirstVersionWrite = resolve;
    });
    let blockFirstVersionWrite = true;
    const blockingBackend: BrowserStoreBackend = {
      read: (stores, run) => backend.read(stores, run),
      write: async (stores, run) => {
        if (blockFirstVersionWrite && stores.includes("documentVersionMetadata")) {
          blockFirstVersionWrite = false;
          reportFirstVersionWrite();
          await firstVersionWriteReleased;
        }
        return backend.write(stores, run);
      },
    };
    const firstRuntime = createRuntime(blockingBackend);
    const secondRuntime = createRuntime(blockingBackend);

    const firstSave = firstRuntime.library.saveDocument(
      fileId,
      createBlankDocument("先のAI編集"),
      { expectedRevision: 1, origin: "ai" },
    );
    await firstVersionWriteStarted;
    const secondSave = secondRuntime.library.saveDocument(
      fileId,
      createBlankDocument("後のAI編集"),
      { expectedRevision: 2, origin: "ai" },
    );
    await Promise.resolve();
    expect((await runtime.library.listFiles())[0]?.revision).toBe(2);

    releaseFirstVersionWrite();
    await expect(firstSave).resolves.toMatchObject({ ok: true, revision: 2, versionCaptured: true });
    await expect(secondSave).resolves.toMatchObject({ ok: true, revision: 3, versionCaptured: true });
    expect((await runtime.library.listDocumentVersions(fileId)).map((version) => version.revision)).toEqual([3, 2]);
  });

  it("publishes document and library changes to subscribers", async () => {
    const events: DesktopStorageChangeEvent[] = [];
    const unsubscribe = runtime.library.onChange((event) => events.push(event));
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";

    await runtime.library.saveDocument(fileId, createBlankDocument("変更"), { expectedRevision: 1 });
    await runtime.workspace.createWorkspace("2つ目");
    unsubscribe();
    await runtime.workspace.createWorkspace("購読解除後");

    expect(events.filter((event) => event.type === "document")).toEqual([
      expect.objectContaining({ fileId, change: "changed" }),
    ]);
    expect(events.filter((event) => event.type === "library").length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "library" && event.timestamp > Date.now())).toBe(false);
  });

  it("moves a document into a folder and reports it in the overview", async () => {
    await runtime.library.initializeWorkspace();
    const overview = await runtime.workspace.listOverview();
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";
    const fileId = overview.state === "ready" ? overview.overview.files[0].fileId : "";

    const withFolder = await runtime.workspace.createFolder(workspaceId, "一次関数", null);
    const folderId = withFolder.state === "ready" ? withFolder.overview.folders[0].id : "";
    const moved = await runtime.workspace.moveFileToFolder(workspaceId, fileId, folderId);

    expect(moved.state).toBe("ready");
    expect(moved.state === "ready" && moved.overview.folders[0].fileCount).toBe(1);
    expect(moved.state === "ready" && moved.overview.files[0].folderId).toBe(folderId);
  });

  it("refuses to delete the last workspace", async () => {
    await runtime.library.initializeWorkspace();
    const overview = await runtime.workspace.listOverview();
    const workspaceId = overview.state === "ready" ? overview.overview.activeWorkspaceId : "";

    const result = await runtime.workspace.deleteWorkspace(workspaceId);

    expect(result.state).toBe("error");
  });

  it("hides a deleted document and keeps the remaining one open", async () => {
    await runtime.library.initializeWorkspace();
    const initialFiles = await runtime.library.listFiles();
    const second = await runtime.library.createDocument({ title: "2枚目" });

    const deleted = await runtime.library.deleteFile(second.fileId);

    expect(deleted.ok).toBe(true);
    const remaining = await runtime.library.listFiles();
    expect(remaining.map((file) => file.fileId)).toEqual(initialFiles.map((file) => file.fileId));
  });

  it("keeps a canonical delete successful when version cleanup fails", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    const otherFileId = (await runtime.library.listFiles()).find((file) => file.fileId !== fileId)?.fileId;
    expect(otherFileId).toBeDefined();
    await runtime.library.deleteFile(otherFileId!);
    await runtime.library.saveDocument(fileId, createBlankDocument("履歴あり"), { expectedRevision: 1 });
    const [version] = await runtime.library.listDocumentVersions(fileId);
    expect(version).toBeDefined();
    const failingRuntime = createRuntime(failVersionWrites(backend, "cleanup quota failure"));

    const deleted = await failingRuntime.library.deleteFile(fileId);

    expect(deleted).toEqual({ ok: true, versionCleanupError: "cleanup quota failure" });
    expect(await runtime.library.listFiles()).toEqual([]);
    expect(await runtime.library.listDocumentVersions(fileId)).toEqual([]);
    expect(await runtime.library.getDocumentVersion(fileId, version!.versionId)).toBeNull();
  });

  it("duplicates a document into a new file", async () => {
    const initialized = await runtime.library.initializeWorkspace();
    const fileId = initialized.ok ? initialized.state.activeFileId : "";
    await runtime.library.saveDocument(fileId, createBlankDocument("元の教材"), { expectedRevision: 1 });

    const copy = await runtime.library.duplicateFile(fileId);

    expect(copy.fileId).not.toBe(fileId);
    expect(copy.metadata.title).toContain("元の教材");
    expect(await runtime.library.listFiles()).toHaveLength(3);
  });

  it("stores templates and materials per browser", async () => {
    const template = await runtime.templates.createTemplate({
      workspaceId: "workspace_1",
      name: "小テスト",
      document: sampleDocument,
    });
    const material = await runtime.materials.createMaterial({
      name: "ばね",
      content: { blocks: [], overlaySnapshot: { version: 1, shapes: [], assets: {} } },
      description: undefined,
      tags: undefined,
      usage: undefined,
      visualConcepts: undefined,
      transformPolicy: undefined,
      ports: undefined,
    });

    expect(await runtime.templates.listTemplates("workspace_1")).toEqual([template]);
    expect(await runtime.templates.listTemplates("workspace_other")).toEqual([]);
    expect((await runtime.materials.listMaterials())[0]).toMatchObject({ id: material.id, name: "ばね" });

    await runtime.templates.deleteTemplate(template.id);
    await runtime.materials.deleteMaterial(material.id);
    expect(await runtime.templates.listTemplates()).toEqual([]);
    expect(await runtime.materials.listMaterials()).toEqual([]);
  });
});

describe("browser runtime tab state", () => {
  it("drops tabs pointing at a deleted workspace's documents", async () => {
    const backend = createMemoryStoreBackend();
    const runtime = createRuntime(backend);
    await runtime.library.initializeWorkspace();
    const keepers = await runtime.library.listFiles();

    const second = await runtime.workspace.createWorkspace("消す方");
    const secondWorkspaceId = second.state === "ready" ? second.overview.activeWorkspaceId : "";
    const doomed = await runtime.library.createDocument({ title: "消える教材" });
    expect(doomed.metadata.workspaceId).toBe(secondWorkspaceId);

    await runtime.workspace.deleteWorkspace(secondWorkspaceId);

    const restored = await createRuntime(backend).library.initializeWorkspace();
    expect(restored.ok && restored.state.openFileIds).toEqual(keepers.map((file) => file.fileId));
    expect(restored.ok && restored.state.activeFileId).toBe(keepers[0].fileId);
  });
});
