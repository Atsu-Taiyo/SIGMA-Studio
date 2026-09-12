import { describe, expect, it } from "vitest";

import {
  isDocumentVersionRestoreContextCurrent,
  runDocumentVersionRestore,
} from "./document-version-restore";

describe("document version restore context", () => {
  const document = { id: "current" };
  const expected = { fileId: "file_1", observedRevision: 3, dirtyRevision: 7, document };

  it("accepts only the unchanged file, observed revision, dirty revision, and document identity", () => {
    expect(isDocumentVersionRestoreContextCurrent(expected, { ...expected })).toBe(true);
    expect(isDocumentVersionRestoreContextCurrent(expected, { ...expected, fileId: "file_2" })).toBe(false);
    expect(isDocumentVersionRestoreContextCurrent(expected, { ...expected, observedRevision: 4 })).toBe(false);
    expect(isDocumentVersionRestoreContextCurrent(expected, { ...expected, dirtyRevision: 8 })).toBe(false);
    expect(isDocumentVersionRestoreContextCurrent(expected, { ...expected, document: { id: "current" } })).toBe(false);
  });

  it("returns a structured failure when backup capture rejects", async () => {
    let applied = false;
    let saved = false;

    await expect(runDocumentVersionRestore({
      captureBackup: () => Promise.reject(new Error("IPC unavailable")),
      isContextCurrent: () => true,
      applyVersion: () => {
        applied = true;
        return true;
      },
      saveRestoredDocument: async () => {
        saved = true;
        return { ok: true };
      },
      applyRejectedError: "apply rejected",
      saveAppliedError: "applied but not saved",
      fallbackError: "この版に復元できませんでした。もう一度お試しください。",
    })).resolves.toEqual({
      ok: false,
      error: "この版に復元できませんでした。もう一度お試しください。",
    });
    expect(applied).toBe(false);
    expect(saved).toBe(false);
  });

  it("does not save and returns a dedicated failure when the mutation is rejected", async () => {
    let saved = false;

    await expect(runDocumentVersionRestore({
      captureBackup: async () => ({ ok: true }),
      isContextCurrent: () => true,
      applyVersion: () => false,
      saveRestoredDocument: async () => {
        saved = true;
        return { ok: true };
      },
      applyRejectedError: "apply rejected",
      saveAppliedError: "applied but not saved",
      fallbackError: "restore failed",
    })).resolves.toEqual({ ok: false, error: "apply rejected" });
    expect(saved).toBe(false);
  });

  it("reports that the version was applied but remains unsaved when save rejects", async () => {
    let applied = false;

    await expect(runDocumentVersionRestore({
      captureBackup: async () => ({ ok: true }),
      isContextCurrent: () => true,
      applyVersion: () => {
        applied = true;
        return true;
      },
      saveRestoredDocument: () => Promise.reject(new Error("write failed")),
      applyRejectedError: "apply rejected",
      saveAppliedError: "applied but not saved",
      fallbackError: "restore failed",
    })).resolves.toEqual({ ok: false, error: "applied but not saved" });
    expect(applied).toBe(true);
  });
});
