import type { LibrarySharingMetadata, SharedCatalogStatus } from "./shared-catalog";
import type {
  DesktopMcpEditProposalActionResult,
  DesktopMcpEditProposalStatus,
  DesktopMcpEditProposalSummary,
  DesktopStorageChangeEvent,
} from "@/types/desktop";
import type { SigmaDocument } from "@/features/document";
import type { MaterialContent, MaterialItem } from "@/types/material";
import type { TemplateItem } from "@/types/template";
import type { LedgerSchemaFailure } from "@/lib/library-schema";
import type { SigmaDocumentRecoveryIssue, SigmaDocumentSchemaFailure } from "@/lib/sigma-doc-schema";
import type {
  DocumentVersion,
  DocumentVersionMetadata,
  DocumentVersionOrigin,
} from "@/lib/document-version-history";
import type { WorkspaceLayoutV2 } from "@/lib/workspace-tab-groups";

/**
 * どの土台で動いているか。
 * - `desktop`: Electron の preload bridge (`window.desktopAPI`) がある。保存先はユーザーデータの実ファイル。
 * - `web`: 素のブラウザ。保存先はこのブラウザの IndexedDB。
 */
export type RuntimeTarget = "desktop" | "web";

export interface RuntimeCapabilities {
  /** ユーザーデータ配下の実ファイルへ保存する。 */
  desktopStorage: boolean;
  /** このブラウザの IndexedDB へ保存する。 */
  browserStorage: boolean;
  localFolders: boolean;
  /** 保存先の外部変更を監視して通知できる (desktop: fs.watch / web: 他タブ配信)。 */
  localFileWatch: boolean;
  mcpProposals: boolean;
  codexAppServerAi: boolean;
  hostedAiApi: boolean;
  publicWeb: boolean;
}

export interface StorageResult {
  ok: boolean;
  error?: string;
  code?: "revision-mismatch";
  currentRevision?: number;
  revision?: number;
  versionCaptured?: boolean;
  versionCaptureError?: string;
  versionCleanupError?: string;
}

