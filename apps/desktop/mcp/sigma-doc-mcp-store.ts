import fs from "node:fs/promises";
import path from "node:path";

import type { LocalDocumentMetadata, LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import type { SigmaDocument } from "@/features/document";
import { incrementMcpStatsCounter } from "./sigma-doc-mcp-stats";

interface ParsedDocumentCacheEntry {
  fileId: string;
  revision: number;
  document: SigmaDocument;
}

interface InFlightDocumentLoad {
  revision: number;
  promise: Promise<{ file: LocalDocumentMetadata; document: SigmaDocument }>;
}

// LocalSigmaDocStore instances can point at different user-data directories in tests or embedded
// hosts, so the physical data directory is part of the process-local key in addition to fileId.
// A cache hit is still gated by the freshly-read library revision on every call.
const PARSED_DOCUMENT_CACHE_LIMIT = 8;
const parsedDocumentCache = new Map<string, ParsedDocumentCacheEntry>();
const inFlightDocumentLoads = new Map<string, InFlightDocumentLoad>();

function documentCacheKey(store: LocalSigmaDocStore, fileId: string): string {
  return `${store.getDataDir()}\u0000${fileId}`;
}

function invalidateDocumentCacheEntry(store: LocalSigmaDocStore, fileId: string): void {
  const key = documentCacheKey(store, fileId);
  parsedDocumentCache.delete(key);
  inFlightDocumentLoads.delete(key);
}

function readDocumentCache(key: string): ParsedDocumentCacheEntry | null {
  const cached = parsedDocumentCache.get(key);
  if (!cached) {
    return null;
  }
  parsedDocumentCache.delete(key);
  parsedDocumentCache.set(key, cached);
  return cached;
}

function writeDocumentCache(key: string, entry: ParsedDocumentCacheEntry): void {
  parsedDocumentCache.delete(key);
  parsedDocumentCache.set(key, entry);
  while (parsedDocumentCache.size > PARSED_DOCUMENT_CACHE_LIMIT) {
    const oldestKey = parsedDocumentCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    parsedDocumentCache.delete(oldestKey);
  }
}

function resolveDocumentPath(store: LocalSigmaDocStore, file: LocalDocumentMetadata): string {
  const relativePath = file.documentPath || path.join("documents", `${encodeURIComponent(file.fileId)}.sigmadoc.json`);
  return path.join(store.getDataDir(), relativePath);
}

async function isDocumentCacheWriteConsistent(
  store: LocalSigmaDocStore,
  file: LocalDocumentMetadata,
): Promise<boolean> {
  try {
    const [documentStat, libraryStat] = await Promise.all([
      fs.stat(resolveDocumentPath(store, file)),
      fs.stat(path.join(store.getDataDir(), "library.json")),
    ]);
    return documentStat.mtimeMs <= libraryStat.mtimeMs;
  } catch {
    // A failed consistency check must not turn a successfully loaded document into a tool error.
    // Return it to this caller, but leave it uncached so the next call re-checks disk metadata.
    return false;
  }
}

export async function getFileMetadata(store: LocalSigmaDocStore, fileId: string): Promise<LocalDocumentMetadata> {
  const files = await store.listFiles();
  const file = files.find((item) => item.fileId === fileId);
  if (!file) {
    invalidateDocumentCacheEntry(store, fileId);
    throw new Error(`教材ファイルが見つかりません: ${fileId}`);
  }
  return file;
}

export async function loadDocumentForFile(
  store: LocalSigmaDocStore,
  fileId: string,
  knownFile?: LocalDocumentMetadata,
): Promise<{
  file: LocalDocumentMetadata;
  document: SigmaDocument;
}> {
  const file = knownFile ?? await getFileMetadata(store, fileId);
  const key = documentCacheKey(store, fileId);
  const cached = readDocumentCache(key);
  if (cached?.revision === file.revision) {
    incrementMcpStatsCounter("documentCacheHits");
    return { file, document: cached.document };
  }

  const inFlight = inFlightDocumentLoads.get(key);
  if (inFlight?.revision === file.revision) {
    incrementMcpStatsCounter("documentCacheHits");
    return inFlight.promise;
  }

  parsedDocumentCache.delete(key);
  incrementMcpStatsCounter("documentCacheMisses");
  const promise = (async () => {
    incrementMcpStatsCounter("documentDiskLoads");
    // LocalSigmaDocStore.loadDocument performs the JSON read and full SigmaDoc Zod parse. Do not
    // parse its already-validated result a second time in the MCP layer.
    incrementMcpStatsCounter("documentParses");
    const rawDocument = await store.loadDocument(fileId);
    if (!rawDocument) {
      throw new Error(`教材を読み込めません: ${fileId}`);
    }
    const document = rawDocument;
    // The document file and library.json are replaced separately. Re-check the revision after the
    // disk read so a save racing this miss cannot cache a newly-written document under its old
    // revision. A changed revision retries against the new metadata instead.
    const verifiedFile = await getFileMetadata(store, fileId);
    if (verifiedFile.revision !== file.revision) {
      return loadDocumentForFile(store, fileId, verifiedFile);
    }
    // saveDocument replaces the document before library.json. During that window the second
    // revision read above is still old even though loadDocument has already returned the new
    // bytes. Only cache after the filesystem timestamps show that the library index is at least
    // as new as the document; stat failures deliberately leave this successful load uncached.
    if (await isDocumentCacheWriteConsistent(store, verifiedFile)) {
      writeDocumentCache(key, { fileId, revision: verifiedFile.revision, document });
    }
    return { file: verifiedFile, document };
  })();
  inFlightDocumentLoads.set(key, { revision: file.revision, promise });
  try {
    return await promise;
  } finally {
    if (inFlightDocumentLoads.get(key)?.promise === promise) {
      inFlightDocumentLoads.delete(key);
    }
  }
}

/** Removes entries for files no longer visible in the current library snapshot. */
export function pruneDocumentLoadCache(store: LocalSigmaDocStore, visibleFileIds: ReadonlySet<string>): void {
  const dataDirPrefix = `${store.getDataDir()}\u0000`;
  for (const [key, entry] of parsedDocumentCache) {
    if (key.startsWith(dataDirPrefix) && !visibleFileIds.has(entry.fileId)) {
      parsedDocumentCache.delete(key);
      inFlightDocumentLoads.delete(key);
    }
  }
}

/** Internal cache reset for focused tests. Runtime invalidation is revision-driven. */
export function resetDocumentLoadCache(): void {
  parsedDocumentCache.clear();
  inFlightDocumentLoads.clear();
}
