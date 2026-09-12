import { getDesktopBridge } from "@/lib/desktop-bridge";
import { measurePerformance } from "@/lib/performance";
import { createId } from "@/lib/id";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  ensurePageLayout,
  type SigmaDocument,
} from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import type {
  DesktopMaterialsAPI,
  DesktopStorageAPI,
  DesktopTemplatesAPI,
} from "@/types/desktop";

import type {
  CreateDocumentInput,
  CreateFileFromDocumentInput,
  DocumentFileRecord,
  DocumentLoadResult,
  DocumentMetadata,
  DesktopRuntime,
  LocalLibraryRepository,
  LocalWorkspaceRepository,
  MaterialRepository,
  RuntimeCapabilities,
  TemplateRepository,
  WorkspaceInitializationResult,
  WorkspaceOverviewResult,
} from "./types";

const te = createCurrentLocaleTranslator("error");

const DESKTOP_CAPABILITIES: RuntimeCapabilities = {
  desktopStorage: true,
  browserStorage: false,
  localFolders: true,
  localFileWatch: true,
  mcpProposals: true,
  codexAppServerAi: true,
  hostedAiApi: false,
  publicWeb: false,
};

export function getDesktopRuntime(): DesktopRuntime | null {
  const bridge = getDesktopBridge();
  if (!bridge?.storage) {
    return null;
  }

  return {
    target: "desktop",
    capabilities: DESKTOP_CAPABILITIES,
    library: createDesktopLibraryRepository(bridge.storage),
    workspace: createDesktopWorkspaceRepository(bridge.storage),
    templates: createDesktopTemplateRepository(bridge.templates),
    materials: createDesktopMaterialRepository(bridge.materials),
    ai: bridge.aiEdit,
  };
}

export function isDesktopRuntimeAvailable(): boolean {
  return getDesktopRuntime() !== null;
}

function createDesktopLibraryRepository(storage: DesktopStorageAPI): LocalLibraryRepository {
  return {
    async initializeWorkspace(): Promise<WorkspaceInitializationResult> {
      return storage.initializeWorkspace({ initialDocument: createInitialDocument() });
    },
    async listFiles(): Promise<DocumentMetadata[]> {
      return storage.listFiles();
    },
    async loadDocument(fileId: string): Promise<SigmaDocument | null> {
      const document = await storage.loadDocument(fileId);
      return document ? ensurePageLayout(document) : null;
    },
    async loadDocumentWithRecovery(fileId: string): Promise<DocumentLoadResult> {
      if (!storage.loadDocumentWithRecovery) {
        const [document, files] = await Promise.all([
          storage.loadDocument(fileId),
          storage.listFiles(),
        ]);
        const revision = files.find((file) => file.fileId === fileId)?.revision;
        return document && Number.isFinite(revision)
          ? { ok: true, document: ensurePageLayout(document), revision: revision as number, recoveryIssues: [] }
          : { ok: false, error: te("runtime.documentLoadFailed") };
      }
      const result = await storage.loadDocumentWithRecovery(fileId);
      if (!result.ok) {
        return result;
      }
      return { ...result, document: ensurePageLayout(result.document) };
    },
    async saveDocument(
      fileId: string,
      document: SigmaDocument,
      options: Parameters<LocalLibraryRepository["saveDocument"]>[2],
    ) {
      // renderer では zod 検証をしない。main が保存の直前に必ず
      // `ensurePageLayout(parseSigmaDocument(...))` を通す (`LocalSigmaDocStore#saveDocument`) ので
      // 二度手間で、390KB の教材で主スレッドを 13ms 止めていた (実測)。
      // 残すのは `ensurePageLayout` だけ (zod ではない・0.7ms 未満)。
      const payload = measurePerformance("DesktopRuntime.saveDocument", () => ensurePageLayout(document));
      return storage.saveDocument(fileId, payload, options);
    },
    listDocumentVersions(fileId) {
      return storage.listDocumentVersions(fileId);
    },
    getDocumentVersion(fileId, versionId) {
      return storage.getDocumentVersion(fileId, versionId);
    },
    captureDocumentVersion(fileId, document, options) {
      return storage.captureDocumentVersion(fileId, ensurePageLayout(document), options);
    },
    async createDocument(input?: CreateDocumentInput): Promise<DocumentFileRecord> {
      return normalizeFileRecord(await storage.createDocument(input));
    },
    async createFileFromDocument(input: CreateFileFromDocumentInput): Promise<DocumentFileRecord> {
      return normalizeFileRecord(await storage.createFileFromDocument({
        ...input,
        document: ensurePageLayout(input.document),
      }));
    },
    async duplicateFile(fileId: string): Promise<DocumentFileRecord> {
      return normalizeFileRecord(await storage.duplicateFile(fileId));
    },
    deleteFile(fileId: string, options?: { expectedRevision: number }) {
      return options ? storage.deleteFile(fileId, options) : storage.deleteFile(fileId);
    },
    saveWorkspace(state) {
      return storage.saveWorkspace(state);
    },
    getDataDir() {
      return storage.getDataDir();
    },
    listMcpEditProposals(options) {
      return storage.listMcpEditProposals(options);
    },
    approveMcpEditProposal(proposalId) {
      return storage.approveMcpEditProposal(proposalId);
    },
    rejectMcpEditProposal(proposalId) {
      return storage.rejectMcpEditProposal(proposalId);
    },
    onChange(handler) {
      return storage.onChange(handler);
    },
  };
}

