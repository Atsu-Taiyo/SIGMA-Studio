import { describe, expect, it } from "vitest";

import {
  appendFileRow,
  availableDocumentTitle,
  applyDocumentSave,
  buildWorkspaceOverview,
  createEmptyLibrary,
  createFolderRow,
  createWorkspaceRow,
  deleteFolderRow,
  deleteWorkspaceRow,
  ensureActiveWorkspace,
  ensureDefaultWorkspace,
  listFileMetadata,
  moveFileToFolderRow,
  moveFileToWorkspaceRow,
  rehomeOrphanFileRows,
  resolveWorkspaceState,
  softDeleteFileRow,
  updateFolderRow,
  visibleWorkspaces,
  type LibraryRecord,
} from "@/lib/library-ledger";

const NOW = "2026-01-01T00:00:00.000Z";

describe("availableDocumentTitle", () => {
  const files = ["教材", "教材 2", "教材 4"].map((title, i) => ({ fileId: `${i}`, workspaceId: "ws", folderId: null, title }));
  it("numbers duplicates and skips existing numbers", () => {
    expect(availableDocumentTitle("教材", files, { workspaceId: "ws" })).toBe("教材 3");
    expect(availableDocumentTitle("教材 4", files, { workspaceId: "ws" })).toBe("教材 5");
  });
  it("excludes the renamed file and other folders", () => {
    expect(availableDocumentTitle("教材", files, { workspaceId: "ws", excludeFileId: "0" })).toBe("教材");
    expect(availableDocumentTitle("教材", files, { workspaceId: "ws", folderId: "folder" })).toBe("教材");
  });
});

