import type { Page } from "@playwright/test";
import type { SigmaDocument } from "@/types/sigma-doc";
import type { TemplateItem } from "@/types/template";
import type { LedgerSchemaFailure } from "@/lib/library-schema";

// Stateful `window.desktopAPI` mock for the /workspace browser. Unlike the
// old per-spec-file inline mocks (which stubbed createFolder/updateFolder/
// deleteFolder/moveFileToFolder/moveFileToWorkspace with `{ state: "error" }`),
// this one carries a real in-memory library that actually mutates -- so
// folder CRUD, moves, and workspace CRUD can be exercised end to end. The
// shape and behavior of each operation mirrors the real implementation in
// electron/local-sigma-doc-store.ts closely enough for e2e purposes (notably:
// getWorkspaceOverview persists whichever workspaceId it was explicitly asked
// for as the new "active" workspace -- see that file's getWorkspaceOverview --
// which is what makes plain workspace switching AND the delete-dialog's
// probe read both fall out of the same one code path, exactly as in prod).

export interface WorkspaceMockWorkspaceSeed {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceMockFolderSeed {
  id: string;
  workspaceId: string;
  parentFolderId?: string | null;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceMockFileSeed {
  fileId: string;
  workspaceId: string;
  folderId?: string | null;
  title: string;
  document: SigmaDocument;
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
}

export interface WorkspaceRuntimeMockSeed {
  activeWorkspaceId?: string;
  workspaces: WorkspaceMockWorkspaceSeed[];
  folders?: WorkspaceMockFolderSeed[];
  files?: WorkspaceMockFileSeed[];
  templates?: TemplateItem[];
}

export interface InstallWorkspaceRuntimeMockOptions {
  /** Applies only to saveDocument (i.e. the tail end of a file rename), mirroring
   * the old workspace-preview.spec.ts mock's renameDelayMs. */
  renameDelayMs?: number;
  ledgerSchemaFailure?: LedgerSchemaFailure;
}

let mockDocSequence = 0;

/** Builds a minimal, schema-valid SigmaDocument for seeding a mock file. */
export function createWorkspaceMockDocument(title: string, docId?: string): SigmaDocument {
  mockDocSequence += 1;
  const resolvedDocId = docId ?? `doc_e2e_mock_${mockDocSequence}`;
  return {
    version: "2.0",
    docId: resolvedDocId,
    metadata: { title },
    content: [
      {
        type: "paragraph",
        id: `${resolvedDocId}_p`,
        children: [{ type: "text", text: title || "無題の教材" }],
      },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true },
      answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
    },
  } as unknown as SigmaDocument;
}

// ---- Rich default seed, shared by workspace-browser.spec.ts -----------
// 2 workspaces, nested folders (B inside A), and 4 files with distinct
// titles/updatedAt: "教材2"/"教材10" prove natural sort, フォルダ内教材 lives
// inside the nested folder (so 場所 has something other than the workspace
// name to show), and the untitled file proves the 無題の教材 fallback.
export const MOCK_WORKSPACE_1_ID = "workspace_mock_main";
export const MOCK_WORKSPACE_2_ID = "workspace_mock_second";
export const MOCK_WORKSPACE_1_NAME = "マイ教材";
export const MOCK_WORKSPACE_2_NAME = "第二ワークスペース";
export const MOCK_FOLDER_A_ID = "folder_mock_a";
export const MOCK_FOLDER_A_NAME = "フォルダA";
export const MOCK_FOLDER_B_ID = "folder_mock_b";
export const MOCK_FOLDER_B_NAME = "フォルダB";
export const MOCK_FOLDER_EMPTY_ID = "folder_mock_empty";
export const MOCK_FOLDER_EMPTY_NAME = "フォルダZ";
export const MOCK_FILE_K2_ID = "file_mock_k2";
export const MOCK_FILE_K2_TITLE = "教材2";
export const MOCK_FILE_K10_ID = "file_mock_k10";
export const MOCK_FILE_K10_TITLE = "教材10";
export const MOCK_FILE_UNTITLED_ID = "file_mock_untitled";
export const MOCK_FILE_IN_FOLDER_ID = "file_mock_in_folder";
export const MOCK_FILE_IN_FOLDER_TITLE = "フォルダ内教材";

export function createDefaultWorkspaceMockSeed(): WorkspaceRuntimeMockSeed {
  const baseTime = Date.parse("2026-07-20T09:00:00.000Z");
  const at = (offsetMinutes: number) => new Date(baseTime + offsetMinutes * 60_000).toISOString();
  return {
    activeWorkspaceId: MOCK_WORKSPACE_1_ID,
    workspaces: [
      {
        id: MOCK_WORKSPACE_1_ID, name: MOCK_WORKSPACE_1_NAME, createdAt: at(0), updatedAt: at(0),
      },
      {
        id: MOCK_WORKSPACE_2_ID, name: MOCK_WORKSPACE_2_NAME, createdAt: at(1), updatedAt: at(1),
      },
    ],
    folders: [
      {
        id: MOCK_FOLDER_A_ID, workspaceId: MOCK_WORKSPACE_1_ID, parentFolderId: null,
        name: MOCK_FOLDER_A_NAME, createdAt: at(2), updatedAt: at(2),
      },
      {
        id: MOCK_FOLDER_B_ID, workspaceId: MOCK_WORKSPACE_1_ID, parentFolderId: MOCK_FOLDER_A_ID,
        name: MOCK_FOLDER_B_NAME, createdAt: at(3), updatedAt: at(3),
      },
      {
        id: MOCK_FOLDER_EMPTY_ID, workspaceId: MOCK_WORKSPACE_1_ID, parentFolderId: null,
        name: MOCK_FOLDER_EMPTY_NAME, createdAt: at(4), updatedAt: at(4),
      },
    ],
    files: [
      {
        fileId: MOCK_FILE_K2_ID, workspaceId: MOCK_WORKSPACE_1_ID, folderId: null, title: MOCK_FILE_K2_TITLE,
        document: createWorkspaceMockDocument(MOCK_FILE_K2_TITLE, "doc_mock_k2"), createdAt: at(10), updatedAt: at(10),
      },
      {
        fileId: MOCK_FILE_K10_ID, workspaceId: MOCK_WORKSPACE_1_ID, folderId: null, title: MOCK_FILE_K10_TITLE,
        document: createWorkspaceMockDocument(MOCK_FILE_K10_TITLE, "doc_mock_k10"), createdAt: at(11), updatedAt: at(11),
      },
      {
        fileId: MOCK_FILE_UNTITLED_ID, workspaceId: MOCK_WORKSPACE_1_ID, folderId: null, title: "",
        document: createWorkspaceMockDocument("", "doc_mock_untitled"), createdAt: at(12), updatedAt: at(12),
      },
      {
        fileId: MOCK_FILE_IN_FOLDER_ID, workspaceId: MOCK_WORKSPACE_1_ID, folderId: MOCK_FOLDER_B_ID,
        title: MOCK_FILE_IN_FOLDER_TITLE,
        document: createWorkspaceMockDocument(MOCK_FILE_IN_FOLDER_TITLE, "doc_mock_in_folder"), createdAt: at(13), updatedAt: at(13),
      },
    ],
    templates: [],
  };
}

export async function installWorkspaceRuntimeMock(
  page: Page,
  seed: WorkspaceRuntimeMockSeed,
  options: InstallWorkspaceRuntimeMockOptions = {},
): Promise<void> {
  await page.addInitScript(({ seed, renameDelayMs, initialLedgerSchemaFailure }: {
    seed: WorkspaceRuntimeMockSeed;
    renameDelayMs: number;
    initialLedgerSchemaFailure: LedgerSchemaFailure | null;
  }) => {
    type LibWorkspace = {
      id: string; name: string; createdAt: string; updatedAt: string; deletedAt: string | null;
    };
    type LibFolder = {
      id: string; workspaceId: string; parentFolderId: string | null; name: string;
      createdAt: string; updatedAt: string; deletedAt: string | null;
    };
    type LibFile = {
      fileId: string; workspaceId: string; folderId: string | null;
      docId: string; title: string; documentPath: string; revision: number;
      createdAt: string; updatedAt: string; deletedAt: string | null;
    };

    const now = () => new Date().toISOString();
    let idCounter = 0;
    const createId = (prefix: string) => `${prefix}_e2e_${Date.now()}_${idCounter++}`;

    const workspaces: LibWorkspace[] = seed.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt ?? now(),
      updatedAt: workspace.updatedAt ?? now(),
      deletedAt: null,
    }));
    const folders: LibFolder[] = (seed.folders ?? []).map((folder) => ({
      id: folder.id,
      workspaceId: folder.workspaceId,
      parentFolderId: folder.parentFolderId ?? null,
      name: folder.name,
      createdAt: folder.createdAt ?? now(),
      updatedAt: folder.updatedAt ?? now(),
      deletedAt: null,
    }));
    const documentsByFileId = new Map<string, SigmaDocument>();
    const files: LibFile[] = (seed.files ?? []).map((file) => {
      documentsByFileId.set(file.fileId, structuredClone(file.document));
      return {
        fileId: file.fileId,
        workspaceId: file.workspaceId,
        folderId: file.folderId ?? null,
        docId: file.document.docId,
        title: file.title,
        documentPath: `/tmp/e2e-workspace-mock/${file.fileId}.sigmadoc.json`,
        revision: file.revision ?? 1,
        createdAt: file.createdAt ?? now(),
        updatedAt: file.updatedAt ?? now(),
        deletedAt: null,
      };
    });
    let currentTemplates: TemplateItem[] = (seed.templates ?? []).map((template) => structuredClone(template));
    let activeWorkspaceId = seed.activeWorkspaceId ?? workspaces[0]?.id ?? "";
    let workspaceOpenState = {
      openFileIds: files.map((file) => file.fileId),
      activeFileId: files[0]?.fileId ?? "",
    };
    let currentLedgerSchemaFailure = initialLedgerSchemaFailure
      ? structuredClone(initialLedgerSchemaFailure)
      : null;
    (window as unknown as { __sigmaRepairLedger?: () => void }).__sigmaRepairLedger = () => {
      currentLedgerSchemaFailure = null;
    };

