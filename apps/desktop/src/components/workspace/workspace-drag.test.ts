import { describe, expect, it } from "vitest";

import type { WorkspaceSummary } from "@/lib/runtime/types";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

import {
  canDropItem,
  isWorkspaceDragItem,
  parseWorkspaceItemKey,
  workspaceItemKey,
  type CanDropItemInput,
} from "./workspace-drag";

const NOW = "2026-07-26T00:00:00.000Z";

function makeFolder(overrides: Partial<WorkspaceFolderSummary> & { id: string }): WorkspaceFolderSummary {
  return {
    workspaceId: "workspace-1",
    parentFolderId: null,
    name: "フォルダ",
    fileCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeFile(overrides: Partial<WorkspaceFileSummary> & { fileId: string }): WorkspaceFileSummary {
  return {
    workspaceId: "workspace-1",
    folderId: null,
    docId: `doc-${overrides.fileId}`,
    title: "教材",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<WorkspaceSummary> & { id: string }): WorkspaceSummary {
  return {
    name: "ワークスペース",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseInput(overrides: Partial<CanDropItemInput> = {}): CanDropItemInput {
  return {
    item: null,
    target: null,
    folders: [],
    files: [],
    workspaces: [],
    hasActiveWorkspace: true,
    ...overrides,
  };
}

describe("isWorkspaceDragItem", () => {
  it("rejects null", () => {
    expect(isWorkspaceDragItem(null)).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(isWorkspaceDragItem({})).toBe(false);
  });

  it("rejects a file item with a non-string fileId", () => {
    expect(isWorkspaceDragItem({ type: "file", fileId: 123 })).toBe(false);
  });

  it("rejects a folder item with a non-string folderId", () => {
    expect(isWorkspaceDragItem({ type: "folder", folderId: 123 })).toBe(false);
  });

  it("accepts a well-formed file item", () => {
    expect(isWorkspaceDragItem({ type: "file", fileId: "file-1" })).toBe(true);
  });

  it("accepts a well-formed folder item", () => {
    expect(isWorkspaceDragItem({ type: "folder", folderId: "folder-1" })).toBe(true);
  });
});

describe("canDropItem", () => {
  it("rejects a file dropped onto its own current folder", () => {
    const file = makeFile({ fileId: "file-1", folderId: "folder-1" });
    const input = baseInput({
      item: { type: "file", fileId: "file-1" },
      target: "folder:folder-1",
      files: [file],
      folders: [makeFolder({ id: "folder-1" })],
    });
    expect(canDropItem(input)).toBe(false);
  });

  it("rejects a file dropped onto root when it is already at root", () => {
    const file = makeFile({ fileId: "file-1", folderId: null });
    const input = baseInput({
      item: { type: "file", fileId: "file-1" },
      target: "root",
      files: [file],
    });
    expect(canDropItem(input)).toBe(false);
  });

  it("rejects a folder dropped onto itself", () => {
    const folder = makeFolder({ id: "folder-1", parentFolderId: null });
    const input = baseInput({
      item: { type: "folder", folderId: "folder-1" },
      target: "folder:folder-1",
      folders: [folder],
    });
    expect(canDropItem(input)).toBe(false);
  });

  it("rejects a folder dropped onto its own descendant", () => {
    const parent = makeFolder({ id: "folder-1", parentFolderId: null });
    const child = makeFolder({ id: "folder-2", parentFolderId: "folder-1" });
    const input = baseInput({
      item: { type: "folder", folderId: "folder-1" },
      target: "folder:folder-2",
      folders: [parent, child],
    });
    expect(canDropItem(input)).toBe(false);
  });

  it("rejects a folder dropped onto its current parent", () => {
    const parent = makeFolder({ id: "folder-1", parentFolderId: null });
    const child = makeFolder({ id: "folder-2", parentFolderId: "folder-1" });
    const input = baseInput({
      item: { type: "folder", folderId: "folder-2" },
      target: "folder:folder-1",
      folders: [parent, child],
    });
    expect(canDropItem(input)).toBe(false);
  });

  it("accepts a file dropped onto another workspace", () => {
    const file = makeFile({ fileId: "file-1", workspaceId: "workspace-1" });
    const targetWorkspace = makeWorkspace({ id: "workspace-2" });
    const input = baseInput({
      item: { type: "file", fileId: "file-1" },
      target: "workspace:workspace-2",
      files: [file],
      workspaces: [targetWorkspace],
    });
    expect(canDropItem(input)).toBe(true);
  });
});

describe("workspaceItemKey / parseWorkspaceItemKey", () => {
  it("round-trips a file item", () => {
    const item = { type: "file" as const, fileId: "file-1" };
    const key = workspaceItemKey(item);
    expect(key).toBe("file:file-1");
    expect(parseWorkspaceItemKey(key)).toEqual(item);
  });

  it("round-trips a folder item", () => {
    const item = { type: "folder" as const, folderId: "folder-1" };
    const key = workspaceItemKey(item);
    expect(key).toBe("folder:folder-1");
    expect(parseWorkspaceItemKey(key)).toEqual(item);
  });

  it("returns null for a malformed key", () => {
    expect(parseWorkspaceItemKey("workspace:workspace-1")).toBeNull();
    expect(parseWorkspaceItemKey("garbage")).toBeNull();
  });
});