function idFactory(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}_${(counter += 1)}`;
}

function libraryWithWorkspace(): { library: LibraryRecord; workspaceId: string } {
  const library = createEmptyLibrary();
  const workspace = createWorkspaceRow(library, { id: "workspace_1", name: "A", now: NOW });
  return { library, workspaceId: workspace.id };
}

function addFile(
  library: LibraryRecord,
  fileId: string,
  workspaceId: string,
  folderId: string | null = null,
): void {
  appendFileRow(library, {
    fileId,
    workspaceId,
    folderId,
    docId: `doc_${fileId}`,
    title: fileId,
    now: NOW,
  });
}

describe("ensureDefaultWorkspace", () => {
  it("mints a workspace when none is visible", () => {
    const library = createEmptyLibrary();

    expect(ensureDefaultWorkspace(library, { now: NOW, defaultName: "My materials", createId: idFactory("workspace") }))
      .toBe(true);
    expect(library.workspaces).toHaveLength(1);
    expect(library.workspaces[0]).toMatchObject({ name: "My materials", deletedAt: null });
    expect(library.activeWorkspaceId).toBe(library.workspaces[0].id);
  });

  it("does nothing when a visible workspace already exists", () => {
    const { library } = libraryWithWorkspace();

    expect(ensureDefaultWorkspace(library, { now: NOW, defaultName: "X", createId: idFactory("workspace") }))
      .toBe(false);
    expect(library.workspaces).toHaveLength(1);
  });

  it("restores the most recently deleted workspace with the files deleted alongside it", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    const spare = createWorkspaceRow(library, { id: "workspace_spare", name: "B", now: NOW });
    addFile(library, "file_kept", workspaceId);
    addFile(library, "file_removed_earlier", workspaceId);
    // 先に個別削除された教材は、ワークスペース復元の巻き添えで戻ってはいけない。
    softDeleteFileRow(library, "file_removed_earlier", "2025-12-31T00:00:00.000Z");
    deleteWorkspaceRow(library, workspaceId, "2026-01-02T00:00:00.000Z");
    // 台帳が壊れて可視ワークスペースが 0 になった状態を作る (最後の 1 つは通常操作では消せない)。
    deleteWorkspaceRow(library, spare.id, "2026-01-01T12:00:00.000Z");
    library.workspaces = library.workspaces.map((workspace) =>
      workspace.id === spare.id
        ? { ...workspace, deletedAt: "2026-01-01T12:00:00.000Z", updatedAt: "2026-01-01T12:00:00.000Z" }
        : workspace);

    expect(ensureDefaultWorkspace(library, {
      now: "2026-01-03T00:00:00.000Z",
      defaultName: "unused",
      createId: idFactory("workspace"),
    })).toBe(true);

    expect(visibleWorkspaces(library).map((workspace) => workspace.id)).toEqual([workspaceId]);
    expect(library.activeWorkspaceId).toBe(workspaceId);
    expect(listFileMetadata(library).map((file) => file.fileId)).toEqual(["file_kept"]);
  });
});

describe("workspace deletion", () => {
  it("refuses to delete the last visible workspace", () => {
    const { library, workspaceId } = libraryWithWorkspace();

    expect(deleteWorkspaceRow(library, workspaceId, NOW)).toEqual({ ok: false, reason: "last-workspace" });
  });

  it("cascades to folders and files and moves the active workspace", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    const other = createWorkspaceRow(library, { id: "workspace_2", name: "B", now: NOW });
    const folder = createFolderRow(library, { id: "folder_1", workspaceId, name: "F", now: NOW });
    expect(folder.ok).toBe(true);
    addFile(library, "file_1", workspaceId, "folder_1");
    addFile(library, "file_other", other.id);

    const result = deleteWorkspaceRow(library, workspaceId, "2026-02-01T00:00:00.000Z");

    expect(result).toEqual({ ok: true, value: { nextActiveWorkspaceId: other.id } });
    expect(library.activeWorkspaceId).toBe(other.id);
    expect(listFileMetadata(library).map((file) => file.fileId)).toEqual(["file_other"]);
    expect(library.folders[0].deletedAt).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("folders", () => {
  it("recursively deletes descendants and files while preserving siblings", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    createFolderRow(library, { id: "parent", workspaceId, name: "P", now: NOW });
    createFolderRow(library, { id: "child", workspaceId, parentFolderId: "parent", name: "C", now: NOW });
    createFolderRow(library, { id: "grandchild", workspaceId, parentFolderId: "child", name: "G", now: NOW });
    createFolderRow(library, { id: "sibling", workspaceId, name: "S", now: NOW });
    addFile(library, "nested", workspaceId, "grandchild");
    addFile(library, "kept", workspaceId, "sibling");
    expect(deleteFolderRow(library, workspaceId, "parent", NOW).ok).toBe(true);
    expect(library.folders.filter(f => !f.deletedAt).map(f => f.id)).toEqual(["sibling"]);
    expect(listFileMetadata(library).map(f => f.fileId)).toEqual(["kept"]);
  });

  it("refuses to move a folder inside its own descendant", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    createFolderRow(library, { id: "folder_parent", workspaceId, name: "P", now: NOW });
    createFolderRow(library, {
      id: "folder_child",
      workspaceId,
      name: "C",
      parentFolderId: "folder_parent",
      now: NOW,
    });

    expect(updateFolderRow(library, workspaceId, "folder_parent", { parentFolderId: "folder_child" }, NOW))
      .toEqual({ ok: false, reason: "invalid-folder-move" });
  });

  it("reports an unknown folder rather than falling back to the workspace root", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    addFile(library, "file_1", workspaceId);

    expect(moveFileToFolderRow(library, workspaceId, "file_1", "folder_missing", NOW))
      .toEqual({ ok: false, reason: "folder-not-found" });
  });
});

describe("buildWorkspaceOverview", () => {
  it("counts only visible files per folder and hides other workspaces' rows", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    const other = createWorkspaceRow(library, { id: "workspace_2", name: "B", now: NOW });
    createFolderRow(library, { id: "folder_1", workspaceId, name: "F", now: NOW });
    addFile(library, "file_1", workspaceId, "folder_1");
    addFile(library, "file_2", workspaceId, "folder_1");
    addFile(library, "file_3", workspaceId);
    addFile(library, "file_other", other.id);
    softDeleteFileRow(library, "file_2", NOW);

    const overview = buildWorkspaceOverview(library, workspaceId);

    expect(overview.activeWorkspaceId).toBe(workspaceId);
    expect(overview.workspaces.map((workspace) => workspace.id)).toEqual([workspaceId, other.id]);
    expect(overview.folders).toEqual([expect.objectContaining({ id: "folder_1", fileCount: 1 })]);
    expect(overview.files.map((file) => file.fileId)).toEqual(["file_1", "file_3"]);
  });
});

describe("moveFileToWorkspaceRow", () => {
  it("moves the file and follows it with the active workspace", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    const other = createWorkspaceRow(library, { id: "workspace_2", name: "B", now: NOW });
    library.activeWorkspaceId = workspaceId;
    addFile(library, "file_1", workspaceId);

    const result = moveFileToWorkspaceRow(library, "file_1", other.id, null, NOW);

    expect(result.ok).toBe(true);
    expect(library.activeWorkspaceId).toBe(other.id);
    expect(buildWorkspaceOverview(library, other.id).files.map((file) => file.fileId)).toEqual(["file_1"]);
  });
});

describe("applyDocumentSave", () => {
  it("advances the revision when the observed revision matches", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    addFile(library, "file_1", workspaceId);

    const result = applyDocumentSave(library, "file_1", {
      expectedRevision: 1,
      docId: "doc_next",
      title: "next",
      updatedAt: "2026-03-01T00:00:00.000Z",
      now: "2026-03-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: true });
    expect(library.files[0]).toMatchObject({ revision: 2, docId: "doc_next", title: "next" });
  });

  it("rejects a stale write and reports the stored revision", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    addFile(library, "file_1", workspaceId);
    applyDocumentSave(library, "file_1", {
      expectedRevision: 1,
      docId: "doc_1",
      title: "t",
      updatedAt: NOW,
      now: NOW,
    });

    expect(applyDocumentSave(library, "file_1", {
      expectedRevision: 1,
      docId: "doc_1",
      title: "stale",
      updatedAt: NOW,
      now: NOW,
    })).toEqual({ ok: false, reason: "revision-mismatch", currentRevision: 2 });
    expect(library.files[0].title).toBe("t");
  });
});

describe("resolveWorkspaceState", () => {
  it("drops tabs whose files are gone and keeps the active one first", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    addFile(library, "file_1", workspaceId);
    addFile(library, "file_2", workspaceId);

    expect(resolveWorkspaceState(library, { openFileIds: ["file_missing", "file_2"], activeFileId: "file_2" }))
      .toEqual({ ok: true, value: { openFileIds: ["file_2"], activeFileId: "file_2" } });
  });

  it("falls back to a file in the active workspace when the stored active file is gone", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    addFile(library, "file_1", workspaceId);

    expect(resolveWorkspaceState(library, { openFileIds: [], activeFileId: "file_missing" }))
      .toEqual({ ok: true, value: { openFileIds: ["file_1"], activeFileId: "file_1" } });
  });

  it("reports that there is nothing to open when the library is empty", () => {
    const { library } = libraryWithWorkspace();

    expect(resolveWorkspaceState(library, null)).toEqual({ ok: false, reason: "no-visible-files" });
  });
});

describe("orphan repair", () => {
  it("rehomes files whose workspace row vanished", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    addFile(library, "file_1", "workspace_gone");

    expect(rehomeOrphanFileRows(library)).toBe(true);
    expect(library.files[0].workspaceId).toBe(workspaceId);
  });

  it("repoints the active workspace when it is no longer visible", () => {
    const { library, workspaceId } = libraryWithWorkspace();
    const other = createWorkspaceRow(library, { id: "workspace_2", name: "B", now: NOW });
    library.activeWorkspaceId = "workspace_gone";

    expect(ensureActiveWorkspace(library)).toBe(true);
    expect(library.activeWorkspaceId).toBe(workspaceId);
    expect(other.id).toBe("workspace_2");
  });
});