    const findWorkspace = (id: string | null | undefined): LibWorkspace | null =>
      workspaces.find((workspace) => workspace.id === id && !workspace.deletedAt) ?? null;
    const findFolder = (workspaceId: string, id: string | null | undefined): LibFolder | null =>
      folders.find((folder) => folder.workspaceId === workspaceId && folder.id === id && !folder.deletedAt) ?? null;
    const findFile = (id: string | null | undefined): LibFile | null =>
      files.find((file) => file.fileId === id && !file.deletedAt) ?? null;

    const resolveWorkspace = (workspaceId?: string | null): LibWorkspace | null => {
      if (workspaceId) {
        return findWorkspace(workspaceId);
      }
      return findWorkspace(activeWorkspaceId) ?? workspaces.find((workspace) => !workspace.deletedAt) ?? null;
    };

    const resolveFolderId = (
      workspaceId: string,
      folderId?: string | null,
    ): { ok: true; folderId: string | null } | { ok: false; error: string } => {
      const normalized = folderId && folderId.trim() ? folderId.trim() : null;
      if (!normalized) {
        return { ok: true, folderId: null };
      }
      const folder = findFolder(workspaceId, normalized);
      if (!folder) {
        return { ok: false, error: "フォルダが見つかりません。" };
      }
      return { ok: true, folderId: folder.id };
    };