export interface DocumentMetadata {
  sharingPending?: boolean;
  sharing?: LibrarySharingMetadata;
  fileId: string;
  workspaceId: string;
  folderId: string | null;
  docId: string;
  title: string;
  documentPath?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceState {
  openFileIds: string[];
  activeFileId: string;
  /** Chrome-like split/tab layout. Legacy callers may omit it. */
  layout?: WorkspaceLayoutV2;
}

export type WorkspaceInitializationResult =
  | { ok: true; state: WorkspaceState }
  | { ok: false; ledgerError: LedgerSchemaFailure };

export interface DocumentFileRecord {
  fileId: string;
  document: SigmaDocument;
  metadata: DocumentMetadata;
  recoveryIssues?: SigmaDocumentRecoveryIssue[];
  recoveryBackupPath?: string;
}

/**
 * 読み込み失敗の分類。"json" / "schema" は教材そのものの中身が原因なので、
 * UI は別教材へ黙って切り替えず、原因を表示したまま開いておく。
 */
export type DocumentLoadFailureKind = "missing" | "json" | "schema" | "io";

export type DocumentLoadResult =
  | {
      ok: true;
      document: SigmaDocument;
      revision: number;
      recoveryIssues: SigmaDocumentRecoveryIssue[];
      recoveryBackupPath?: string;
    }
  | {
      ok: false;
      error: string;
      failureKind?: DocumentLoadFailureKind;
      failures?: SigmaDocumentSchemaFailure[];
      documentPath?: string;
      title?: string;
    };

export interface CreateDocumentInput {
  title?: string;
  workspaceId?: string | null;
  folderId?: string | null;
}

export interface CreateFileFromDocumentInput {
  document: SigmaDocument;
  workspaceId?: string | null;
  folderId?: string | null;
}


export interface WorkspaceSummary {
  sharingPending?: boolean;
  sharing?: LibrarySharingMetadata;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFolderSummary {
  sharingPending?: boolean;
  sharing?: LibrarySharingMetadata;
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceFileSummary = DocumentMetadata;

export interface WorkspaceOverview {
  catalog?: SharedCatalogStatus;
  activeWorkspaceId: string;
  workspaces: WorkspaceSummary[];
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
}

export type WorkspaceOverviewResult =
  | { state: "unavailable"; error?: string }
  | { state: "error"; error: string }
  | { state: "ledger-schema-error"; failure: LedgerSchemaFailure }
  | { state: "ready"; overview: WorkspaceOverview };

export interface FolderPatch {
  name?: string;
  parentFolderId?: string | null;
}

export type ListMcpEditProposalsOptions = {
  status?: DesktopMcpEditProposalStatus | "all";
  fileId?: string;
  resolvedLimit?: number;
};

/**
 * デスクトップ / ブラウザのどちらでも成立する教材保存の契約。
 *
 * ここに置いてよいのは「教材と台帳をどう読み書きするか」だけ。ユーザーデータの
 * 実パスや MCP 提案のように desktop でしか意味を持たないものは
 * `LocalLibraryRepository` 側へ置く。
 */
export interface DocumentLibraryRepository {
  initializeWorkspace(): Promise<WorkspaceInitializationResult>;
  listFiles(): Promise<DocumentMetadata[]>;
  loadDocument(fileId: string): Promise<SigmaDocument | null>;
  loadDocumentWithRecovery(fileId: string): Promise<DocumentLoadResult>;
  saveDocument(
    fileId: string,
    document: SigmaDocument,
    options: { expectedRevision: number; origin?: DocumentVersionOrigin },
  ): Promise<StorageResult>;
  listDocumentVersions(fileId: string): Promise<DocumentVersionMetadata[]>;
  getDocumentVersion(fileId: string, versionId: string): Promise<DocumentVersion | null>;
  captureDocumentVersion(
    fileId: string,
    document: SigmaDocument,
    options: { expectedRevision: number; origin: DocumentVersionOrigin },
  ): Promise<{ ok: boolean; version?: DocumentVersionMetadata; error?: string }>;
  createDocument(input?: CreateDocumentInput): Promise<DocumentFileRecord>;
  createFileFromDocument(input: CreateFileFromDocumentInput): Promise<DocumentFileRecord>;
  duplicateFile(fileId: string): Promise<DocumentFileRecord>;
  deleteFile(fileId: string, options?: { expectedRevision: number }): Promise<StorageResult>;
  saveWorkspace(state: WorkspaceState): Promise<StorageResult>;
  onChange(handler: (event: DesktopStorageChangeEvent) => void): () => void;
}

/** desktop 専用の追加操作。ブラウザには対応物が無い。 */
export interface LocalLibraryRepository extends DocumentLibraryRepository {
  getDataDir(): Promise<{ path: string }>;
  listMcpEditProposals(options?: ListMcpEditProposalsOptions): Promise<DesktopMcpEditProposalSummary[]>;
  approveMcpEditProposal(proposalId: string): Promise<DesktopMcpEditProposalActionResult>;
  rejectMcpEditProposal(proposalId: string): Promise<DesktopMcpEditProposalActionResult>;
}

export interface LocalWorkspaceRepository {
  renameDocument?(workspaceId: string, fileId: string, name: string): Promise<WorkspaceOverviewResult>;
  listOverview(workspaceId?: string | null): Promise<WorkspaceOverviewResult>;
  createWorkspace(name: string): Promise<WorkspaceOverviewResult>;
  renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceOverviewResult>;
  deleteWorkspace(workspaceId: string): Promise<WorkspaceOverviewResult>;
  createFolder(workspaceId: string, name: string, parentFolderId?: string | null): Promise<WorkspaceOverviewResult>;
  updateFolder(workspaceId: string, folderId: string, patch: FolderPatch): Promise<WorkspaceOverviewResult>;
  deleteFolder(workspaceId: string, folderId: string): Promise<WorkspaceOverviewResult>;
  moveFileToFolder(workspaceId: string, fileId: string, folderId?: string | null): Promise<WorkspaceOverviewResult>;
  moveFileToWorkspace(fileId: string, targetWorkspaceId: string, folderId?: string | null): Promise<WorkspaceOverviewResult>;
}

export type CreateMaterialInput = { name: string; content: MaterialContent }
  & Pick<MaterialItem, "description" | "tags" | "usage" | "visualConcepts" | "transformPolicy" | "ports">;

export type UpdateMaterialInput = Partial<Pick<
  MaterialItem,
  "name" | "description" | "tags" | "usage" | "visualConcepts" | "transformPolicy" | "ports" | "content"
>>;

export interface MaterialRepository {
  listMaterials(): Promise<MaterialItem[]>;
  createMaterial(input: CreateMaterialInput): Promise<MaterialItem>;
  renameMaterial(id: string, name: string): Promise<MaterialItem>;
  updateMaterialMetadata(id: string, input: UpdateMaterialInput): Promise<MaterialItem>;
  deleteMaterial(id: string): Promise<StorageResult>;
}

export interface TemplateRepository {
  listTemplates(workspaceId?: string | null): Promise<TemplateItem[]>;
  createTemplate(input: { workspaceId: string; name: string; document: SigmaDocument }): Promise<TemplateItem>;
  renameTemplate(id: string, name: string): Promise<TemplateItem>;
  deleteTemplate(id: string): Promise<StorageResult>;
}

export interface DesktopAiRuntime {
  run(payload: unknown, onEvent: (event: unknown) => void): Promise<unknown>;
}

/**
 * 教材の保存先。desktop でもブラウザでも必ず 1 つ手に入る (`getAppRuntime`)。
 * desktop 固有の機能が要る呼び出しだけが `getDesktopRuntime()` を使う。
 */
export interface AppRuntime {
  target: RuntimeTarget;
  capabilities: RuntimeCapabilities;
  library: DocumentLibraryRepository;
  workspace: LocalWorkspaceRepository;
  templates: TemplateRepository;
  materials: MaterialRepository;
}

export interface DesktopRuntime extends AppRuntime {
  target: "desktop";
  library: LocalLibraryRepository;
  ai: DesktopAiRuntime;
}