function createDesktopWorkspaceRepository(storage: DesktopStorageAPI): LocalWorkspaceRepository {
  return {
    listOverview(workspaceId?: string | null): Promise<WorkspaceOverviewResult> {
      return storage.getWorkspaceOverview(workspaceId);
    },
    createWorkspace(name: string): Promise<WorkspaceOverviewResult> {
      return storage.createWorkspace(name);
    },
    renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceOverviewResult> {
      return storage.renameWorkspace(workspaceId, name);
    },
    deleteWorkspace(workspaceId: string): Promise<WorkspaceOverviewResult> {
      return storage.deleteWorkspace(workspaceId);
    },
    createFolder(workspaceId: string, name: string, parentFolderId?: string | null): Promise<WorkspaceOverviewResult> {
      return storage.createFolder(workspaceId, name, parentFolderId);
    },
    updateFolder(workspaceId, folderId, patch): Promise<WorkspaceOverviewResult> {
      return storage.updateFolder(workspaceId, folderId, patch);
    },
    deleteFolder(workspaceId: string, folderId: string): Promise<WorkspaceOverviewResult> {
      return storage.deleteFolder(workspaceId, folderId);
    },
    moveFileToFolder(workspaceId: string, fileId: string, folderId?: string | null): Promise<WorkspaceOverviewResult> {
      return storage.moveFileToFolder(workspaceId, fileId, folderId);
    },
    moveFileToWorkspace(fileId: string, targetWorkspaceId: string, folderId?: string | null): Promise<WorkspaceOverviewResult> {
      return storage.moveFileToWorkspace(fileId, targetWorkspaceId, folderId);
    },
  };
}

/**
 * bridge 側の API をそのまま repository として渡さない。古い preload では
 * templates / materials が無い可能性があり、その時は「利用できない」を
 * 明示的に返して呼び出し側の分岐を 1 か所に閉じ込める。
 */
function createDesktopTemplateRepository(templates: DesktopTemplatesAPI | undefined): TemplateRepository {
  return {
    listTemplates: (workspaceId) => templates
      ? templates.listTemplates(workspaceId)
      : Promise.resolve([]),
    createTemplate: (input) => templates
      ? templates.createTemplate(input)
      : Promise.reject(new Error(te("runtime.templatesUnavailable"))),
    renameTemplate: (id, name) => templates
      ? templates.renameTemplate(id, name)
      : Promise.reject(new Error(te("runtime.templatesUnavailable"))),
    deleteTemplate: (id) => templates
      ? templates.deleteTemplate(id)
      : Promise.resolve({ ok: false, error: te("runtime.templatesUnavailable") }),
  };
}

function createDesktopMaterialRepository(materials: DesktopMaterialsAPI | undefined): MaterialRepository {
  return {
    listMaterials: () => materials ? materials.listMaterials() : Promise.resolve([]),
    createMaterial: (input) => materials
      ? materials.createMaterial(input)
      : Promise.reject(new Error(te("runtime.materialsUnavailable"))),
    renameMaterial: (id, name) => materials
      ? materials.renameMaterial(id, name)
      : Promise.reject(new Error(te("runtime.materialsUnavailable"))),
    updateMaterialMetadata: (id, input) => materials
      ? materials.updateMaterialMetadata(id, input)
      : Promise.reject(new Error(te("runtime.materialsUnavailable"))),
    deleteMaterial: (id) => materials
      ? materials.deleteMaterial(id)
      : Promise.resolve({ ok: false, error: te("runtime.materialsUnavailable") }),
  };
}

function createInitialDocument(): SigmaDocument {
  const now = new Date().toISOString();
  return {
    ...ensurePageLayout(createBlankDocument()),
    docId: createId("doc"),
    updatedAt: now,
  };
}

function normalizeFileRecord(record: { file: DocumentMetadata; document: SigmaDocument }): DocumentFileRecord {
  return {
    fileId: record.file.fileId,
    metadata: record.file,
    document: ensurePageLayout(record.document),
  };
}
