import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { SigmaDocument } from "@/features/document";
import {
  MAX_DOCUMENT_VERSIONS,
  isValidDocumentVersionCapturedAt,
  selectDocumentVersionsToPrune,
  type DocumentVersion,
  type DocumentVersionMetadata,
} from "@/lib/document-version-history";
import { acquireFileLock } from "./file-lock";
import { isValidDocumentFileId } from "./document-file-id";

export { isValidDocumentFileId } from "./document-file-id";

export const DOCUMENT_VERSION_INDEX_FILE_NAME = "index.jsonl";
export const DOCUMENT_VERSION_SNAPSHOT_SUFFIX = ".sigmadoc.json";

export class DocumentVersionIndexMalformedError extends Error {
  constructor(indexPath: string, lineNumber: number) {
    super(`Malformed document version index at ${indexPath}:${lineNumber}`);
    this.name = "DocumentVersionIndexMalformedError";
  }
}

export interface DocumentVersionIndexRecovery {
  indexPath: string;
  kind: "truncated-malformed-tail" | "completed-line-terminator";
  discardedBytes: number;
}

export interface DocumentVersionSidecarReadOptions {
  onIndexTailRecovered?: (recovery: DocumentVersionIndexRecovery) => void;
}

function resolveDocumentVersionLockPath(rootDir: string, fileId: string): string {
  return path.join(path.resolve(rootDir), ".locks", `${encodedPathSegment(fileId, "fileId")}.lock`);
}

async function withDocumentVersionLock<T>(
  rootDir: string,
  fileId: string,
  op: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(resolveDocumentVersionLockPath(rootDir, fileId), { op });
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isValidDocumentVersionId(value: string): boolean {
  return /^version_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);
}

function encodedPathSegment(value: string, label: "fileId" | "versionId"): string {
  if (
    value === "."
    || value === ".."
    || !(label === "fileId" ? isValidDocumentFileId(value) : isValidDocumentVersionId(value))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const encoded = encodeURIComponent(value);
  if (encoded.includes("/") || encoded.includes("\\") || decodeURIComponent(encoded) !== value) {
    throw new Error(`Invalid ${label}`);
  }
  return encoded;
}

export function resolveDocumentVersionDirectory(rootDir: string, fileId: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedDirectory = path.resolve(resolvedRoot, encodedPathSegment(fileId, "fileId"));
  if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Invalid fileId");
  }
  return resolvedDirectory;
}

export function resolveDocumentVersionSnapshotPath(rootDir: string, fileId: string, versionId: string): string {
  return path.join(
    resolveDocumentVersionDirectory(rootDir, fileId),
    `${encodedPathSegment(versionId, "versionId")}${DOCUMENT_VERSION_SNAPSHOT_SUFFIX}`,
  );
}

function parseMetadata(line: string): DocumentVersionMetadata | null {
  try {
    const value = JSON.parse(line) as Partial<DocumentVersionMetadata>;
    if (
      typeof value.versionId !== "string"
      || !isValidDocumentVersionId(value.versionId)
      || !Number.isInteger(value.revision)
      || !isValidDocumentVersionCapturedAt(value.capturedAt)
      || !["user", "ai", "restore-backup", "tab-switch", "app-close"].includes(value.origin ?? "")
    ) return null;
    return {
      versionId: value.versionId,
      revision: value.revision,
      capturedAt: value.capturedAt,
      origin: value.origin,
    } as DocumentVersionMetadata;
  } catch {
    return null;
  }
}

async function recoverDocumentVersionIndexTailUnlocked(
  indexPath: string,
  options: DocumentVersionSidecarReadOptions,
): Promise<Buffer> {
  let bytes = await fs.readFile(indexPath);
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return bytes;

  const lastNewline = bytes.lastIndexOf(0x0a);
  const tail = bytes.subarray(lastNewline + 1).toString("utf8");
  if (!parseMetadata(tail)) {
    const keptBytes = lastNewline + 1;
    await fs.truncate(indexPath, keptBytes);
    options.onIndexTailRecovered?.({
      indexPath,
      kind: "truncated-malformed-tail",
      discardedBytes: bytes.length - keptBytes,
    });
    bytes = bytes.subarray(0, keptBytes);
  } else {
    await fs.appendFile(indexPath, "\n", "utf8");
    options.onIndexTailRecovered?.({
      indexPath,
      kind: "completed-line-terminator",
      discardedBytes: 0,
    });
    bytes = Buffer.concat([bytes, Buffer.from("\n")]);
  }
  return bytes;
}

async function recoverDocumentVersionIndexTail(
  rootDir: string,
  fileId: string,
  indexPath: string,
  options: DocumentVersionSidecarReadOptions,
): Promise<Buffer> {
  return withDocumentVersionLock(rootDir, fileId, "recoverDocumentVersionIndexTail", async () => {
    return recoverDocumentVersionIndexTailUnlocked(indexPath, options);
  });
}

