import { getAppRuntime } from "@/lib/runtime";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type {
  DocumentFileRecord,
  DocumentLoadResult,
  DocumentMetadata,
  StorageResult,
  WorkspaceInitializationResult,
  WorkspaceState,
} from "@/lib/runtime";
import type { SigmaDocument } from "@/features/document";
import type { DocumentVersionOrigin } from "@/lib/document-version-history";

const tWorkspace = createCurrentLocaleTranslator("workspace");

export const STORAGE_KEY = "sigma-studio:document";

export type {
  DocumentFileRecord,
  DocumentLoadResult,
  DocumentMetadata,
  StorageResult,
  WorkspaceInitializationResult,
  WorkspaceState,
};

declare const observedDocumentWriteBrand: unique symbol;

/**
 * A document payload and the file revision that the payload was derived from.
 *
 * Saving accepts only this envelope so a later metadata refresh cannot silently
 * lend a stale document a newer expectedRevision. Callers must capture the
 * revision at the same boundary where they adopt/build the document payload.
 */
export type ObservedDocumentWrite = Readonly<{
  fileId: string;
  document: SigmaDocument;
  observedRevision: number;
  [observedDocumentWriteBrand]: true;
}>;

export function createObservedDocumentWrite(input: {
  fileId: string;
  document: SigmaDocument;
  observedRevision: number;
}): ObservedDocumentWrite {
  if (!Number.isInteger(input.observedRevision) || input.observedRevision < 0) {
    throw new Error(tWorkspace("error.invalidRevision"));
  }
  return input as ObservedDocumentWrite;
}

/**
 * @deprecated 保存経路は runtime (desktop: IPC / web: IndexedDB) の非同期APIです。
 */
export function loadSavedDocument(): SigmaDocument | null {
  return null;
}

/**
 * @deprecated 保存経路は ObservedDocumentWrite の保存です。
 */
export function saveDocument(document: SigmaDocument): StorageResult {
  void document;
  return { ok: false, error: tWorkspace("error.storageRuntimeMissing") };
}

/**
 * @deprecated 教材の正本を localStorage に置くことはありません (web は IndexedDB)。
 */
export function clearSavedDocument(): void {
}

export async function initializeDocumentWorkspace(): Promise<WorkspaceInitializationResult> {
  return getRuntimeLibrary().initializeWorkspace();
}

export async function listSavedDocuments(): Promise<DocumentMetadata[]> {
  return getRuntimeLibrary().listFiles();
}

export async function loadDocumentByFileId(fileId: string): Promise<SigmaDocument | null> {
  return getRuntimeLibrary().loadDocument(fileId);
}

export async function loadDocumentByFileIdWithRecovery(fileId: string): Promise<DocumentLoadResult> {
  return getRuntimeLibrary().loadDocumentWithRecovery(fileId);
}

/**
 * @deprecated Desktop runtime の正本IDは fileId です。新しい呼び出しでは loadDocumentByFileId を使ってください。
 */
export async function loadDocumentById(docId: string): Promise<SigmaDocument | null> {
  return loadDocumentByFileId(docId);
}

export async function saveDocumentRecord(
  write: ObservedDocumentWrite,
  options: { origin?: DocumentVersionOrigin } = {},
): Promise<StorageResult> {
  return getRuntimeLibrary().saveDocument(write.fileId, write.document, {
    expectedRevision: write.observedRevision,
    origin: options.origin,
  });
}

export async function listDocumentVersions(fileId: string) {
  return getRuntimeLibrary().listDocumentVersions(fileId);
}

export async function getDocumentVersion(fileId: string, versionId: string) {
  return getRuntimeLibrary().getDocumentVersion(fileId, versionId);
}

export async function captureDocumentVersion(
  write: ObservedDocumentWrite,
  origin: DocumentVersionOrigin = "restore-backup",
) {
  return getRuntimeLibrary().captureDocumentVersion(write.fileId, write.document, {
    expectedRevision: write.observedRevision,
    origin,
  });
}

/** D3: 作成時点の UI 言語で題名を焼く (既定値は呼び出しごとに評価される)。 */
export async function createNewDocument(title = tWorkspace("untitledMaterial")): Promise<DocumentFileRecord> {
  return getRuntimeLibrary().createDocument({ title });
}

export async function createDocumentFromSigmaDocument(document: SigmaDocument): Promise<DocumentFileRecord> {
  return getRuntimeLibrary().createFileFromDocument({ document });
}

export async function duplicateDocument(fileId: string): Promise<DocumentFileRecord> {
  return getRuntimeLibrary().duplicateFile(fileId);
}

export async function deleteDocument(fileId: string, options?: { expectedRevision: number }): Promise<StorageResult> {
  return getRuntimeLibrary().deleteFile(fileId, options);
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<StorageResult> {
  return getRuntimeLibrary().saveWorkspace(state);
}

/** 保存先は desktop / web のどちらでも 1 つに解決される (`getAppRuntime`)。 */
function getRuntimeLibrary() {
  return getAppRuntime().library;
}
