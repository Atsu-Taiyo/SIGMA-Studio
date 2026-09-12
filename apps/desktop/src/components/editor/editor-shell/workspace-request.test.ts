import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRequestedFileId,
  canCaptureDocumentBoundary,
  createUnsavedEditBackupTitle,
  degradedWatcherMessage,
  getDocumentBoundarySkipReason,
  getRequestedFileId,
  isDesktopStorageChangeEvent,
  updateDegradedWatcherScopes,
  uniqueStringIds,
} from "@/components/editor/editor-shell/workspace-request";
import { createTranslator } from "@/lib/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace requests", () => {
  it("recognizes only complete desktop storage change events", () => {
    expect(isDesktopStorageChangeEvent({ type: "workspace", timestamp: 1 })).toBe(true);
    expect(isDesktopStorageChangeEvent({ type: "library", timestamp: 2 })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "document",
      fileId: "file-1",
      change: "deleted",
      timestamp: 3,
    })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "document",
      fileId: "file-1",
      change: "changed",
      timestamp: 4,
      autoAppliedProposalIds: ["proposal-1"],
    })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "watcher",
      scope: "library",
      change: "recovered",
      timestamp: 7,
    })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "mcpProposal",
      change: "changed",
      timestamp: 4,
    })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "documentVersion",
      fileId: "file-1",
      change: "captured",
      timestamp: 4,
    })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "watcher",
      scope: "documents",
      change: "failed",
      timestamp: 5,
    })).toBe(true);
    expect(isDesktopStorageChangeEvent({
      type: "watcher",
      scope: "mcpProposal",
      change: "failed",
      timestamp: 6,
    })).toBe(true);

    expect(isDesktopStorageChangeEvent(null)).toBe(false);
    expect(isDesktopStorageChangeEvent({ type: "workspace" })).toBe(false);
    expect(isDesktopStorageChangeEvent({
      type: "document",
      change: "changed",
      timestamp: 3,
    })).toBe(false);
    expect(isDesktopStorageChangeEvent({
      type: "document",
      fileId: "file-1",
      change: "changed",
      timestamp: 3,
      autoAppliedProposalIds: [1],
    })).toBe(false);
    expect(isDesktopStorageChangeEvent({
      type: "mcpProposal",
      change: "deleted",
      timestamp: 4,
    })).toBe(false);
    expect(isDesktopStorageChangeEvent({
      type: "documentVersion",
      fileId: "file-1",
      change: "changed",
      timestamp: 4,
    })).toBe(false);
    expect(isDesktopStorageChangeEvent({
      type: "watcher",
      scope: "documents",
      change: "changed",
      timestamp: 5,
    })).toBe(false);
  });

  it("keeps watcher degradation independent from later autosave status and clears only on recovery", () => {
    const failure = {
      type: "watcher" as const,
      scope: "mcpProposal" as const,
      change: "failed" as const,
      timestamp: 1,
    };
    let scopes = updateDegradedWatcherScopes([], failure);
    let saveStatus = "監視停止";
    saveStatus = "保存済み";

    expect(saveStatus).toBe("保存済み");
    expect(scopes).toEqual(["mcpProposal"]);
    expect(degradedWatcherMessage(scopes)).toContain("AI編集案の外部変更を監視できません");

    scopes = updateDegradedWatcherScopes(scopes, { ...failure, change: "recovered", timestamp: 2 });
    expect(scopes).toEqual([]);
  });

  it("deduplicates file ids in first-seen order", () => {
    expect(uniqueStringIds(["file-2", "file-1", "file-2", "file-3", "file-1"])).toEqual([
      "file-2",
      "file-1",
      "file-3",
    ]);
  });

  it("allows boundary capture only when the autosave safety conditions hold", () => {
    const safe = {
      isEmbedded: false,
      workspaceReady: true,
      activeDocumentOpenFailed: false,
      externalChangePending: false,
      aiWriteInProgress: false,
      observedRevision: 4,
    };
    expect(canCaptureDocumentBoundary(safe)).toBe(true);
    for (const key of ["isEmbedded", "activeDocumentOpenFailed", "externalChangePending", "aiWriteInProgress"] as const) {
      expect(canCaptureDocumentBoundary({ ...safe, [key]: true })).toBe(false);
    }
    expect(canCaptureDocumentBoundary({ ...safe, workspaceReady: false })).toBe(false);
    expect(canCaptureDocumentBoundary({ ...safe, observedRevision: null })).toBe(false);
    expect(getDocumentBoundarySkipReason({ ...safe, externalChangePending: true })).toBe("external-change-pending");
    expect(getDocumentBoundarySkipReason({ ...safe, observedRevision: null })).toBe("revision-unknown");
  });

  it("builds the unsaved-edit backup title with the existing empty-title fallback", () => {
    expect(createUnsavedEditBackupTitle("教材A")).toBe("教材A（アプリ内編集の退避）");
    expect(createUnsavedEditBackupTitle("")).toBe("無題の教材（アプリ内編集の退避）");
  });

  it("formats watcher and backup messages in English when requested", () => {
    const t = createTranslator("en", "editor");
    expect(degradedWatcherMessage(["documents", "mcpProposal"], t)).toBe(
      "External changes to materials, AI edit proposals can't be monitored. Restart the app to try again.",
    );
    expect(createUnsavedEditBackupTitle("", t)).toBe("Untitled material (in-app edit backup)");
  });

  it("is inert when rendered without a browser window", () => {
    expect(getRequestedFileId()).toBeNull();
    expect(() => clearRequestedFileId()).not.toThrow();
  });

  it("reads and trims the requested file id from the current URL", () => {
    vi.stubGlobal("window", {
      location: {
        href: "https://example.test/editor?fileId=%20file-1%20&mode=edit",
        search: "?fileId=%20file-1%20&mode=edit",
      },
      history: { replaceState: vi.fn() },
    });

    expect(getRequestedFileId()).toBe("file-1");
  });

  it("removes only the requested file parameter while preserving the path, query, and hash", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "https://example.test/editor?fileId=file-1&mode=edit#section",
        search: "?fileId=file-1&mode=edit",
      },
      history: { replaceState },
    });

    clearRequestedFileId();

    expect(replaceState).toHaveBeenCalledWith({}, "", "/editor?mode=edit#section");
  });

  it("does not rewrite the URL when no requested file is present", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "https://example.test/editor?mode=edit#section",
        search: "?mode=edit",
      },
      history: { replaceState },
    });

    expect(getRequestedFileId()).toBeNull();
    clearRequestedFileId();

    expect(replaceState).not.toHaveBeenCalled();
  });
});
