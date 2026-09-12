import { describe, expect, it } from "vitest";

import type { WorkspaceFileSummary, WorkspaceFolderSummary, WorkspaceOverview } from "@/lib/workspace-repository";
import type { WorkspaceSummary } from "@/lib/runtime/types";

import { applyPendingRenames, buildFolderPath, buildWorkspaceRows, resolveRowLocation, type WorkspaceRow } from "./workspace-list-model";
import { createTranslator } from "@/lib/i18n";

const t = createTranslator("ja", "workspace");

const NOW = "2026-07-26T00:00:00.000Z";
const LATER = "2026-07-27T00:00:00.000Z";

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

describe("buildWorkspaceRows", () => {
  it("always sorts folders before files, for every key/direction combination", () => {
    const folders = [makeFolder({ id: "f1", name: "z-フォルダ", updatedAt: NOW })];
    const files = [makeFile({ fileId: "file-1", title: "a-教材", updatedAt: LATER })];

    for (const sortKey of ["name", "updatedAt"] as const) {
      for (const sortDirection of ["asc", "desc"] as const) {
        const rows = buildWorkspaceRows({ folders, files, sortKey, sortDirection, t });
        expect(rows.map((row) => row.kind)).toEqual(["folder", "file"]);
      }
    }
  });

  it("orders Japanese names numerically via Intl.Collator (教材2 before 教材10)", () => {
    const files = [
      makeFile({ fileId: "a", title: "教材10", updatedAt: NOW }),
      makeFile({ fileId: "b", title: "教材2", updatedAt: NOW }),
    ];
    const rows = buildWorkspaceRows({ folders: [], files, sortKey: "name", sortDirection: "asc", t });
    expect(rows.map((row) => row.name)).toEqual(["教材2", "教材10"]);
  });

  it("reverses name order when sortDirection is desc", () => {
    const files = [
      makeFile({ fileId: "a", title: "あ", updatedAt: NOW }),
      makeFile({ fileId: "b", title: "い", updatedAt: NOW }),
    ];
    const rows = buildWorkspaceRows({ folders: [], files, sortKey: "name", sortDirection: "desc", t });
    expect(rows.map((row) => row.name)).toEqual(["い", "あ"]);
  });

  it("uses the display-name fallback for sorting as well as display", () => {
    const files = [
      makeFile({ fileId: "a", title: "あ", updatedAt: NOW }),
      makeFile({ fileId: "b", title: "", updatedAt: NOW }),
    ];
    // "" falls back to 無題の教材, which sorts after "あ" in ja numeric/base order.
    const rows = buildWorkspaceRows({ folders: [], files, sortKey: "name", sortDirection: "asc", t });
    expect(rows.map((row) => row.name)).toEqual(["あ", "無題の教材"]);
  });

  it("sorts by updatedAt and breaks ties on ascending name for a stable order", () => {
    const files = [
      makeFile({ fileId: "a", title: "い", updatedAt: NOW }),
      makeFile({ fileId: "b", title: "あ", updatedAt: NOW }),
      makeFile({ fileId: "c", title: "う", updatedAt: LATER }),
    ];
    const asc = buildWorkspaceRows({ folders: [], files, sortKey: "updatedAt", sortDirection: "asc", t });
    expect(asc.map((row) => row.name)).toEqual(["あ", "い", "う"]);

    const desc = buildWorkspaceRows({ folders: [], files, sortKey: "updatedAt", sortDirection: "desc", t });
    // う is strictly latest either way; the NOW-tied pair still breaks あ before い.
    expect(desc.map((row) => row.name)).toEqual(["う", "あ", "い"]);
  });

  it("sorts an unparsable updatedAt last regardless of direction", () => {
    const files = [
      makeFile({ fileId: "a", title: "あ", updatedAt: "not-a-date" }),
      makeFile({ fileId: "b", title: "い", updatedAt: NOW }),
    ];
    const asc = buildWorkspaceRows({ folders: [], files, sortKey: "updatedAt", sortDirection: "asc", t });
    expect(asc.map((row) => row.name)).toEqual(["い", "あ"]);

    const desc = buildWorkspaceRows({ folders: [], files, sortKey: "updatedAt", sortDirection: "desc", t });
    expect(desc.map((row) => row.name)).toEqual(["い", "あ"]);
  });

  it("builds tagged folder:<id> and file:<id> keys matching the WorkspaceDropTarget vocabulary", () => {
    const rows = buildWorkspaceRows({
      folders: [makeFolder({ id: "f1" })],
      files: [makeFile({ fileId: "file-1" })],
      sortKey: "name",
      sortDirection: "asc",
      t,
    });
    expect(rows.map((row) => row.key)).toEqual(["folder:f1", "file:file-1"]);
  });
});

