import { DEFAULT_DOCUMENT_TITLE } from "@/lib/document-title";
import type {
  LibraryFileRow as LocalFileRecord,
  LibraryFolderRow as LocalFolderRecord,
  LibraryRecord,
  LibraryWorkspaceRow as LocalWorkspaceRecord,
} from "@/lib/library-ledger";
import {
  findLedgerSchemaViolations,
  LIBRARY_VERSION,
  type LedgerSchemaViolation,
} from "@/lib/library-schema";
import { isValidDocumentFileId } from "./document-file-id";

/** 台帳の解釈と修復報告だけを担う。読み書き・バックアップ・ログはストアが所有する。 */
export type LocalLibraryRecord = Omit<LibraryRecord, "version"> & { version: typeof LIBRARY_VERSION };

export function createEmptyLibrary(): LocalLibraryRecord {
  return {
    version: LIBRARY_VERSION,
    activeWorkspaceId: "",
    workspaces: [],
    folders: [],
    files: [],
  };
}

function normalizeDeletedAt(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// createdAt/updatedAtが両方欠けている行の日付フォールバック。意図的に「今」を使わない:
// 修復した行が「今」の日付を持つと、更新日時ソートで台帳内の最新扱いになってしまい、
// 実際には古いデータが目立つ位置に紛れ込む見た目の破損を新たに生む。
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";

type LibraryRowTable = "workspaces" | "folders" | "files";

interface LibraryRowRepair {
  table: LibraryRowTable;
  id: string;
  fields: string[];
}

interface LibraryRowQuarantine {
  table: LibraryRowTable;
  raw: unknown;
}

interface LibraryArrayQuarantine {
  table: LibraryRowTable;
  raw: unknown;
}

export interface LibraryParseOutcome {
  library: LocalLibraryRecord;
  repairs: LibraryRowRepair[];
  quarantinedRows: LibraryRowQuarantine[];
  quarantinedArrays: LibraryArrayQuarantine[];
}

export type LibraryParseResult =
  | { status: "parsed"; outcome: LibraryParseOutcome }
  | { status: "unreadable" }
  | { status: "schema-violation"; violations: LedgerSchemaViolation[] };

type RowParseResult<T> =
  | { status: "parsed"; record: T; repairedFields: string[] }
  | { status: "quarantined"; raw: unknown };

function resolveTimestampPair(
  createdAtRaw: unknown,
  updatedAtRaw: unknown,
): { createdAt: string; updatedAt: string; repairedFields: string[] } {
  const createdAtValid = typeof createdAtRaw === "string" ? createdAtRaw : undefined;
  const updatedAtValid = typeof updatedAtRaw === "string" ? updatedAtRaw : undefined;
  const repairedFields: string[] = [];
  let createdAt = createdAtValid;
  let updatedAt = updatedAtValid;
  if (createdAt === undefined && updatedAt === undefined) {
    createdAt = EPOCH_TIMESTAMP;
    updatedAt = EPOCH_TIMESTAMP;
    repairedFields.push("createdAt", "updatedAt");
  } else if (createdAt === undefined) {
    createdAt = updatedAt;
    repairedFields.push("createdAt");
  } else if (updatedAt === undefined) {
    updatedAt = createdAt;
    repairedFields.push("updatedAt");
  }
  return { createdAt: createdAt as string, updatedAt: updatedAt as string, repairedFields };
}

/**
 * 台帳(library.json)のトップレベルをパースする。**単一行の欠陥で台帳全体を壊さない**
 * ことが目的: 各行パーサーは復元可能なフィールドを補って残し、復元不能な行だけを
 * quarantine (=消さずに未解釈のまま退避) する。JSON自体が壊れている場合と、
 * 現行スキーマへの違反がある場合は、呼び出し側が区別できる結果を返す。
 *
 * 戻り値のrepairs/quarantinedRows/quarantinedArraysは、呼び出し側 (readLibraryFileWithReport)
 * が台帳ログへ記録するための報告であり、ここでのログ書き込みという副作用は持たせない
 * (ログ書き込みの失敗がパース自体を巻き込んで壊してはならないため)。
 */
export function parseLibrary(raw: string): LibraryParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  if (!isPlainObject(value)) {
    return { status: "unreadable" };
  }
  const violations = findLedgerSchemaViolations(value);
  if (violations.length > 0) {
    return { status: "schema-violation", violations };
  }

  const repairs: LibraryRowRepair[] = [];
  const quarantinedRows: LibraryRowQuarantine[] = [];
  const quarantinedArrays: LibraryArrayQuarantine[] = [];

  function collectArray<T>(
    table: LibraryRowTable,
    rawArray: unknown,
    parseRow: (item: unknown) => RowParseResult<T>,
    idOf: (record: T) => string,
  ): T[] {
    if (rawArray === undefined) {
      return [];
    }
    if (!Array.isArray(rawArray)) {
      quarantinedArrays.push({ table, raw: rawArray });
      return [];
    }
    const records: T[] = [];
    for (const item of rawArray) {
      const result = parseRow(item);
      if (result.status === "quarantined") {
        quarantinedRows.push({ table, raw: result.raw });
        continue;
      }
      if (result.repairedFields.length > 0) {
        repairs.push({ table, id: idOf(result.record), fields: result.repairedFields });
      }
      records.push(result.record);
    }
    return records;
  }

  const workspaces = collectArray("workspaces", value.workspaces, parseWorkspaceRecord, (record) => record.id);
  const folders = collectArray("folders", value.folders, parseFolderRecord, (record) => record.id);
  const files = collectArray(
    "files",
    value.files,
    parseFileRecord,
    (record) => record.fileId,
  );

  const activeWorkspaceId = typeof value.activeWorkspaceId === "string" ? value.activeWorkspaceId : "";

  const priorQuarantine = Array.isArray(value.quarantine) ? value.quarantine : [];
  const quarantine = [
    ...priorQuarantine,
    ...quarantinedRows.map((entry) => entry.raw),
    ...quarantinedArrays.map((entry) => entry.raw),
  ];

  const library: LocalLibraryRecord = {
    version: LIBRARY_VERSION,
    activeWorkspaceId,
    workspaces,
    folders,
    files,
    ...(quarantine.length > 0 ? { quarantine } : {}),
  };

  return {
    status: "parsed",
    outcome: { library, repairs, quarantinedRows, quarantinedArrays },
  };
}

