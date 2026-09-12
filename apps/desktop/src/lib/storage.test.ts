import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sampleDocument } from "@/lib/sample-document";
import {
  createObservedDocumentWrite,
  createDocumentFromSigmaDocument,
  createNewDocument,
  deleteDocument,
  duplicateDocument,
  initializeDocumentWorkspace,
  listSavedDocuments,
  loadDocumentByFileId,
  loadSavedDocument,
  saveDocument,
  saveDocumentRecord,
  saveWorkspaceState,
} from "@/lib/storage";
import type { DesktopAPI, DesktopStorageAPI } from "@/types/desktop";
import type { SigmaDocument } from "@/types/sigma-doc";
import { createTranslator, getAppLocale, setAppLocale } from "@/lib/i18n";

const STORAGE_RUNTIME_MISSING = (["ja", "en"] as const)
  .map((locale) => createTranslator(locale, "workspace")("error.storageRuntimeMissing") as unknown as string);

/**
 * いま解決されるロケールの既定題名。直書きへ戻したら一致しなくなる。
 *
 * **関数にしてある。** module 直下で評価すると読み込み時のロケール (ja) で
 * 固まり、実行時 (en) と食い違う — 本番コードで塞いだのと同じ罠を、テスト側で
 * 一度踏んだ。
 */
const untitledMaterialNow = (): string =>
  createTranslator(getAppLocale(), "workspace")("untitledMaterial") as unknown as string;

