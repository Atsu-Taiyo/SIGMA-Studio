import { getAppRuntime } from "@/lib/runtime";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type {
  DocumentFileRecord,
  FolderPatch,
  WorkspaceFileSummary,
  WorkspaceFolderSummary,
  WorkspaceOverview,
  WorkspaceOverviewResult,
} from "@/lib/runtime";
import type { SigmaDocument } from "@/features/document";
import { availableDocumentTitle } from "@/lib/library-ledger";
import {
  createObservedDocumentWrite,
  saveDocumentRecord,
} from "@/lib/storage";

export type {
  WorkspaceFileSummary,
  WorkspaceFolderSummary,
  WorkspaceOverview,
  WorkspaceOverviewResult,
};

const tWorkspace = createCurrentLocaleTranslator("workspace");

export async function listWorkspaceOverview(
  workspaceId?: string | null,
): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.listOverview(workspaceId);
}

export async function loadWorkspacePreviewDocument(fileId: string): Promise<SigmaDocument | null> {
  try {
    const runtime = getAppRuntime();
    return await runtime.library.loadDocument(fileId);
  } catch {
    return null;
  }
}

export async function createWorkspace(name: string): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.createWorkspace(name);
}

export async function updateWorkspaceName(workspaceId: string, name: string): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.renameWorkspace(workspaceId, name);
}

export async function deleteWorkspace(workspaceId: string): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.deleteWorkspace(workspaceId);
}

export async function createFolder(
  workspaceId: string,
  name: string,
  parentFolderId?: string | null,
): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.createFolder(workspaceId, name, parentFolderId);
}

export async function updateFolder(
  workspaceId: string,
  folderId: string,
  patch: FolderPatch,
): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.updateFolder(workspaceId, folderId, patch);
}

export async function deleteFolder(workspaceId: string, folderId: string): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.deleteFolder(workspaceId, folderId);
}

export async function createDocumentInWorkspace(
  workspaceId: string,
  folderId: string | null,
  title = tWorkspace("untitledMaterial"),
): Promise<WorkspaceOverviewResult> {
  const runtime = getAppRuntime();
  const result = await runtime.library.createDocument({ workspaceId, folderId, title });
  return runtime.workspace.listOverview(result.metadata.workspaceId);
}

export async function createDocumentFromTemplateInWorkspace(
  workspaceId: string,
  folderId: string | null,
  document: SigmaDocument,
): Promise<DocumentFileRecord> {
  return getAppRuntime().library.createFileFromDocument({ document, workspaceId, folderId });
}

export async function deleteDocumentInWorkspace(
  workspaceId: string,
  fileId: string,
): Promise<WorkspaceOverviewResult> {
  const runtime = getAppRuntime();
  const result = await runtime.library.deleteFile(fileId);
  if (!result.ok) {
    return { state: "error", error: result.error ?? tWorkspace("error.deleteMaterialFailed") };
  }

  return runtime.workspace.listOverview(workspaceId);
}

export async function renameDocumentInWorkspace(
  workspaceId: string,
  fileId: string,
  name: string,
): Promise<WorkspaceOverviewResult> {
  const runtime = getAppRuntime();
  const files = await runtime.library.listFiles();
  const target = files.find((file) => file.fileId === fileId);
  const title = target
    ? availableDocumentTitle(name, files, { ...target, excludeFileId: fileId })
    : name.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 教材名変更も本文全体を読み書きするため、AI承認と競合したら最新docへタイトルだけを
    // 付け直す。古い本文を無条件保存してAI変更を消さないため、mismatch時だけ1回読み直す。
    const loaded = await runtime.library.loadDocumentWithRecovery(fileId);
    if (!loaded.ok) {
      return { state: "error", error: loaded.error || tWorkspace("error.loadMaterialFailed") };
    }

    const result = await saveDocumentRecord(createObservedDocumentWrite({
      fileId,
      observedRevision: loaded.revision,
      document: {
        ...loaded.document,
        metadata: {
          ...loaded.document.metadata,
          title,
        },
        updatedAt: new Date().toISOString(),
      },
    }));
    if (result.ok) {
      return runtime.workspace.listOverview(workspaceId);
    }
    if (result.code !== "revision-mismatch" || attempt === 1) {
      return { state: "error", error: result.error ?? tWorkspace("error.renameMaterialFailed") };
    }
  }

  return { state: "error", error: tWorkspace("error.renameMaterialFailed") };
}

export async function moveFileToFolder(
  workspaceId: string,
  fileId: string,
  folderId?: string | null,
): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.moveFileToFolder(workspaceId, fileId, folderId);
}

export async function moveFileToWorkspace(
  fileId: string,
  targetWorkspaceId: string,
  folderId?: string | null,
): Promise<WorkspaceOverviewResult> {
  return getAppRuntime().workspace.moveFileToWorkspace(fileId, targetWorkspaceId, folderId);
}