function parseWorkspaceRecord(value: unknown): RowParseResult<LocalWorkspaceRecord> {
  // idはワークスペースの唯一の一意性の根拠なので、これだけは復元しようがない。
  if (!isPlainObject(value) || typeof value.id !== "string") {
    return { status: "quarantined", raw: value };
  }
  const repairedFields: string[] = [];

  if (typeof value.name !== "string") {
    repairedFields.push("name");
  }
  const name = normalizeWorkspaceName(typeof value.name === "string" ? value.name : "");

  const { createdAt, updatedAt, repairedFields: timestampFields } = resolveTimestampPair(value.createdAt, value.updatedAt);
  repairedFields.push(...timestampFields);

  if (!isNullableString(value.deletedAt)) {
    repairedFields.push("deletedAt");
  }
  const deletedAt = normalizeDeletedAt(isNullableString(value.deletedAt) ? value.deletedAt : undefined);

  const validatedFields = {
    id: value.id,
    name,
    createdAt,
    updatedAt,
    deletedAt,
  };
  // 未知キー(将来のビルドが書いたフィールド等)をvalueから引き継ぎ、検証済みフィールドで
  // 上書きする。これにより「知らないキーは黙って消える」という第2の静かな損失経路を塞ぐ。
  const record = { ...value, ...validatedFields } as LocalWorkspaceRecord;

  return { status: "parsed", record, repairedFields };
}