describe("document storage runtime boundary", () => {
  beforeEach(() => {
    setAppLocale("ja");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the deprecated synchronous browser-storage helpers unavailable", () => {
    expect(loadSavedDocument()).toBeNull();
    const result = saveDocument(sampleDocument);
    expect(result.ok).toBe(false);
    expect(STORAGE_RUNTIME_MISSING).toContain(result.ok ? "" : result.error);
  });

  it("routes workspace initialization and document reads through desktopAPI.storage", async () => {
    const storage = installDesktopRuntime();

    const workspace = await initializeDocumentWorkspace();
    const metadata = await listSavedDocuments();
    const document = await loadDocumentByFileId("file_1");

    expect(workspace).toEqual({
      ok: true,
      state: { openFileIds: ["file_1"], activeFileId: "file_1" },
    });
    expect(metadata).toEqual([createMetadata("file_1", sampleDocument)]);
    expect(document?.metadata.title).toBe(sampleDocument.metadata.title);
    expect(storage.initializeWorkspace).toHaveBeenCalledWith({
      initialDocument: expect.objectContaining({
        // D3: 空文書の題名は**作成時点の UI 言語**で焼かれる。
        // 「既定名のどれか」だと、辞書を経由せず日本語を直書きに戻しても緑のまま
        // なので、**いま解決されているロケールの値**と一致することを見る。
        metadata: expect.objectContaining({ title: untitledMaterialNow() }),
        content: expect.arrayContaining([
          expect.objectContaining({
            children: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: "" }),
            ]),
            type: "paragraph",
          }),
        ]),
        updatedAt: expect.any(String),
      }),
    });
    expect(storage.initializeWorkspace.mock.calls[0][0].initialDocument.metadata.title).toBe("無題の教材");
    expect(storage.listFiles).toHaveBeenCalledTimes(1);
    expect(storage.loadDocument).toHaveBeenCalledWith("file_1");
  });

  it("routes document mutations through desktopAPI.storage", async () => {
    const storage = installDesktopRuntime();
    const nextDocument: SigmaDocument = {
      ...sampleDocument,
      metadata: { title: "更新済み" },
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    await expect(createNewDocument("教材A")).resolves.toMatchObject({
      fileId: "file_created",
      metadata: { fileId: "file_created" },
    });
    await expect(createDocumentFromSigmaDocument(nextDocument)).resolves.toMatchObject({
      fileId: "file_imported",
      document: { metadata: { title: "更新済み" } },
    });
    await expect(duplicateDocument("file_1")).resolves.toMatchObject({
      fileId: "file_duplicate",
    });
    await expect(saveDocumentRecord(observedWrite("file_1", nextDocument))).resolves.toEqual({ ok: true });
    await expect(deleteDocument("file_1")).resolves.toEqual({ ok: true });
    await expect(saveWorkspaceState({ openFileIds: ["file_1"], activeFileId: "file_1" })).resolves.toEqual({ ok: true });

    expect(storage.createDocument).toHaveBeenCalledWith({ title: "教材A" });
    expect(storage.createFileFromDocument).toHaveBeenCalledWith({
      document: expect.objectContaining({
        metadata: expect.objectContaining({ title: "更新済み" }),
      }),
    });
    expect(storage.duplicateFile).toHaveBeenCalledWith("file_1");
    expect(storage.saveDocument).toHaveBeenCalledWith(
      "file_1",
      expect.objectContaining({
        metadata: expect.objectContaining({ title: "更新済み" }),
      }),
      { expectedRevision: 1 },
    );
    expect(storage.deleteFile).toHaveBeenCalledWith("file_1");
    expect(storage.saveWorkspace).toHaveBeenCalledWith({ openFileIds: ["file_1"], activeFileId: "file_1" });
  });

  it("forwards expectedRevision and returns revision mismatch details unchanged", async () => {
    const storage = installDesktopRuntime();
    const mismatch = {
      ok: false,
      code: "revision-mismatch" as const,
      currentRevision: 4,
      error: "stale",
    };
    storage.saveDocument.mockResolvedValueOnce(mismatch);

    await expect(saveDocumentRecord(observedWrite("file_1", sampleDocument))).resolves.toEqual(mismatch);

    expect(storage.saveDocument).toHaveBeenCalledWith(
      "file_1",
      expect.any(Object),
      { expectedRevision: 1 },
    );
  });

  it("rejects a document payload captured before an AI approval even after metadata observes the approved revision", async () => {
    const storage = installDesktopRuntime();
    const staleBeforeApproval = {
      ...sampleDocument,
      metadata: { ...sampleDocument.metadata, title: "承認前の本文" },
    };

    // The editor loaded this payload at revision 1. While it was still queued,
    // AI approval advanced the file and a metadata refresh observed revision 2.
    await listSavedDocuments();
    storage.listFiles.mockResolvedValueOnce([{
      ...createMetadata("file_1", sampleDocument),
      revision: 2,
    }]);
    await listSavedDocuments();

    storage.saveDocument.mockImplementationOnce(async (_fileId, _document, options) => (
      options.expectedRevision === 1
        ? { ok: false, code: "revision-mismatch", currentRevision: 2, error: "stale" }
        : { ok: true, revision: 3 }
    ));

    await expect(saveDocumentRecord(observedWrite("file_1", staleBeforeApproval, 1))).resolves.toMatchObject({
      ok: false,
      code: "revision-mismatch",
      currentRevision: 2,
    });
    expect(storage.saveDocument).toHaveBeenCalledWith(
      "file_1",
      expect.objectContaining({ metadata: expect.objectContaining({ title: "承認前の本文" }) }),
      { expectedRevision: 1 },
    );
  });

  it("saves and deletes through the storage bridge without any extra bridge call", async () => {
    const storage = installDesktopRuntime();
    const nextDocument: SigmaDocument = {
      ...sampleDocument,
      metadata: { title: "ローカルのみ" },
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    await expect(saveDocumentRecord(observedWrite("file_1", nextDocument))).resolves.toEqual({ ok: true });
    await expect(deleteDocument("file_1")).resolves.toEqual({ ok: true });
    await expect(saveWorkspaceState({ openFileIds: ["file_1"], activeFileId: "file_1" })).resolves.toEqual({ ok: true });

    // 保存経路はローカルの storage bridge 1本だけ。メタデータの追加取得も行わない。
    expect(storage.saveDocument).toHaveBeenCalledTimes(1);
    expect(storage.deleteFile).toHaveBeenCalledTimes(1);
    expect(storage.saveWorkspace).toHaveBeenCalledTimes(1);
    expect(storage.listFiles).not.toHaveBeenCalled();
  });

  /**
   * 文言はロケール依存になったので**日本語を決め打ちしない**。`window` を `{}` に
   * 差し替えるテストなのでロケールも固定できない (ストアが localStorage を触る)。
   * 辞書から期待値を作るのが、環境に依存しない唯一の書き方。
   */
  /**
   * デスクトップの bridge が無い = Web 版。**保存できない**のではなく、
   * このブラウザの保存先 (IndexedDB。vitest は node なのでメモリ) へ落ちる。
   * ここが落ちるときは「リロードで教材が消える」に戻っている。
   */
  it("falls back to browser storage when desktopAPI is missing", async () => {
    vi.stubGlobal("window", {});

    const created = await createNewDocument("教材A");
    expect(created.metadata.title).toBe("教材A");

    const listed = await listSavedDocuments();
    expect(listed.map((file) => file.fileId)).toContain(created.fileId);

    const saved = await saveDocumentRecord(observedWrite(
      created.fileId,
      created.document,
      created.metadata.revision,
    ));
    expect(saved).toMatchObject({ ok: true, revision: created.metadata.revision + 1 });

    const reloaded = await loadDocumentByFileId(created.fileId);
    expect(reloaded?.docId).toBe(created.document.docId);
  });
});