describe("resolveRowLocation", () => {
  const parent = makeFolder({ id: "parent", name: "親フォルダ", parentFolderId: null });
  const child = makeFolder({ id: "child", name: "子フォルダ", parentFolderId: "parent" });
  const folders = [parent, child];

  function fileRow(file: WorkspaceFileSummary): WorkspaceRow {
    return { kind: "file", key: `file:${file.fileId}`, id: file.fileId, name: file.title, updatedAt: file.updatedAt, file };
  }
  function folderRow(folder: WorkspaceFolderSummary): WorkspaceRow {
    return { kind: "folder", key: `folder:${folder.id}`, id: folder.id, name: folder.name, updatedAt: folder.updatedAt, folder };
  }

  it("resolves a file's location to its containing folder's name", () => {
    const file = makeFile({ fileId: "f", folderId: "child" });
    expect(resolveRowLocation(fileRow(file), { folders, workspaceName: "マイ教材" })).toBe("子フォルダ");
  });

  it("resolves a root file's location to the workspace name", () => {
    const file = makeFile({ fileId: "f", folderId: null });
    expect(resolveRowLocation(fileRow(file), { folders, workspaceName: "マイ教材" })).toBe("マイ教材");
  });

  it("resolves a folder's location to its parent folder's name", () => {
    expect(resolveRowLocation(folderRow(child), { folders, workspaceName: "マイ教材" })).toBe("親フォルダ");
  });

  it("resolves a root folder's location to the workspace name", () => {
    expect(resolveRowLocation(folderRow(parent), { folders, workspaceName: "マイ教材" })).toBe("マイ教材");
  });

  it("falls back to the workspace name for a dangling folderId without throwing", () => {
    const file = makeFile({ fileId: "f", folderId: "missing" });
    expect(() => resolveRowLocation(fileRow(file), { folders, workspaceName: "マイ教材" })).not.toThrow();
    expect(resolveRowLocation(fileRow(file), { folders, workspaceName: "マイ教材" })).toBe("マイ教材");
  });

  it("falls back to the workspace name for a dangling parentFolderId without throwing", () => {
    const orphan = makeFolder({ id: "orphan", parentFolderId: "missing" });
    expect(() => resolveRowLocation(folderRow(orphan), { folders, workspaceName: "マイ教材" })).not.toThrow();
    expect(resolveRowLocation(folderRow(orphan), { folders, workspaceName: "マイ教材" })).toBe("マイ教材");
  });
});