    const isFolderDescendant = (workspaceId: string, folderId: string, possibleAncestorId: string): boolean => {
      let current = findFolder(workspaceId, folderId);
      const seen = new Set<string>();
      while (current?.parentFolderId) {
        if (current.parentFolderId === possibleAncestorId) {
          return true;
        }
        if (seen.has(current.parentFolderId)) {
          return false;
        }
        seen.add(current.parentFolderId);
        current = findFolder(workspaceId, current.parentFolderId);
      }
      return false;
    };

    const touchWorkspace = (workspaceId: string, timestamp: string) => {
      const workspace = findWorkspace(workspaceId);
      if (workspace) {
        workspace.updatedAt = timestamp;
      }
    };

    const mapMetadata = (file: LibFile) => ({
      fileId: file.fileId,
      workspaceId: file.workspaceId,
      folderId: file.folderId,
      docId: file.docId,
      title: file.title,
      documentPath: file.documentPath,
      revision: file.revision,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    });

    const buildOverview = (workspaceId: string) => {
      const visibleWorkspaces = workspaces.filter((workspace) => !workspace.deletedAt);
      const visibleFolders = folders.filter((folder) => !folder.deletedAt && folder.workspaceId === workspaceId);
      const visibleFiles = files.filter((file) => !file.deletedAt && file.workspaceId === workspaceId);
      const fileCountByFolder = new Map<string, number>();
      for (const file of visibleFiles) {
        if (!file.folderId) {
          continue;
        }
        fileCountByFolder.set(file.folderId, (fileCountByFolder.get(file.folderId) ?? 0) + 1);
      }
      return {
        activeWorkspaceId: workspaceId,
        workspaces: visibleWorkspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        })),
        folders: visibleFolders.map((folder) => ({
          id: folder.id,
          workspaceId: folder.workspaceId,
          parentFolderId: folder.parentFolderId,
          name: folder.name,
          fileCount: fileCountByFolder.get(folder.id) ?? 0,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
        })),
        files: visibleFiles.map(mapMetadata),
      };
    };

    const createFileFromDocument = (
      document: SigmaDocument,
      workspaceIdInput: string | null | undefined,
      folderIdInput: string | null | undefined,
    ) => {
      const workspace = resolveWorkspace(workspaceIdInput ?? null);
      if (!workspace) {
        throw new Error("ワークスペースが見つかりません。");
      }
      const folderResult = resolveFolderId(workspace.id, folderIdInput ?? null);
      if (!folderResult.ok) {
        throw new Error(folderResult.error);
      }
      const timestamp = document.updatedAt ?? now();
      const title = (document.metadata?.title ?? "").trim();
      const file: LibFile = {
        fileId: createId("file"),
        workspaceId: workspace.id,
        folderId: folderResult.folderId,
        docId: document.docId,
        title,
        documentPath: `/tmp/e2e-workspace-mock/${createId("path")}.sigmadoc.json`,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      files.push(file);
      documentsByFileId.set(file.fileId, structuredClone(document));
      touchWorkspace(workspace.id, timestamp);
      workspaceOpenState = { openFileIds: [file.fileId], activeFileId: file.fileId };
      return { file: mapMetadata(file), document: structuredClone(document) };
    };

    const changeHandlers = new Set<(event: unknown) => void>();
    (window as unknown as { __triggerWorkspaceChange?: () => void }).__triggerWorkspaceChange = () => {
      changeHandlers.forEach((handler) => handler({ type: "workspace", timestamp: Date.now() }));
    };

    window.desktopAPI = {
      isDesktop: true,
      platform: "darwin",
      app: {
        getInfo: async () => ({ version: "0.1.0", releaseUrl: "https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest" }),
        openLatestReleasePage: async () => ({ ok: true }),
      },
      shell: {
        openExternal: async () => ({ ok: true }),
      },
      codex: {
        getStatus: async () => ({
          available: false, running: false, loggedIn: false, codexHome: "", codexBin: "codex",
          configuredCodexBin: null, account: null, error: null,
        }),
        setBin: async () => ({
          available: false, running: false, loggedIn: false, codexHome: "", codexBin: "codex",
          configuredCodexBin: null, account: null, error: null,
        }),
        selectBin: async () => ({ canceled: true }),
        login: async () => ({ ok: false, error: "disabled in e2e" }),
        openInstallPage: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
        onStatusChange: () => () => undefined,
      },
      aiEdit: {
        run: async () => ({ ok: false }),
      },
      file: {
        openSigmaDoc: async () => null,
        saveSigmaDoc: async () => null,
      },
      materials: {
        listMaterials: async () => [],
        createMaterial: async () => {
          throw new Error("disabled in e2e");
        },
        renameMaterial: async () => {
          throw new Error("disabled in e2e");
        },
        updateMaterialMetadata: async () => {
          throw new Error("disabled in e2e");
        },
        deleteMaterial: async () => ({ ok: false, error: "disabled in e2e" }),
      },
      templates: {
        listTemplates: async (requestedWorkspaceId?: string | null) => structuredClone(
          requestedWorkspaceId
            ? currentTemplates.filter((template) => template.workspaceId === requestedWorkspaceId)
            : currentTemplates,
        ),
        createTemplate: async (input: { workspaceId: string; name: string; document: SigmaDocument }) => {
          const template: TemplateItem = {
            version: 1,
            id: createId("template"),
            workspaceId: input.workspaceId,
            name: input.name.trim() || "無題のテンプレート",
            document: structuredClone(input.document),
            createdAt: now(),
            updatedAt: now(),
          };
          currentTemplates = [template, ...currentTemplates];
          return structuredClone(template);
        },
        renameTemplate: async (id: string, name: string) => {
          const template = currentTemplates.find((item) => item.id === id);
          if (!template) {
            throw new Error("テンプレートが見つかりません。");
          }
          template.name = name.trim() || "無題のテンプレート";
          template.updatedAt = now();
          return structuredClone(template);
        },
        deleteTemplate: async (id: string) => {
          const next = currentTemplates.filter((item) => item.id !== id);
          if (next.length === currentTemplates.length) {
            return { ok: false, error: "テンプレートが見つかりません。" };
          }
          currentTemplates = next;
          return { ok: true };
        },
      },
      storage: {
        initializeWorkspace: async () => currentLedgerSchemaFailure
          ? { ok: false as const, ledgerError: structuredClone(currentLedgerSchemaFailure) }
          : { ok: true as const, state: { ...workspaceOpenState } },
        listFiles: async () => {
          return files
            .filter((file) => !file.deletedAt)
            .map(mapMetadata);
        },
        loadDocument: async (fileId: string) => {
          const document = documentsByFileId.get(fileId);
          return document ? structuredClone(document) : null;
        },
        loadDocumentWithRecovery: async (fileId: string) => {
          const file = findFile(fileId);
          const document = documentsByFileId.get(fileId);
          return file && document
            ? {
                ok: true as const,
                document: structuredClone(document),
                revision: file.revision,
                recoveryIssues: [],
              }
            : { ok: false as const, error: "教材を読み込めませんでした。" };
        },
        saveDocument: async (
          fileId: string,
          document: SigmaDocument,
          saveOptions?: { expectedRevision?: number },
        ) => {
          if (renameDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, renameDelayMs));
          }
          const file = findFile(fileId);
          if (!file) {
            return { ok: false, error: "保存先の教材ファイルが見つかりません。" };
          }
          if (
            saveOptions?.expectedRevision !== undefined
            && saveOptions.expectedRevision !== file.revision
          ) {
            return {
              ok: false,
              code: "revision-mismatch" as const,
              currentRevision: file.revision,
              error: "他の変更が先に保存されています。",
            };
          }
          const timestamp = document.updatedAt ?? now();
          file.title = (document.metadata?.title ?? "").trim();
          file.docId = document.docId;
          file.revision += 1;
          file.updatedAt = timestamp;
          touchWorkspace(file.workspaceId, timestamp);
          documentsByFileId.set(fileId, structuredClone(document));
          return { ok: true, revision: file.revision };
        },
        createDocument: async (payload?: { title?: string; workspaceId?: string | null; folderId?: string | null }) => {
          const title = (payload?.title ?? "無題の教材").trim() || "無題の教材";
          const document = createWorkspaceMockDocumentInBrowser(title, createId("doc"));
          return createFileFromDocument(document, payload?.workspaceId, payload?.folderId);
        },
        createFileFromDocument: async (payload: { document: SigmaDocument; workspaceId?: string | null; folderId?: string | null }) =>
          createFileFromDocument(payload.document, payload.workspaceId, payload.folderId),
        duplicateFile: async (fileId: string) => {
          const source = findFile(fileId);
          const sourceDocument = documentsByFileId.get(fileId);
          if (!source || !sourceDocument) {
            throw new Error("複製する教材ファイルが見つかりません。");
          }
          const copy: SigmaDocument = {
            ...structuredClone(sourceDocument),
            docId: createId("doc"),
            metadata: {
              ...sourceDocument.metadata,
              title: `${(sourceDocument.metadata?.title ?? "").trim() || "無題の教材"} のコピー`,
            },
            updatedAt: now(),
          };
          return createFileFromDocument(copy, source.workspaceId, source.folderId);
        },
        deleteFile: async (fileId: string) => {
          const file = findFile(fileId);
          if (!file) {
            return { ok: false, error: "削除する教材ファイルが見つかりません。" };
          }
          const timestamp = now();
          file.deletedAt = timestamp;
          file.updatedAt = timestamp;
          touchWorkspace(file.workspaceId, timestamp);
          return { ok: true };
        },
        saveWorkspace: async (state: { openFileIds: string[]; activeFileId: string }) => {
          workspaceOpenState = { ...state };
          return { ok: true };
        },
        getWorkspaceOverview: async (workspaceId?: string | null) => {
          if (currentLedgerSchemaFailure) {
            return {
              state: "ledger-schema-error" as const,
              failure: structuredClone(currentLedgerSchemaFailure),
            };
          }
          const workspace = resolveWorkspace(workspaceId ?? null);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          if (activeWorkspaceId !== workspace.id) {
            activeWorkspaceId = workspace.id;
          }
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        createWorkspace: async (name: string) => {
          const timestamp = now();
          const workspace: LibWorkspace = {
            id: createId("workspace"),
            name: name.trim() || "新しいワークスペース",
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: null,
          };
          workspaces.push(workspace);
          activeWorkspaceId = workspace.id;
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        renameWorkspace: async (workspaceId: string, name: string) => {
          const workspace = findWorkspace(workspaceId);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          workspace.name = name.trim() || workspace.name;
          workspace.updatedAt = now();
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        deleteWorkspace: async (workspaceId: string) => {
          const workspace = findWorkspace(workspaceId);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          const remaining = workspaces.filter((candidate) =>
            !candidate.deletedAt && candidate.id !== workspaceId);
          if (remaining.length === 0) {
            return { state: "error", error: "最後のワークスペースは削除できません。" };
          }
          const timestamp = now();
          folders.forEach((folder) => {
            if (folder.workspaceId === workspaceId && !folder.deletedAt) {
              folder.deletedAt = timestamp;
              folder.updatedAt = timestamp;
            }
          });
          files.forEach((file) => {
            if (file.workspaceId === workspaceId && !file.deletedAt) {
              file.deletedAt = timestamp;
              file.updatedAt = timestamp;
            }
          });
          workspace.deletedAt = timestamp;
          workspace.updatedAt = timestamp;
          const nextActive = remaining[0];
          activeWorkspaceId = nextActive.id;
          return { state: "ready", overview: buildOverview(activeWorkspaceId) };
        },
        createFolder: async (workspaceId: string, name: string, parentFolderId?: string | null) => {
          const workspace = resolveWorkspace(workspaceId);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          const parentResult = resolveFolderId(workspace.id, parentFolderId ?? null);
          if (!parentResult.ok) {
            return { state: "error", error: parentResult.error };
          }
          const timestamp = now();
          const folder: LibFolder = {
            id: createId("folder"),
            workspaceId: workspace.id,
            parentFolderId: parentResult.folderId,
            name: name.trim() || "新しいフォルダ",
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: null,
          };
          folders.push(folder);
          touchWorkspace(workspace.id, timestamp);
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        updateFolder: async (workspaceId: string, folderId: string, patch: { name?: string; parentFolderId?: string | null }) => {
          const workspace = resolveWorkspace(workspaceId);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          const folder = findFolder(workspace.id, folderId);
          if (!folder) {
            return { state: "error", error: "フォルダが見つかりません。" };
          }
          let nextParentFolderId = folder.parentFolderId;
          if (patch.parentFolderId !== undefined) {
            const parentResult = resolveFolderId(workspace.id, patch.parentFolderId);
            if (!parentResult.ok) {
              return { state: "error", error: parentResult.error };
            }
            nextParentFolderId = parentResult.folderId;
          }
          if (nextParentFolderId && (nextParentFolderId === folder.id || isFolderDescendant(workspace.id, nextParentFolderId, folder.id))) {
            return { state: "error", error: "自分自身または配下のフォルダへ移動できません。" };
          }
          const timestamp = now();
          if (patch.name !== undefined) {
            folder.name = patch.name.trim() || folder.name;
          }
          folder.parentFolderId = nextParentFolderId;
          folder.updatedAt = timestamp;
          touchWorkspace(workspace.id, timestamp);
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        deleteFolder: async (workspaceId: string, folderId: string) => {
          const workspace = resolveWorkspace(workspaceId);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          const folder = findFolder(workspace.id, folderId);
          if (!folder) {
            return { state: "error", error: "フォルダが見つかりません。" };
          }
          const hasChildFolder = folders.some((candidate) =>
            candidate.workspaceId === workspace.id && candidate.parentFolderId === folderId && !candidate.deletedAt);
          const hasFile = files.some((candidate) =>
            candidate.workspaceId === workspace.id && candidate.folderId === folderId && !candidate.deletedAt);
          if (hasChildFolder || hasFile) {
            return { state: "error", error: "中身があるフォルダは削除できません。" };
          }
          const timestamp = now();
          folder.deletedAt = timestamp;
          folder.updatedAt = timestamp;
          touchWorkspace(workspace.id, timestamp);
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        moveFileToFolder: async (workspaceId: string, fileId: string, folderId?: string | null) => {
          const workspace = resolveWorkspace(workspaceId);
          if (!workspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          const file = findFile(fileId);
          if (!file || file.workspaceId !== workspace.id) {
            return { state: "error", error: "教材ファイルが見つかりません。" };
          }
          const folderResult = resolveFolderId(workspace.id, folderId ?? null);
          if (!folderResult.ok) {
            return { state: "error", error: folderResult.error };
          }
          const timestamp = now();
          file.folderId = folderResult.folderId;
          file.updatedAt = timestamp;
          touchWorkspace(workspace.id, timestamp);
          return { state: "ready", overview: buildOverview(workspace.id) };
        },
        moveFileToWorkspace: async (fileId: string, targetWorkspaceId: string, folderId?: string | null) => {
          const file = findFile(fileId);
          if (!file) {
            return { state: "error", error: "教材ファイルが見つかりません。" };
          }
          const targetWorkspace = resolveWorkspace(targetWorkspaceId);
          if (!targetWorkspace) {
            return { state: "error", error: "ワークスペースが見つかりません。" };
          }
          const folderResult = resolveFolderId(targetWorkspace.id, folderId ?? null);
          if (!folderResult.ok) {
            return { state: "error", error: folderResult.error };
          }
          const timestamp = now();
          const previousWorkspaceId = file.workspaceId;
          file.workspaceId = targetWorkspace.id;
          file.folderId = folderResult.folderId;
          file.updatedAt = timestamp;
          touchWorkspace(previousWorkspaceId, timestamp);
          touchWorkspace(targetWorkspace.id, timestamp);
          activeWorkspaceId = targetWorkspace.id;
          return { state: "ready", overview: buildOverview(targetWorkspace.id) };
        },
        getDataDir: async () => ({ path: "/tmp/e2e-workspace-mock" }),
        listMcpEditProposals: async () => [],
        approveMcpEditProposal: async () => ({ ok: false, error: "disabled in e2e" }),
        approveMcpEditProposals: async () => ({ ok: false, error: "disabled in e2e" }),
        rejectMcpEditProposal: async () => ({ ok: false, error: "disabled in e2e" }),
        onChange: (handler: (event: unknown) => void) => {
          changeHandlers.add(handler);
          return () => {
            changeHandlers.delete(handler);
          };
        },
      },
      workspacePreview: {
        get: async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        put: async () => ({ ok: true }),
      },
      onMenuAction: () => () => undefined,
    } as unknown as Window["desktopAPI"];

    // Local helper (module-scope `createWorkspaceMockDocument` above runs in
    // Node, not in the page -- this browser-side twin builds the same shape
    // for documents created interactively during a test, e.g. via 新しい教材).
    function createWorkspaceMockDocumentInBrowser(title: string, docId: string): SigmaDocument {
      return {
        version: "2.0",
        docId,
        metadata: { title },
        content: [
          {
            type: "paragraph",
            id: `${docId}_p`,
            children: [{ type: "text", text: title || "無題の教材" }],
          },
        ],
        outputProfiles: {
          student: { showSolutions: false, showHints: false, includeAnswers: false },
          teacher: { showSolutions: true, showHints: true, includeAnswers: true },
          answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
        },
      } as unknown as SigmaDocument;
    }
  }, {
    seed,
    renameDelayMs: options.renameDelayMs ?? 0,
    initialLedgerSchemaFailure: options.ledgerSchemaFailure ?? null,
  });
}
