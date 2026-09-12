import { createBlankDocument } from "@/lib/blank-document";
import { DEFAULT_DOCUMENT_TITLE, resolveDocumentTitle } from "@/lib/document-title";
import { createId } from "@/lib/id";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  appendFileRow,
  availableDocumentTitle,
  createEmptyLibrary,
  ensureActiveWorkspace,
  ensureDefaultWorkspace,
  findVisibleFile,
  normalizeDocumentTitle,
  rehomeOrphanFileRows,
  resolveFolderId,
  resolveWorkspace,
  resolveWorkspaceState,
  toDocumentMetadata,
  type LedgerFailureReason,
  type LibraryRecord,
} from "@/lib/library-ledger";
import {
  findLedgerSchemaViolations,
  LIBRARY_VERSION,
  type LedgerSchemaFailure,
} from "@/lib/library-schema";
import { parseSigmaDocument, recoverSigmaDocument } from "@/lib/sigma-doc-schema";
import type { DocumentLoadResult, DocumentMetadata } from "@/lib/runtime/types";
import { ensurePageLayout, pruneUnusedDocumentOverlayAssets, type SigmaDocument } from "@/features/document";

import type { BrowserStoreTransaction } from "./store-backend";

const tWorkspace = createCurrentLocaleTranslator("workspace");

export const LIBRARY_RECORD_KEY = "library";
export const WORKSPACE_STATE_KEY = "state";

/** IndexedDB の台帳は 1 レコード。壊れた台帳を指すときの表示名。 */
export const BROWSER_LIBRARY_LABEL = "IndexedDB: sigma-studio/library";

export interface StoredDocumentRecord {
  fileId: string;
  document: SigmaDocument;
  updatedAt: string;
}

/** 台帳がこのアプリの版と合わない。復旧画面へ流すため、通常のエラーと区別する。 */
export class BrowserLedgerSchemaError extends Error {
  readonly failure: LedgerSchemaFailure;

  constructor(failure: LedgerSchemaFailure) {
    super(BROWSER_LIBRARY_LABEL);
    this.name = "BrowserLedgerSchemaError";
    this.failure = failure;
  }
}

export function describeLedgerFailure(reason: LedgerFailureReason): string {
  switch (reason) {
    case "workspace-not-found":
      return tWorkspace("error.workspaceMissing");
    case "folder-not-found":
      return tWorkspace("error.folderMissing");
    case "file-not-found":
      return tWorkspace("error.materialMissing");
    case "last-workspace":
      return tWorkspace("error.lastWorkspace");
    case "non-empty-folder":
      return tWorkspace("error.nonEmptyFolder");
    case "invalid-folder-move":
      return tWorkspace("error.invalidFolderMove");
    case "no-visible-files":
      return tWorkspace("error.noSavedMaterials");
  }
}

export function describeStorageError(error: unknown, fallback: string): string {
  if (isQuotaExceeded(error)) {
    return tWorkspace("error.saveQuotaExceeded");
  }
  return error instanceof Error ? error.message : fallback;
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === "QuotaExceededError" || error.code === 22);
}

/**
 * 台帳を読む。無ければ空の台帳を作る。版が合わない / 禁止フィールドが混ざっている
 * 場合は復旧画面へ回すため `BrowserLedgerSchemaError` を投げる。
 */
export async function readLibrary(tx: BrowserStoreTransaction): Promise<LibraryRecord> {
  const stored = await tx.get<LibraryRecord>("library", LIBRARY_RECORD_KEY);
  if (!stored) {
    return createEmptyLibrary();
  }

  const violations = findLedgerSchemaViolations(stored as unknown as Record<string, unknown>);
  if (violations.length > 0) {
    throw new BrowserLedgerSchemaError({
      libraryPath: BROWSER_LIBRARY_LABEL,
      expectedVersion: LIBRARY_VERSION,
      actualVersion: stored.version,
      violations,
    });
  }

  return {
    ...stored,
    workspaces: [...stored.workspaces],
    folders: [...stored.folders],
    files: [...stored.files],
  };
}

export async function writeLibrary(tx: BrowserStoreTransaction, library: LibraryRecord): Promise<void> {
  await tx.put("library", LIBRARY_RECORD_KEY, library);
}

/**
 * 起動時の自己修復。デスクトップ版 `ensureLibrary` と同じ 3 手当てをする:
 * 可視ワークスペースの確保、迷子になった教材行の付け替え、アクティブ指定の付け直し。
 */
export function repairLibrary(library: LibraryRecord, now: string): boolean {
  let changed = ensureDefaultWorkspace(library, {
    now,
    defaultName: tWorkspace("defaultWorkspaceName"),
    createId: () => createId("workspace"),
  });
  changed = rehomeOrphanFileRows(library) || changed;
  changed = ensureActiveWorkspace(library) || changed;
  return changed;
}

