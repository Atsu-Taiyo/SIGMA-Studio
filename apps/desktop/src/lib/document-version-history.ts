import type { SigmaDocument } from "@/features/document";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";

export const DOCUMENT_VERSION_CAPTURE_INTERVAL_MS = 10 * 60 * 1_000;
export const MAX_DOCUMENT_VERSIONS = 200;

export type DocumentVersionOrigin = "user" | "ai" | "restore-backup" | "tab-switch" | "app-close";

export interface DocumentVersionMetadata {
  versionId: string;
  revision: number;
  capturedAt: string;
  origin: DocumentVersionOrigin;
}

export interface DocumentVersion extends DocumentVersionMetadata {
  document: SigmaDocument;
}

const DOCUMENT_VERSION_CAPTURED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isValidDocumentVersionCapturedAt(value: unknown): value is string {
  return typeof value === "string"
    && DOCUMENT_VERSION_CAPTURED_AT_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

export type DocumentVersionDateGroupKind = "today" | "yesterday" | "date";

export interface DocumentVersionDateGroup {
  key: string;
  kind: DocumentVersionDateGroupKind;
  date: string;
  versions: DocumentVersionMetadata[];
}

export function shouldCaptureDocumentVersion(input: {
  previousDocument: SigmaDocument | null;
  latestVersionDocument: SigmaDocument | null;
  nextDocument: SigmaDocument;
  latestVersion: DocumentVersionMetadata | null;
  origin: DocumentVersionOrigin;
  nowMs: number;
  intervalMs?: number;
  force?: boolean;
}): boolean {
  if (input.force && input.origin === "restore-backup") {
    return true;
  }
  if (input.origin === "tab-switch" || input.origin === "app-close") {
    return !input.latestVersionDocument
      || !areSigmaDocumentsEquivalent(input.latestVersionDocument, input.nextDocument);
  }
  if (input.previousDocument && areSigmaDocumentsEquivalent(input.previousDocument, input.nextDocument)) {
    return false;
  }
  if (input.force || input.origin === "ai" || input.origin === "restore-backup") {
    return true;
  }
  if (!input.latestVersion) {
    return true;
  }
  const capturedAt = Date.parse(input.latestVersion.capturedAt);
  if (!Number.isFinite(capturedAt)) {
    return true;
  }
  return input.nowMs - capturedAt >= (input.intervalMs ?? DOCUMENT_VERSION_CAPTURE_INTERVAL_MS);
}

export function selectDocumentVersionsToPrune(
  versions: readonly DocumentVersionMetadata[],
  maxVersions = MAX_DOCUMENT_VERSIONS,
): DocumentVersionMetadata[] {
  if (versions.length <= maxVersions) return [];
  return [...versions]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.revision - b.revision)
    .slice(0, versions.length - maxVersions);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function groupDocumentVersionsByDate(
  versions: readonly DocumentVersionMetadata[],
  now = new Date(),
): DocumentVersionDateGroup[] {
  const today = localDateKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = localDateKey(yesterdayDate);
  const groups = new Map<string, DocumentVersionMetadata[]>();
  for (const version of [...versions].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
    const parsed = new Date(version.capturedAt);
    const key = Number.isNaN(parsed.getTime()) ? version.capturedAt.slice(0, 10) : localDateKey(parsed);
    groups.set(key, [...(groups.get(key) ?? []), version]);
  }
  return [...groups].map(([key, grouped]) => ({
    key,
    kind: key === today ? "today" : key === yesterday ? "yesterday" : "date",
    date: key,
    versions: grouped,
  }));
}