function parseFolderRecord(value: unknown): RowParseResult<LocalFolderRecord> {
  // フォルダはユーザーコンテンツを保持せず、所属ファイルは復元不能時にルートへ倒れるだけ
  // なので、id/workspaceId以外は安全に修復できる。
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.workspaceId !== "string") {
    return { status: "quarantined", raw: value };
  }
  const repairedFields: string[] = [];

  let parentFolderId: string | null;
  if (isNullableString(value.parentFolderId)) {
    parentFolderId = value.parentFolderId;
  } else {
    parentFolderId = null;
    repairedFields.push("parentFolderId");
  }

  if (typeof value.name !== "string") {
    repairedFields.push("name");
  }
  const name = normalizeFolderName(typeof value.name === "string" ? value.name : "");

  const { createdAt, updatedAt, repairedFields: timestampFields } = resolveTimestampPair(value.createdAt, value.updatedAt);
  repairedFields.push(...timestampFields);

  let deletedAt: string | null;
  if (isNullableString(value.deletedAt)) {
    deletedAt = normalizeDeletedAt(value.deletedAt);
  } else {
    deletedAt = null;
    repairedFields.push("deletedAt");
  }

  const validatedFields = {
    id: value.id,
    workspaceId: value.workspaceId,
    parentFolderId,
    name,
    createdAt,
    updatedAt,
    deletedAt,
  };
  const record = { ...value, ...validatedFields } as LocalFolderRecord;

  return { status: "parsed", record, repairedFields };
}

function parseFileRecord(value: unknown): RowParseResult<LocalFileRecord> {
  // fileIdからしか本体ファイル名を導けないため、これだけは復元しようがない。
  // それ以外は最悪でも「持ち主不明の教材」まで復元して見せられる。
  if (!isPlainObject(value) || typeof value.fileId !== "string" || !isValidDocumentFileId(value.fileId)) {
    return { status: "quarantined", raw: value };
  }
  const repairedFields: string[] = [];

  let workspaceId: string;
  if (typeof value.workspaceId === "string") {
    workspaceId = value.workspaceId;
  } else {
    workspaceId = "";
    repairedFields.push("workspaceId");
  }

  let folderId: string | null;
  if (isNullableString(value.folderId)) {
    folderId = value.folderId;
  } else {
    folderId = null;
    repairedFields.push("folderId");
  }

  let docId: string;
  if (typeof value.docId === "string") {
    docId = value.docId;
  } else {
    docId = "";
    repairedFields.push("docId");
  }

  let title: string;
  if (typeof value.title === "string") {
    title = value.title;
  } else {
    title = DEFAULT_DOCUMENT_TITLE;
    repairedFields.push("title");
  }

  let documentPath: string | undefined;
  if (value.documentPath === undefined) {
    documentPath = undefined;
  } else if (typeof value.documentPath === "string") {
    documentPath = value.documentPath;
  } else {
    documentPath = undefined;
    repairedFields.push("documentPath");
  }

  let revision: number;
  if (typeof value.revision === "number" && Number.isFinite(value.revision)) {
    revision = value.revision;
  } else {
    revision = 1;
    repairedFields.push("revision");
  }

  const { createdAt, updatedAt, repairedFields: timestampFields } = resolveTimestampPair(value.createdAt, value.updatedAt);
  repairedFields.push(...timestampFields);

  let deletedAt: string | null;
  if (isNullableString(value.deletedAt)) {
    deletedAt = normalizeDeletedAt(value.deletedAt);
  } else {
    deletedAt = null;
    repairedFields.push("deletedAt");
  }

  const validatedFields = {
    fileId: value.fileId,
    workspaceId,
    folderId,
    docId,
    title,
    documentPath,
    revision,
    createdAt,
    updatedAt,
    deletedAt,
  };
  const record = { ...value, ...validatedFields } as LocalFileRecord;

  return { status: "parsed", record, repairedFields };
}

export function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim();
  return (normalized || "マイ教材").slice(0, 120);
}

export function normalizeFolderName(name: string): string {
  const normalized = name.trim();
  return (normalized || "無題のフォルダ").slice(0, 160);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