describe("buildFolderPath", () => {
  it("returns an empty array for a null folderId", () => {
    expect(buildFolderPath([], null)).toEqual([]);
  });

  it("walks a normal chain root-first, ending at the requested folder", () => {
    const root = makeFolder({ id: "root", name: "root", parentFolderId: null });
    const mid = makeFolder({ id: "mid", name: "mid", parentFolderId: "root" });
    const leaf = makeFolder({ id: "leaf", name: "leaf", parentFolderId: "mid" });
    const folders = [root, mid, leaf];

    expect(buildFolderPath(folders, "leaf")).toEqual([root, mid, leaf]);
  });

  it("terminates on a self-parented folder", () => {
    const selfParented = makeFolder({ id: "loop", name: "loop", parentFolderId: "loop" });
    expect(() => buildFolderPath([selfParented], "loop")).not.toThrow();
    const result = buildFolderPath([selfParented], "loop");
    expect(result).toEqual([selfParented]);
  });

  it("terminates on an A -> B -> A cycle", () => {
    const a = makeFolder({ id: "a", name: "a", parentFolderId: "b" });
    const b = makeFolder({ id: "b", name: "b", parentFolderId: "a" });
    const folders = [a, b];

    expect(() => buildFolderPath(folders, "a")).not.toThrow();
    const result = buildFolderPath(folders, "a");
    // Must terminate with a finite result; the exact tie-break of a cyclic
    // graph isn't meaningful, but it must include both nodes exactly once.
    expect(result).toHaveLength(2);
    expect(new Set(result.map((folder) => folder.id))).toEqual(new Set(["a", "b"]));
  });

  it("terminates on a dangling parentFolderId", () => {
    const orphan = makeFolder({ id: "orphan", parentFolderId: "missing" });
    expect(buildFolderPath([orphan], "orphan")).toEqual([orphan]);
  });

  it("returns an empty array when the requested folderId does not exist", () => {
    expect(buildFolderPath([], "missing")).toEqual([]);
  });
});

function makeWorkspace(overrides: Partial<WorkspaceSummary> & { id: string }): WorkspaceSummary {
  return {
    name: "ワークスペース",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeOverview(overrides: Partial<WorkspaceOverview> = {}): WorkspaceOverview {
  return {
    activeWorkspaceId: "workspace-1",
    workspaces: [makeWorkspace({ id: "workspace-1" })],
    folders: [makeFolder({ id: "folder-1", name: "フォルダA" })],
    files: [makeFile({ fileId: "file-1", title: "教材A" })],
    ...overrides,
  };
}

describe("applyPendingRenames", () => {
  it("is a no-op for an empty pending map, returning the same overview reference", () => {
    const overview = makeOverview();
    expect(applyPendingRenames(overview, new Map())).toBe(overview);
  });

  it("overlays a pending file rename", () => {
    const overview = makeOverview();
    const next = applyPendingRenames(overview, new Map([["file:file-1", "改名後の教材"]]));
    expect(next.files[0].title).toBe("改名後の教材");
    expect(next).not.toBe(overview);
  });

  it("overlays a pending folder rename", () => {
    const overview = makeOverview();
    const next = applyPendingRenames(overview, new Map([["folder:folder-1", "改名後のフォルダ"]]));
    expect(next.folders[0].name).toBe("改名後のフォルダ");
  });

  it("overlays a pending workspace rename", () => {
    const overview = makeOverview();
    const next = applyPendingRenames(overview, new Map([["workspace:workspace-1", "改名後のワークスペース"]]));
    expect(next.workspaces[0].name).toBe("改名後のワークスペース");
  });

  it("ignores a pending entry whose id is not present in the overview", () => {
    const overview = makeOverview();
    const next = applyPendingRenames(overview, new Map([["file:does-not-exist", "無関係な名前"]]));
    expect(next).toBe(overview);
  });

  it("is a no-op when the pending name already matches the current name", () => {
    const overview = makeOverview();
    const next = applyPendingRenames(overview, new Map([["file:file-1", "教材A"]]));
    expect(next).toBe(overview);
  });

  it("applies multiple pending renames across files, folders, and workspaces at once", () => {
    const overview = makeOverview();
    const next = applyPendingRenames(overview, new Map([
      ["file:file-1", "新しい教材名"],
      ["folder:folder-1", "新しいフォルダ名"],
      ["workspace:workspace-1", "新しいワークスペース名"],
    ]));
    expect(next.files[0].title).toBe("新しい教材名");
    expect(next.folders[0].name).toBe("新しいフォルダ名");
    expect(next.workspaces[0].name).toBe("新しいワークスペース名");
  });
});
