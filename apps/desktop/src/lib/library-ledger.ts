import { LIBRARY_VERSION } from "@/lib/library-schema";
import type {
  DocumentMetadata,
  WorkspaceOverview,
  WorkspaceState,
} from "@/lib/runtime/types";

/**
 * 教材台帳 (library.json 相当) の行と、行に対する純粋な操作。
 *
 * **なぜ renderer 側に純モジュールとして置くのか。** デスクトップ版の台帳は
 * `electron/local-sigma-doc-store.ts` が Node の fs・プロセス間ロック・watcher と
 * 一体で持っている。ブラウザ版は同じ意味論を IndexedDB のトランザクション上で
 * 再現する必要があるが、fs 前提のコードはそのまま持ち込めない。そこで「行をどう
 * 動かすか」だけをここへ純関数として切り出し、保管層 (fs / IndexedDB) から独立させる。
 * `library-schema.ts` と同じ置き場・同じ「main と renderer の両方が読める」作法。
 *
 * 規約:
 * - I/O を持たない。現在時刻も `now` として受け取る (テストで固定できるようにする)。
 * - 文言を持たない。失敗は `LedgerFailureReason` で返し、呼び出し側が i18n で文にする。
 * - 引数の `LibraryRecord` はその場で書き換える。呼び出し側が 1 トランザクション分の
 *   コピーを所有している前提 (デスクトップ版の `withLedger` と同じ形)。
 */