/**
 * タブ状態を可視な教材だけに詰め直して保存する。デスクトップ版の
 * `saveWorkspaceWithLibrary` と同じく、アクティブ教材のワークスペースへ
 * `activeWorkspaceId` も追従させる。
 */
export async function writeWorkspaceState(
  tx: BrowserStoreTransaction,
  library: LibraryRecord,
  state: { openFileIds: string[]; activeFileId: string },
): Promise<{ openFileIds: string[]; activeFileId: string } | null> {
  const resolved = resolveWorkspaceState(library, state);
  if (!resolved.ok) {
    return null;
  }
  const activeFile = findVisibleFile(library, resolved.value.activeFileId);
  if (activeFile && library.activeWorkspaceId !== activeFile.workspaceId) {
    library.activeWorkspaceId = activeFile.workspaceId;
    await writeLibrary(tx, library);
  }
  await tx.put("workspaceState", WORKSPACE_STATE_KEY, resolved.value);
  return resolved.value;
}

export interface CreateFileResult {
  fileId: string;
  document: SigmaDocument;
  metadata: DocumentMetadata;
}

/**
 * 教材 1 件を作る。台帳行と本文を同じトランザクションで書くので、デスクトップ版が
 * 書き込み順序で守っている「行だけ / 本文だけ」が原理的に起きない。
 */
export async function createFileFromDocument(
  tx: BrowserStoreTransaction,
  library: LibraryRecord,
  input: {
    document: SigmaDocument;
    workspaceId?: string | null;
    folderId?: string | null;
    now: string;
  },
): Promise<CreateFileResult> {
  repairLibrary(library, input.now);
  const workspace = resolveWorkspace(library, input.workspaceId ?? null);
  if (!workspace.ok) {
    throw new Error(describeLedgerFailure(workspace.reason));
  }
  const folderId = resolveFolderId(library, workspace.value.id, input.folderId ?? null);
  if (!folderId.ok) {
    throw new Error(describeLedgerFailure(folderId.reason));
  }

  // 作成/取り込みは頻度が低く、外から来たJSONが入り得る唯一の入口なのでここだけ検証する
  // (自動保存の経路は検証しない。教材 1 件あたり数 ms を毎回払うことになるため)。
  const document = pruneUnusedDocumentOverlayAssets(ensurePageLayout(parseSigmaDocument({
    ...input.document,
    updatedAt: input.document.updatedAt ?? input.now,
  })));
  const requestedTitle = resolveDocumentTitle(document);
  const title = availableDocumentTitle(requestedTitle, library.files, { workspaceId: workspace.value.id, folderId: folderId.value });
  if (title !== requestedTitle) document.metadata = { ...document.metadata, title };
  const row = appendFileRow(library, {
    fileId: createId("file"),
    workspaceId: workspace.value.id,
    folderId: folderId.value,
    docId: document.docId,
    title,
    now: input.now,
    updatedAt: document.updatedAt ?? input.now,
  });

  await tx.put("documents", row.fileId, {
    fileId: row.fileId,
    document,
    updatedAt: row.updatedAt,
  } satisfies StoredDocumentRecord);
  await writeLibrary(tx, library);
  await writeWorkspaceState(tx, library, { openFileIds: [row.fileId], activeFileId: row.fileId });

  return { fileId: row.fileId, document, metadata: toDocumentMetadata(row) };
}

export function createInitialDocument(): SigmaDocument {
  return {
    ...ensurePageLayout(createBlankDocument()),
    docId: createId("doc"),
    updatedAt: new Date().toISOString(),
  };
}

export function blankDocumentWithTitle(title: string | undefined): SigmaDocument {
  return createBlankDocument(normalizeDocumentTitle(title, tWorkspace("untitledMaterial")));
}

export function duplicateTitle(source: SigmaDocument): string {
  return tWorkspace("duplicatedTitle", {
    title: resolveDocumentTitle(source, DEFAULT_DOCUMENT_TITLE),
  });
}

/** 保存済みの本文を、読み込み失敗の分類つきで取り出す。 */
export function loadStoredDocument(
  record: StoredDocumentRecord | undefined,
  revision: number,
  title: string,
): DocumentLoadResult {
  if (!record) {
    return { ok: false, error: tWorkspace("error.materialMissing"), failureKind: "missing", title };
  }
  const recovered = recoverSigmaDocument(record.document);
  if (!recovered.ok) {
    return { ...recovered, failureKind: "schema", title };
  }
  return {
    ok: true,
    document: ensurePageLayout(recovered.document),
    revision,
    recoveryIssues: recovered.issues,
  };
}