export async function readDocumentVersionMetadata(
  rootDir: string,
  fileId: string,
  options: DocumentVersionSidecarReadOptions = {},
): Promise<DocumentVersionMetadata[]> {
  const indexPath = path.join(resolveDocumentVersionDirectory(rootDir, fileId), DOCUMENT_VERSION_INDEX_FILE_NAME);
  try {
    let bytes: Buffer = await fs.readFile(indexPath);
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      bytes = await recoverDocumentVersionIndexTail(rootDir, fileId, indexPath, options);
    }
    const raw = bytes.toString("utf8");
    return raw.split("\n").flatMap((line, index) => {
      if (!line) return [];
      const parsed = parseMetadata(line);
      if (!parsed) throw new DocumentVersionIndexMalformedError(indexPath, index + 1);
      return [parsed];
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

/** 保存判定用に末尾の有効な1行だけを読む。通常保存でindex全体を読まないための経路。 */
export async function readLatestDocumentVersionMetadata(
  rootDir: string,
  fileId: string,
  options: DocumentVersionSidecarReadOptions = {},
): Promise<DocumentVersionMetadata | null> {
  const indexPath = path.join(resolveDocumentVersionDirectory(rootDir, fileId), DOCUMENT_VERSION_INDEX_FILE_NAME);
  try {
    const handle = await fs.open(indexPath, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, 64 * 1024);
      let buffer: Buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      if (stat.size > 0 && buffer[buffer.length - 1] !== 0x0a) {
        const recovered = await recoverDocumentVersionIndexTail(rootDir, fileId, indexPath, options);
        buffer = recovered.subarray(Math.max(0, recovered.length - 64 * 1024));
      }
      const lines = buffer.toString("utf8").split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        const parsed = parseMetadata(line);
        if (parsed) return parsed;
        throw new DocumentVersionIndexMalformedError(indexPath, 0);
      }
      return null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(targetPath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, data, "utf8");
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function appendDocumentVersion(
  rootDir: string,
  fileId: string,
  version: DocumentVersion,
  lineCounts?: Map<string, number>,
  readOptions: DocumentVersionSidecarReadOptions = {},
): Promise<void> {
  await withDocumentVersionLock(rootDir, fileId, "appendDocumentVersion", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, fileId);
    await fs.mkdir(directory, { recursive: true });
    await writeAtomic(
      resolveDocumentVersionSnapshotPath(rootDir, fileId, version.versionId),
      `${JSON.stringify(version.document)}\n`,
    );
    const metadata: DocumentVersionMetadata = {
      versionId: version.versionId,
      revision: version.revision,
      capturedAt: version.capturedAt,
      origin: version.origin,
    };
    const indexPath = path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME);
    try {
      await recoverDocumentVersionIndexTailUnlocked(indexPath, readOptions);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await fs.appendFile(indexPath, `${JSON.stringify(metadata)}\n`, "utf8");
    let count = lineCounts?.get(fileId);
    if (count === undefined) {
      count = (await readDocumentVersionMetadata(rootDir, fileId, readOptions)).length;
    } else {
      count += 1;
    }
    lineCounts?.set(fileId, count);
    if (count <= MAX_DOCUMENT_VERSIONS) return;
    const versions = await readDocumentVersionMetadata(rootDir, fileId, readOptions);
    const pruned = selectDocumentVersionsToPrune(versions, MAX_DOCUMENT_VERSIONS);
    if (pruned.length === 0) return;
    const prunedIds = new Set(pruned.map((entry) => entry.versionId));
    const kept = versions.filter((entry) => !prunedIds.has(entry.versionId));
    await writeAtomic(indexPath, `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await Promise.all(pruned.map((entry) => fs.rm(
      resolveDocumentVersionSnapshotPath(rootDir, fileId, entry.versionId),
      { force: true },
    )));
    lineCounts?.set(fileId, kept.length);
  });
}

export async function readDocumentVersion(
  rootDir: string,
  fileId: string,
  versionId: string,
  options: DocumentVersionSidecarReadOptions = {},
): Promise<DocumentVersion | null> {
  const metadata = (await readDocumentVersionMetadata(rootDir, fileId, options))
    .find((entry) => entry.versionId === versionId);
  if (!metadata) return null;
  try {
    const raw = await fs.readFile(resolveDocumentVersionSnapshotPath(rootDir, fileId, versionId), "utf8");
    return { ...metadata, document: JSON.parse(raw) as SigmaDocument };
  } catch {
    return null;
  }
}

export async function deleteDocumentVersions(rootDir: string, fileId: string): Promise<void> {
  await withDocumentVersionLock(rootDir, fileId, "deleteDocumentVersions", async () => {
    await fs.rm(resolveDocumentVersionDirectory(rootDir, fileId), { recursive: true, force: true });
  });
}