export interface LibraryWorkspaceRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LibraryFolderRow {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LibraryFileRow {
  fileId: string;
  workspaceId: string;
  folderId: string | null;
  docId: string;
  title: string;
  documentPath?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LibraryRecord {
  version: number;
  activeWorkspaceId: string;
  workspaces: LibraryWorkspaceRow[];
  folders: LibraryFolderRow[];
  files: LibraryFileRow[];
  /** 復元できない行の退避先。中身は解釈せず、書き戻しでそのまま素通りさせる。 */
  quarantine?: unknown[];
}

export type LedgerFailureReason =
  | "workspace-not-found"
  | "folder-not-found"
  | "file-not-found"
  | "last-workspace"
  | "non-empty-folder"
  | "invalid-folder-move"
  | "no-visible-files";

export type LedgerOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: LedgerFailureReason };

const WORKSPACE_NAME_MAX_LENGTH = 120;
const FOLDER_NAME_MAX_LENGTH = 160;
const DOCUMENT_TITLE_MAX_LENGTH = 160;

function ok<T>(value: T): LedgerOutcome<T> {
  return { ok: true, value };
}

function fail<T>(reason: LedgerFailureReason): LedgerOutcome<T> {
  return { ok: false, reason };
}

export function createEmptyLibrary(): LibraryRecord {
  return {
    version: LIBRARY_VERSION,
    activeWorkspaceId: "",
    workspaces: [],
    folders: [],
    files: [],
  };
}

export function normalizeWorkspaceName(name: string, fallback: string): string {
  return (name.trim() || fallback).slice(0, WORKSPACE_NAME_MAX_LENGTH);
}

export function normalizeFolderName(name: string, fallback: string): string {
  return (name.trim() || fallback).slice(0, FOLDER_NAME_MAX_LENGTH);
}

export function normalizeDocumentTitle(title: string | undefined, fallback: string): string {
  return ((title ?? "").trim() || fallback).slice(0, DOCUMENT_TITLE_MAX_LENGTH);
}

/** Names are unique among visible sibling files; moving between folders does not rename them. */
export function availableDocumentTitle(
  title: string,
  files: readonly { fileId: string; workspaceId: string; folderId?: string | null; title: string; deletedAt?: string | null }[],
  location: { workspaceId: string; folderId?: string | null; excludeFileId?: string },
): string {
  const names = new Set(files.filter((file) => !file.deletedAt
    && file.fileId !== location.excludeFileId
    && file.workspaceId === location.workspaceId
    && (file.folderId ?? null) === (location.folderId ?? null)).map((file) => file.title.trim()));
  const requested = title.trim();
  if (!names.has(requested)) return requested;
  const match = /^(.*) ([1-9]\d*)$/.exec(requested);
  const numbered = match && Number(match[2]) >= 2 && Number.isSafeInteger(Number(match[2])) && Number(match[2]) < Number.MAX_SAFE_INTEGER - files.length
    ? match : null;
  const base = numbered?.[1] ?? requested;
  let number = numbered ? Number(numbered[2]) + 1 : 2;
  while (names.has(`${base} ${number}`)) number += 1;
  return `${base} ${number}`;
}

export function visibleWorkspaces(library: LibraryRecord): LibraryWorkspaceRow[] {
  return library.workspaces.filter((workspace) => !workspace.deletedAt);
}

export function visibleFolders(library: LibraryRecord): LibraryFolderRow[] {
  return library.folders.filter((folder) => !folder.deletedAt);
}

/** 可視性はワークスペース単位で決まる。消えたワークスペースの教材は見せない。 */
export function visibleFiles(library: LibraryRecord): LibraryFileRow[] {
  const workspaceIds = new Set(visibleWorkspaces(library).map((workspace) => workspace.id));
  return library.files.filter((file) => !file.deletedAt && workspaceIds.has(file.workspaceId));
}

export function findVisibleWorkspace(library: LibraryRecord, workspaceId: string): LibraryWorkspaceRow | null {
  return visibleWorkspaces(library).find((workspace) => workspace.id === workspaceId) ?? null;
}

export function findVisibleFolder(
  library: LibraryRecord,
  workspaceId: string,
  folderId: string,
): LibraryFolderRow | null {
  return visibleFolders(library)
    .find((folder) => folder.workspaceId === workspaceId && folder.id === folderId) ?? null;
}

export function findVisibleFile(library: LibraryRecord, fileId: string): LibraryFileRow | null {
  return visibleFiles(library).find((file) => file.fileId === fileId) ?? null;
}

function preferredWorkspace(library: LibraryRecord): LibraryWorkspaceRow | null {
  return visibleWorkspaces(library)[0] ?? null;
}

function replaceWorkspace(library: LibraryRecord, next: LibraryWorkspaceRow): void {
  library.workspaces = library.workspaces.map((workspace) => workspace.id === next.id ? next : workspace);
}

function replaceFolder(library: LibraryRecord, next: LibraryFolderRow): void {
  library.folders = library.folders.map((folder) => folder.id === next.id ? next : folder);
}

function replaceFile(library: LibraryRecord, next: LibraryFileRow): void {
  library.files = library.files.map((file) => file.fileId === next.fileId ? next : file);
}

export function touchWorkspace(library: LibraryRecord, workspaceId: string, now: string): void {
  const workspace = findVisibleWorkspace(library, workspaceId);
  if (workspace) {
    replaceWorkspace(library, { ...workspace, updatedAt: now });
  }
}

export function resolveWorkspace(
  library: LibraryRecord,
  workspaceId?: string | null,
): LedgerOutcome<LibraryWorkspaceRow> {
  // 明示指定が見つからない場合は既定へ落とさない。削除済みIDを渡された時に
  // 別のワークスペースを黙って操作しないため。
  if (workspaceId) {
    const workspace = findVisibleWorkspace(library, workspaceId);
    return workspace ? ok(workspace) : fail("workspace-not-found");
  }
  const workspace = findVisibleWorkspace(library, library.activeWorkspaceId) ?? preferredWorkspace(library);
  return workspace ? ok(workspace) : fail("workspace-not-found");
}

export function resolveFolderId(
  library: LibraryRecord,
  workspaceId: string,
  folderId?: string | null,
): LedgerOutcome<string | null> {
  const normalized = folderId?.trim() || null;
  if (!normalized) {
    return ok(null);
  }
  const folder = findVisibleFolder(library, workspaceId, normalized);
  return folder ? ok(folder.id) : fail("folder-not-found");
}

function isFolderDescendant(
  library: LibraryRecord,
  workspaceId: string,
  candidateFolderId: string,
  ancestorFolderId: string,
): boolean {
  let cursor = findVisibleFolder(library, workspaceId, candidateFolderId);
  while (cursor) {
    if (cursor.id === ancestorFolderId) {
      return true;
    }
    cursor = cursor.parentFolderId
      ? findVisibleFolder(library, workspaceId, cursor.parentFolderId)
      : null;
  }
  return false;
}

export function toDocumentMetadata(file: LibraryFileRow): DocumentMetadata {
  return {
    fileId: file.fileId,
    workspaceId: file.workspaceId,
    folderId: file.folderId,
    docId: file.docId,
    title: file.title,
    documentPath: file.documentPath,
    revision: file.revision,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

export function listFileMetadata(library: LibraryRecord): DocumentMetadata[] {
  return visibleFiles(library)
    .map(toDocumentMetadata)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function buildWorkspaceOverview(library: LibraryRecord, workspaceId: string): WorkspaceOverview {
  const files = visibleFiles(library).filter((file) => file.workspaceId === workspaceId);
  const folders = visibleFolders(library).filter((folder) => folder.workspaceId === workspaceId);
  const fileCountByFolderId = new Map<string, number>();
  for (const file of files) {
    if (!file.folderId) {
      continue;
    }
    fileCountByFolderId.set(file.folderId, (fileCountByFolderId.get(file.folderId) ?? 0) + 1);
  }

  return {
    activeWorkspaceId: workspaceId,
    workspaces: visibleWorkspaces(library).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })),
    folders: folders.map((folder) => ({
      id: folder.id,
      workspaceId: folder.workspaceId,
      parentFolderId: folder.parentFolderId,
      name: folder.name,
      fileCount: fileCountByFolderId.get(folder.id) ?? 0,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    })),
    files: files.map(toDocumentMetadata),
  };
}

/**
 * 論理削除されたワークスペースのうち最後に更新されたものを、同時刻に消えた教材ごと
 * 復元する。ユーザーが個別に消した教材まで巻き添えで戻さないための同時刻条件。
 */
function restoreMostRecentDeletedWorkspace(
  library: LibraryRecord,
  now: string,
): LibraryWorkspaceRow | null {
  const candidate = library.workspaces
    .filter((workspace) => workspace.deletedAt)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  if (!candidate) {
    return null;
  }

  const restored: LibraryWorkspaceRow = { ...candidate, deletedAt: null, updatedAt: now };
  replaceWorkspace(library, restored);
  library.files = library.files.map((file) =>
    file.workspaceId === candidate.id && file.deletedAt === candidate.deletedAt
      ? { ...file, deletedAt: null, updatedAt: now }
      : file);
  return restored;
}

/**
 * 可視ワークスペースが 1 つも無い時だけ呼ぶ。削除済みがあれば復元し、無ければ新設する。
 * 変更したら true。
 */
export function ensureDefaultWorkspace(
  library: LibraryRecord,
  input: { now: string; defaultName: string; createId: () => string },
): boolean {
  if (visibleWorkspaces(library).length > 0) {
    return false;
  }
  const restored = restoreMostRecentDeletedWorkspace(library, input.now);
  const workspace = restored ?? mintWorkspace(library, input);
  library.activeWorkspaceId = workspace.id;
  return true;
}

function mintWorkspace(
  library: LibraryRecord,
  input: { now: string; defaultName: string; createId: () => string },
): LibraryWorkspaceRow {
  const workspace: LibraryWorkspaceRow = {
    id: input.createId(),
    name: input.defaultName,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
  };
  library.workspaces.push(workspace);
  return workspace;
}

/**
 * どのワークスペース行とも結びつかない教材行は、可視判定から漏れて画面のどこにも
 * 出てこない (静かな消失)。優先ワークスペースへ付け替えて見えるようにする。
 */
export function rehomeOrphanFileRows(library: LibraryRecord): boolean {
  const workspaceIds = new Set(library.workspaces.map((workspace) => workspace.id));
  const preferred = preferredWorkspace(library);
  if (!preferred) {
    return false;
  }
  let changed = false;
  library.files = library.files.map((file) => {
    if (workspaceIds.has(file.workspaceId)) {
      return file;
    }
    changed = true;
    return { ...file, workspaceId: preferred.id };
  });
  return changed;
}

/** activeWorkspaceId が可視ワークスペースを指していなければ付け直す。変更したら true。 */
export function ensureActiveWorkspace(library: LibraryRecord): boolean {
  if (findVisibleWorkspace(library, library.activeWorkspaceId)) {
    return false;
  }
  const next = preferredWorkspace(library);
  if (!next) {
    return false;
  }
  library.activeWorkspaceId = next.id;
  return true;
}

export function createWorkspaceRow(
  library: LibraryRecord,
  input: { id: string; name: string; now: string },
): LibraryWorkspaceRow {
  const workspace: LibraryWorkspaceRow = {
    id: input.id,
    name: input.name,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
  };
  library.workspaces.push(workspace);
  library.activeWorkspaceId = workspace.id;
  return workspace;
}

export function renameWorkspaceRow(
  library: LibraryRecord,
  workspaceId: string,
  name: string,
  now: string,
): LedgerOutcome<LibraryWorkspaceRow> {
  const workspace = findVisibleWorkspace(library, workspaceId);
  if (!workspace) {
    return fail("workspace-not-found");
  }
  const next = { ...workspace, name, updatedAt: now };
  replaceWorkspace(library, next);
  return ok(next);
}

/** ワークスペースを配下のフォルダ・教材ごと論理削除する。最後の 1 つは消さない。 */
export function deleteWorkspaceRow(
  library: LibraryRecord,
  workspaceId: string,
  now: string,
): LedgerOutcome<{ nextActiveWorkspaceId: string }> {
  const workspace = findVisibleWorkspace(library, workspaceId);
  if (!workspace) {
    return fail("workspace-not-found");
  }
  if (visibleWorkspaces(library).filter((item) => item.id !== workspaceId).length === 0) {
    return fail("last-workspace");
  }

  library.folders = library.folders.map((folder) =>
    folder.workspaceId === workspaceId && !folder.deletedAt
      ? { ...folder, deletedAt: now, updatedAt: now }
      : folder);
  library.files = library.files.map((file) =>
    file.workspaceId === workspaceId && !file.deletedAt
      ? { ...file, deletedAt: now, updatedAt: now }
      : file);
  replaceWorkspace(library, { ...workspace, deletedAt: now, updatedAt: now });
  library.activeWorkspaceId = preferredWorkspace(library)?.id ?? "";
  return ok({ nextActiveWorkspaceId: library.activeWorkspaceId });
}

export function createFolderRow(
  library: LibraryRecord,
  input: {
    id: string;
    workspaceId: string;
    name: string;
    parentFolderId?: string | null;
    now: string;
  },
): LedgerOutcome<LibraryFolderRow> {
  const workspace = resolveWorkspace(library, input.workspaceId);
  if (!workspace.ok) {
    return workspace;
  }
  const parentFolderId = resolveFolderId(library, workspace.value.id, input.parentFolderId ?? null);
  if (!parentFolderId.ok) {
    return parentFolderId;
  }

  const folder: LibraryFolderRow = {
    id: input.id,
    workspaceId: workspace.value.id,
    parentFolderId: parentFolderId.value,
    name: input.name,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
  };
  library.folders.push(folder);
  touchWorkspace(library, workspace.value.id, input.now);
  return ok(folder);
}

export function updateFolderRow(
  library: LibraryRecord,
  workspaceId: string,
  folderId: string,
  patch: { name?: string; parentFolderId?: string | null },
  now: string,
): LedgerOutcome<LibraryFolderRow> {
  const workspace = resolveWorkspace(library, workspaceId);
  if (!workspace.ok) {
    return workspace;
  }
  const folder = findVisibleFolder(library, workspace.value.id, folderId);
  if (!folder) {
    return fail("folder-not-found");
  }

  let parentFolderId = folder.parentFolderId;
  if (patch.parentFolderId !== undefined) {
    const resolved = resolveFolderId(library, workspace.value.id, patch.parentFolderId);
    if (!resolved.ok) {
      return resolved;
    }
    parentFolderId = resolved.value;
  }
  if (parentFolderId && isFolderDescendant(library, workspace.value.id, parentFolderId, folder.id)) {
    return fail("invalid-folder-move");
  }

  const next: LibraryFolderRow = {
    ...folder,
    name: patch.name === undefined ? folder.name : patch.name,
    parentFolderId,
    updatedAt: now,
  };
  replaceFolder(library, next);
  touchWorkspace(library, workspace.value.id, now);
  return ok(next);
}

export function deleteFolderRow(
  library: LibraryRecord,
  workspaceId: string,
  folderId: string,
  now: string,
): LedgerOutcome<LibraryFolderRow> {
  const workspace = resolveWorkspace(library, workspaceId);
  if (!workspace.ok) {
    return workspace;
  }
  const folder = findVisibleFolder(library, workspace.value.id, folderId);
  if (!folder) {
    return fail("folder-not-found");
  }
  const hasChildFolder = library.folders.some((item) =>
    item.workspaceId === workspace.value.id && item.parentFolderId === folderId && !item.deletedAt);
  const hasFile = library.files.some((item) =>
    item.workspaceId === workspace.value.id && item.folderId === folderId && !item.deletedAt);
  if (hasChildFolder || hasFile) {
    return fail("non-empty-folder");
  }

  const next = { ...folder, deletedAt: now, updatedAt: now };
  replaceFolder(library, next);
  touchWorkspace(library, workspace.value.id, now);
  return ok(next);
}

export function moveFileToFolderRow(
  library: LibraryRecord,
  workspaceId: string,
  fileId: string,
  folderId: string | null | undefined,
  now: string,
): LedgerOutcome<LibraryFileRow> {
  const workspace = resolveWorkspace(library, workspaceId);
  if (!workspace.ok) {
    return workspace;
  }
  const file = findVisibleFile(library, fileId);
  if (!file || file.workspaceId !== workspace.value.id) {
    return fail("file-not-found");
  }
  const targetFolderId = resolveFolderId(library, workspace.value.id, folderId ?? null);
  if (!targetFolderId.ok) {
    return targetFolderId;
  }

  const next = { ...file, folderId: targetFolderId.value, updatedAt: now };
  replaceFile(library, next);
  touchWorkspace(library, workspace.value.id, now);
  return ok(next);
}

export function moveFileToWorkspaceRow(
  library: LibraryRecord,
  fileId: string,
  targetWorkspaceId: string,
  folderId: string | null | undefined,
  now: string,
): LedgerOutcome<LibraryFileRow> {
  const file = findVisibleFile(library, fileId);
  if (!file) {
    return fail("file-not-found");
  }
  const targetWorkspace = resolveWorkspace(library, targetWorkspaceId);
  if (!targetWorkspace.ok) {
    return targetWorkspace;
  }
  const targetFolderId = resolveFolderId(library, targetWorkspace.value.id, folderId ?? null);
  if (!targetFolderId.ok) {
    return targetFolderId;
  }

  const next = {
    ...file,
    workspaceId: targetWorkspace.value.id,
    folderId: targetFolderId.value,
    updatedAt: now,
  };
  replaceFile(library, next);
  touchWorkspace(library, file.workspaceId, now);
  touchWorkspace(library, targetWorkspace.value.id, now);
  library.activeWorkspaceId = targetWorkspace.value.id;
  return ok(next);
}

export function appendFileRow(
  library: LibraryRecord,
  input: {
    fileId: string;
    workspaceId: string;
    folderId: string | null;
    docId: string;
    title: string;
    now: string;
    updatedAt?: string;
  },
): LibraryFileRow {
  const timestamp = input.updatedAt ?? input.now;
  const file: LibraryFileRow = {
    fileId: input.fileId,
    workspaceId: input.workspaceId,
    folderId: input.folderId,
    docId: input.docId,
    title: input.title,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  library.files.push(file);
  touchWorkspace(library, input.workspaceId, input.now);
  return file;
}

export type DocumentSaveOutcome =
  | { ok: true; file: LibraryFileRow }
  | { ok: false; reason: "file-not-found" }
  | { ok: false; reason: "revision-mismatch"; currentRevision: number };

/** 楽観ロック。observed した revision と台帳の revision が一致した時だけ 1 進める。 */
export function applyDocumentSave(
  library: LibraryRecord,
  fileId: string,
  input: { expectedRevision: number; docId: string; title: string; updatedAt: string; now: string },
): DocumentSaveOutcome {
  const file = findVisibleFile(library, fileId);
  if (!file) {
    return { ok: false, reason: "file-not-found" };
  }
  if (file.revision !== input.expectedRevision) {
    return { ok: false, reason: "revision-mismatch", currentRevision: file.revision };
  }

  const next: LibraryFileRow = {
    ...file,
    docId: input.docId,
    title: input.title,
    revision: Math.max(0, file.revision) + 1,
    updatedAt: input.updatedAt,
  };
  replaceFile(library, next);
  touchWorkspace(library, next.workspaceId, input.now);
  return { ok: true, file: next };
}

export function softDeleteFileRow(
  library: LibraryRecord,
  fileId: string,
  now: string,
): LedgerOutcome<LibraryFileRow> {
  const file = findVisibleFile(library, fileId);
  if (!file) {
    return fail("file-not-found");
  }
  const next = { ...file, deletedAt: now, updatedAt: now };
  replaceFile(library, next);
  touchWorkspace(library, file.workspaceId, now);
  return ok(next);
}

/**
 * 保存済みのタブ状態を、いま可視な教材だけに詰め直す。開いていた教材が消えていれば
 * アクティブなワークスペースの先頭教材へ寄せる。
 */
export function resolveWorkspaceState(
  library: LibraryRecord,
  stored: Partial<WorkspaceState> | null,
): LedgerOutcome<WorkspaceState> {
  const files = visibleFiles(library);
  const visibleFileIds = new Set(files.map((file) => file.fileId));
  const fallbackFileId = files.find((file) => file.workspaceId === library.activeWorkspaceId)?.fileId
    ?? files[0]?.fileId;

  const activeFileId = stored?.activeFileId && visibleFileIds.has(stored.activeFileId)
    ? stored.activeFileId
    : fallbackFileId;
  if (!activeFileId) {
    return fail("no-visible-files");
  }

  const openFileIds = Array.from(new Set([
    ...(stored?.openFileIds ?? []).filter((fileId) => visibleFileIds.has(fileId)),
    activeFileId,
  ]));
  return ok({ openFileIds, activeFileId });
}