function observedWrite(fileId: string, document: SigmaDocument, observedRevision = 1) {
  return createObservedDocumentWrite({ fileId, document, observedRevision });
}

function installDesktopRuntime() {
  const storage = createDesktopStorageMock();
  vi.stubGlobal("window", {
      desktopAPI: {
        isDesktop: true,
        platform: "darwin",
        app: {
          getInfo: vi.fn().mockResolvedValue({ version: "0.1.0", releaseUrl: "https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest" }),
          openLatestReleasePage: vi.fn().mockResolvedValue({ ok: true }),
        },
        shell: {
          openExternal: vi.fn(),
        },
        codex: {
        getStatus: vi.fn(),
        setBin: vi.fn(),
        selectBin: vi.fn(),
        login: vi.fn(),
        openInstallPage: vi.fn().mockResolvedValue({ ok: true }),
        logout: vi.fn(),
        onStatusChange: vi.fn(),
      },
      aiEdit: {
        run: vi.fn(),
      },
      file: {
        openSigmaDoc: vi.fn(),
        saveSigmaDoc: vi.fn(),
      },
      materials: {
        listMaterials: vi.fn().mockResolvedValue([]),
        createMaterial: vi.fn(),
        renameMaterial: vi.fn(),
        updateMaterialMetadata: vi.fn(),
        deleteMaterial: vi.fn(),
      },
      templates: {
        listTemplates: vi.fn().mockResolvedValue([]),
        createTemplate: vi.fn(),
        renameTemplate: vi.fn(),
        deleteTemplate: vi.fn(),
      },
      storage,
      onMenuAction: vi.fn(),
    } satisfies DesktopAPI,
  });
  return storage;
}

function createDesktopStorageMock() {
  const baseMetadata = createMetadata("file_1", sampleDocument);
  const createdDocument = {
    ...sampleDocument,
    docId: "doc_created",
    metadata: { title: "教材A" },
  };
  const importedDocument = {
    ...sampleDocument,
    docId: "doc_imported",
    metadata: { title: "更新済み" },
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  const duplicatedDocument = {
    ...sampleDocument,
    docId: "doc_duplicate",
    metadata: { title: "サンプル のコピー" },
  };

  return {
    initializeWorkspace: vi.fn().mockResolvedValue({
      ok: true,
      state: { openFileIds: ["file_1"], activeFileId: "file_1" },
    }),
    listFiles: vi.fn().mockResolvedValue([baseMetadata]),
    loadDocument: vi.fn().mockResolvedValue(sampleDocument),
    loadDocumentWithRecovery: vi.fn().mockResolvedValue({
      ok: true,
      document: sampleDocument,
      revision: 1,
      recoveryIssues: [],
    }),
    saveDocument: vi.fn().mockResolvedValue({ ok: true }),
    listDocumentVersions: vi.fn().mockResolvedValue([]),
    getDocumentVersion: vi.fn().mockResolvedValue(null),
    captureDocumentVersion: vi.fn().mockResolvedValue({ ok: true }),
    createDocument: vi.fn().mockResolvedValue({
      file: createMetadata("file_created", createdDocument),
      document: createdDocument,
    }),
    createFileFromDocument: vi.fn().mockResolvedValue({
      file: createMetadata("file_imported", importedDocument),
      document: importedDocument,
    }),
    duplicateFile: vi.fn().mockResolvedValue({
      file: createMetadata("file_duplicate", duplicatedDocument),
      document: duplicatedDocument,
    }),
    deleteFile: vi.fn().mockResolvedValue({ ok: true }),
    saveWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    getWorkspaceOverview: vi.fn(),
    createWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFileToFolder: vi.fn(),
    moveFileToWorkspace: vi.fn(),
    getDataDir: vi.fn(),
    listMcpEditProposals: vi.fn(),
    approveMcpEditProposal: vi.fn(),
    approveMcpEditProposals: vi.fn(),
    rejectMcpEditProposal: vi.fn(),
    onChange: vi.fn(),
  } satisfies DesktopStorageAPI;
}

function createMetadata(fileId: string, document: SigmaDocument) {
  return {
    fileId,
    workspaceId: "workspace_1",
    folderId: null,
    docId: document.docId,
    title: document.metadata.title || "無題の教材",
    documentPath: `/tmp/${fileId}.sigmadoc.json`,
    revision: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: document.updatedAt ?? "2026-06-01T00:00:00.000Z",
  };
}
