import { describe, expect, it } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";
import {
  DOCUMENT_VERSION_CAPTURE_INTERVAL_MS,
  groupDocumentVersionsByDate,
  isValidDocumentVersionCapturedAt,
  selectDocumentVersionsToPrune,
  shouldCaptureDocumentVersion,
  type DocumentVersionMetadata,
} from "./document-version-history";

function doc(text: string, updatedAt = "2026-09-01T00:00:00.000Z"): SigmaDocument {
  const document = createBlankDocument("履歴テスト");
  return {
    ...document,
    updatedAt,
    content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text }] }],
  };
}

function meta(index: number, capturedAt: string): DocumentVersionMetadata {
  return {
    versionId: `version_${index}`,
    revision: index,
    capturedAt,
    origin: "user",
  };
}

describe("document version history policy", () => {
  it("accepts ISO capturedAt timestamps and rejects unsafe date strings", () => {
    expect(isValidDocumentVersionCapturedAt("2026-09-01T00:00:00.000Z")).toBe(true);
    expect(isValidDocumentVersionCapturedAt("2026-09-01T09:00:00+09:00")).toBe(true);
    expect(isValidDocumentVersionCapturedAt("not-a-date")).toBe(false);
    expect(isValidDocumentVersionCapturedAt("2026-09-01")).toBe(false);
  });

  it("captures a user save only after ten minutes", () => {
    const previous = doc("before");
    const next = doc("after");
    const latestVersion = meta(1, "2026-09-01T00:00:00.000Z");
    expect(shouldCaptureDocumentVersion({ previousDocument: previous, latestVersionDocument: previous, nextDocument: next, latestVersion, origin: "user", nowMs: Date.parse(latestVersion.capturedAt) + DOCUMENT_VERSION_CAPTURE_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldCaptureDocumentVersion({ previousDocument: previous, latestVersionDocument: previous, nextDocument: next, latestVersion, origin: "user", nowMs: Date.parse(latestVersion.capturedAt) + DOCUMENT_VERSION_CAPTURE_INTERVAL_MS })).toBe(true);
  });

  it("always captures AI and restore backups when content changed", () => {
    const previous = doc("before");
    const next = doc("after");
    const latestVersion = meta(1, "2026-09-01T00:00:00.000Z");
    expect(shouldCaptureDocumentVersion({ previousDocument: previous, latestVersionDocument: previous, nextDocument: next, latestVersion, origin: "ai", nowMs: Date.parse(latestVersion.capturedAt) + 1 })).toBe(true);
    expect(shouldCaptureDocumentVersion({ previousDocument: previous, latestVersionDocument: previous, nextDocument: next, latestVersion, origin: "restore-backup", nowMs: Date.parse(latestVersion.capturedAt) + 1 })).toBe(true);
  });

  it("force-captures a restore backup even when it matches the latest version", () => {
    const current = doc("same");
    expect(shouldCaptureDocumentVersion({ previousDocument: current, latestVersionDocument: current, nextDocument: structuredClone(current), latestVersion: null, origin: "restore-backup", nowMs: Date.now(), force: true })).toBe(true);
  });

  it("does not capture equivalent content even when updatedAt differs", () => {
    const previousDocument = doc("same", "2026-09-01T00:00:00Z");
    const nextDocument = { ...structuredClone(previousDocument), updatedAt: "2026-09-01T01:00:00Z" };
    expect(shouldCaptureDocumentVersion({ previousDocument, latestVersionDocument: previousDocument, nextDocument, latestVersion: null, origin: "ai", nowMs: Date.now() })).toBe(false);
  });

  it("captures boundaries against the latest version rather than the last saved document", () => {
    const latestVersionDocument = doc("version at 12:00");
    const lastSavedDocument = doc("autosaved at 12:01");
    const latestVersion = meta(1, "2026-09-01T12:00:00.000Z");
    expect(shouldCaptureDocumentVersion({
      previousDocument: lastSavedDocument,
      latestVersionDocument,
      nextDocument: structuredClone(lastSavedDocument),
      latestVersion,
      origin: "tab-switch",
      nowMs: Date.parse("2026-09-01T12:01:00.000Z"),
    })).toBe(true);
    expect(shouldCaptureDocumentVersion({
      previousDocument: lastSavedDocument,
      latestVersionDocument: lastSavedDocument,
      nextDocument: { ...structuredClone(lastSavedDocument), updatedAt: "2026-09-01T12:02:00.000Z" },
      latestVersion,
      origin: "app-close",
      nowMs: Date.parse("2026-09-01T12:02:00.000Z"),
    })).toBe(false);
  });

  it("selects only the oldest versions beyond the cap", () => {
    const versions = Array.from({ length: 202 }, (_, index) => meta(index, new Date(index * 1_000).toISOString()));
    expect(selectDocumentVersionsToPrune(versions).map((version) => version.versionId)).toEqual(["version_0", "version_1"]);
  });

  it("groups newest first into today, yesterday, and dates", () => {
    const groups = groupDocumentVersionsByDate([
      meta(1, "2026-08-30T09:00:00+09:00"),
      meta(2, "2026-08-31T09:00:00+09:00"),
      meta(3, "2026-09-01T09:00:00+09:00"),
    ], new Date("2026-09-01T12:00:00+09:00"));
    expect(groups.map((group) => [group.kind, group.date])).toEqual([
      ["today", "2026-09-01"],
      ["yesterday", "2026-08-31"],
      ["date", "2026-08-30"],
    ]);
  });
});
