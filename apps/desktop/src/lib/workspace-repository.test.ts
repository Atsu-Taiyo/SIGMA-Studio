import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentInWorkspace,
  createFolder,
  createWorkspace,
  deleteDocumentInWorkspace,
  deleteFolder,
  deleteWorkspace,
  loadWorkspacePreviewDocument,
  listWorkspaceOverview,
  moveFileToFolder,
  renameDocumentInWorkspace,
  updateFolder,
  updateWorkspaceName,
} from "@/lib/workspace-repository";
import { sampleDocument } from "@/lib/sample-document";
import type { DesktopAPI, DesktopStorageAPI, DesktopWorkspaceOverview } from "@/types/desktop";

describe("workspace repository runtime boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * デスクトップの bridge が無い = Web 版。ワークスペースは「利用できません」ではなく、
   * このブラウザの保存先 (IndexedDB。vitest は node なのでメモリ) の上に立ち上がる。
   */
  it("falls back to a browser workspace when desktopAPI.storage is missing", async () => {
    vi.stubGlobal("window", {});

    const listed = await listWorkspaceOverview();

    expect(listed.state).toBe("ready");
    expect(listed.state === "ready" && listed.overview.workspaces.length).toBeGreaterThan(0);

    const workspaceId = listed.state === "ready" ? listed.overview.activeWorkspaceId : "";
    const created = await createDocumentInWorkspace(workspaceId, null, "ブラウザ教材");
    expect(created.state === "ready" && created.overview.files.map((file) => file.title))
      .toContain("ブラウザ教材");
  });

  it("routes workspace mutations through desktopAPI.storage", async () => {
    const storage = installDesktopRuntime();

    await expect(listWorkspaceOverview("workspace_1")).resolves.toEqual({
      state: "ready",
      overview: createOverview("workspace_1"),
    });
    await createWorkspace("教材棚");
    await updateWorkspaceName("workspace_1", "教材棚2");
    await deleteWorkspace("workspace_1");
    await createFolder("workspace_1", "一次関数", null);
    await updateFolder("workspace_1", "folder_1", { name: "二次関数" });
    await deleteFolder("workspace_1", "folder_1");
    await moveFileToFolder("workspace_1", "file_1", "folder_1");

    expect(storage.getWorkspaceOverview).toHaveBeenCalledWith("workspace_1");
    expect(storage.createWorkspace).toHaveBeenCalledWith("教材棚");
    expect(storage.renameWorkspace).toHaveBeenCalledWith("workspace_1", "教材棚2");
    expect(storage.deleteWorkspace).toHaveBeenCalledWith("workspace_1");
    expect(storage.createFolder).toHaveBeenCalledWith("workspace_1", "一次関数", null);
    expect(storage.updateFolder).toHaveBeenCalledWith("workspace_1", "folder_1", { name: "二次関数" });
    expect(storage.deleteFolder).toHaveBeenCalledWith("workspace_1", "folder_1");
    expect(storage.moveFileToFolder).toHaveBeenCalledWith("workspace_1", "file_1", "folder_1");
  });

  it("loads workspace preview documents through desktopAPI.storage", async () => {
    const storage = installDesktopRuntime();
    storage.loadDocument.mockResolvedValue(sampleDocument);

    await expect(loadWorkspacePreviewDocument("file_1")).resolves.toMatchObject({
      docId: sampleDocument.docId,
      metadata: sampleDocument.metadata,
    });

    expect(storage.loadDocument).toHaveBeenCalledWith("file_1");
  });

  it("renames a workspace document by saving its SigmaDoc title", async () => {
    const storage = installDesktopRuntime();
    storage.loadDocumentWithRecovery.mockResolvedValue({
      ok: true,
      document: sampleDocument,
      revision: 1,
      recoveryIssues: [],
    });
    storage.saveDocument.mockResolvedValue({ ok: true, revision: 2 });

    await expect(renameDocumentInWorkspace("workspace_1", "file_1", "名前変更後")).resolves.toMatchObject({
      state: "ready",
    });

    expect(storage.loadDocumentWithRecovery).toHaveBeenCalledWith("file_1");
    expect(storage.saveDocument).toHaveBeenCalledWith(
      "file_1",
      expect.objectContaining({
        metadata: expect.objectContaining({ title: "名前変更後" }),
        updatedAt: expect.any(String),
      }),
      { expectedRevision: 1 },
    );
  });

  it("retries a document rename once on revision mismatch using the latest document", async () => {
    const storage = installDesktopRuntime();
    const approvedDocument = {
      ...sampleDocument,
      content: [
        { type: "paragraph" as const, id: "ai_change", children: [{ type: "text" as const, text: "AIの変更" }] },
      ],
    };
    storage.loadDocumentWithRecovery
      .mockResolvedValueOnce({
        ok: true,
        document: sampleDocument,
        revision: 1,
        recoveryIssues: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        document: approvedDocument,
        revision: 2,
        recoveryIssues: [],
      });
    storage.saveDocument
      .mockResolvedValueOnce({
        ok: false,
        code: "revision-mismatch",
        currentRevision: 2,
        error: "stale",
      })
      .mockResolvedValueOnce({ ok: true, revision: 3 });

    await expect(renameDocumentInWorkspace("workspace_1", "file_1", "名前変更後")).resolves.toMatchObject({
      state: "ready",
    });

    expect(storage.loadDocumentWithRecovery).toHaveBeenCalledTimes(2);
    expect(storage.saveDocument).toHaveBeenNthCalledWith(
      1,
      "file_1",
      expect.any(Object),
      { expectedRevision: 1 },
    );
    expect(storage.saveDocument).toHaveBeenNthCalledWith(
      2,
      "file_1",
      expect.objectContaining({
        content: approvedDocument.content,
        metadata: expect.objectContaining({ title: "名前変更後" }),
      }),
      { expectedRevision: 2 },
    );
  });

  it("fails visibly when a document rename still mismatches after one retry", async () => {
    const storage = installDesktopRuntime();
    storage.loadDocumentWithRecovery
      .mockResolvedValueOnce({
        ok: true,
        document: sampleDocument,
        revision: 1,
        recoveryIssues: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        document: sampleDocument,
        revision: 2,
        recoveryIssues: [],
      });
    storage.saveDocument
      .mockResolvedValueOnce({
        ok: false,
        code: "revision-mismatch",
        currentRevision: 2,
        error: "stale once",
      })
      .mockResolvedValueOnce({
        ok: false,
        code: "revision-mismatch",
        currentRevision: 3,
        error: "教材がもう一度更新されました。",
      });

    await expect(renameDocumentInWorkspace("workspace_1", "file_1", "名前変更後")).resolves.toEqual({
      state: "error",
      error: "教材がもう一度更新されました。",
    });
    expect(storage.saveDocument).toHaveBeenCalledTimes(2);
  });

  it("creates documents through the library adapter without any cloud round trip", async () => {
    const storage = installDesktopRuntime();

    await createDocumentInWorkspace("workspace_1", "folder_1", "新規教材");
    await deleteDocumentInWorkspace("workspace_1", "file_1");

    expect(storage.deleteFile).toHaveBeenCalledWith("file_1");
    expect(storage.listFiles).not.toHaveBeenCalled();
    expect(storage.createDocument).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      folderId: "folder_1",
      title: "新規教材",
    });
    expect(storage.getWorkspaceOverview).toHaveBeenCalledWith("workspace_1");
  });
});

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
  return {
    initializeWorkspace: vi.fn(),
    listFiles: vi.fn().mockResolvedValue([createFileSummary()]),
    loadDocument: vi.fn(),
    loadDocumentWithRecovery: vi.fn().mockResolvedValue({
      ok: true,
      document: sampleDocument,
      revision: 1,
      recoveryIssues: [],
    }),
    saveDocument: vi.fn(),
    listDocumentVersions: vi.fn().mockResolvedValue([]),
    getDocumentVersion: vi.fn().mockResolvedValue(null),
    captureDocumentVersion: vi.fn().mockResolvedValue({ ok: true }),
    createDocument: vi.fn().mockResolvedValue({
      file: {
        ...createFileSummary(),
        folderId: "folder_1",
      },
      document: sampleDocument,
    }),
    createFileFromDocument: vi.fn(),
    duplicateFile: vi.fn(),
    deleteFile: vi.fn().mockResolvedValue({ ok: true }),
    saveWorkspace: vi.fn(),
    getWorkspaceOverview: vi.fn().mockImplementation((workspaceId?: string | null) => Promise.resolve({
      state: "ready",
      overview: createOverview(workspaceId ?? "workspace_1"),
    })),
    createWorkspace: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_created") }),
    renameWorkspace: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    deleteWorkspace: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    createFolder: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    updateFolder: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    deleteFolder: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    moveFileToFolder: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    moveFileToWorkspace: vi.fn().mockResolvedValue({ state: "ready", overview: createOverview("workspace_1") }),
    getDataDir: vi.fn(),
    listMcpEditProposals: vi.fn(),
    approveMcpEditProposal: vi.fn(),
    approveMcpEditProposals: vi.fn(),
    rejectMcpEditProposal: vi.fn(),
    onChange: vi.fn(),
  } satisfies DesktopStorageAPI;
}

function createOverview(
  activeWorkspaceId: string,
  files: DesktopWorkspaceOverview["files"] = [],
): DesktopWorkspaceOverview {
  return {
    activeWorkspaceId,
    workspaces: [{
      id: activeWorkspaceId,
      name: "教材棚",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }],
    folders: [],
    files,
  };
}

function createFileSummary(): DesktopWorkspaceOverview["files"][number] {
  return {
    fileId: "file_1",
    workspaceId: "workspace_1",
    folderId: null,
    docId: sampleDocument.docId,
    title: sampleDocument.metadata.title,
    documentPath: "/tmp/file_1.sigmadoc.json",
    revision: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
