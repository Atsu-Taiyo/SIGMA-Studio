import { describe, expect, it } from "vitest";

import {
  ancestorFolderIds,
  buildFileTree,
  flattenVisibleRows,
  normalizeSearchText,
  searchFiles,
} from "./files-tree-model";

const folders = [
  { id: "f-b", parentFolderId: null, name: "第10章" },
  { id: "f-a", parentFolderId: null, name: "第2章" },
  { id: "f-a1", parentFolderId: "f-a", name: "演習" },
  { id: "f-orphan", parentFolderId: "missing", name: "迷子" },
];
const files = [
  { fileId: "x1", folderId: null, title: "はじめに" },
  { fileId: "x2", folderId: "f-a", title: "二次関数 1" },
  { fileId: "x3", folderId: "f-a1", title: "二次関数 演習" },
  { fileId: "x4", folderId: "f-a", title: "" },
  { fileId: "x5", folderId: "gone", title: "行方不明" },
];

describe("buildFileTree", () => {
  const tree = buildFileTree(folders, files, "無題の教材");

  it("puts folders before files and orders numbers naturally (第2章 before 第10章)", () => {
    expect(tree.map((node) => (node.kind === "folder" ? node.name : node.title))).toEqual(["第2章", "第10章", "迷子", "はじめに", "行方不明"]);
  });

  it("nests files under their folder and counts descendants", () => {
    const chapter = tree[0];
    expect(chapter.kind === "folder" && chapter.fileCount).toBe(3);
    expect(chapter.kind === "folder" && chapter.children.map((child) => child.kind === "folder" ? child.name : child.title))
      .toEqual(["演習", "二次関数 1", "無題の教材"]);
  });

  it("shows folders that reference each other at the top level instead of losing them", () => {
    const cyclic = buildFileTree(
      [{ id: "a", parentFolderId: "b", name: "A" }, { id: "b", parentFolderId: "a", name: "B" }],
      [{ fileId: "z", folderId: "a", title: "z" }],
      "無題",
    );
    expect(cyclic.map((node) => node.kind === "folder" && node.name)).toEqual(["A", "B"]);
    expect(cyclic[0].kind === "folder" && cyclic[0].fileCount).toBe(1);
  });

  it("keeps items whose folder no longer exists at the top level instead of dropping them", () => {
    expect(tree.some((node) => node.kind === "file" && node.id === "x5")).toBe(true);
    expect(tree.some((node) => node.kind === "folder" && node.id === "f-orphan")).toBe(true);
  });
});

describe("flattenVisibleRows", () => {
  const tree = buildFileTree(folders, files, "無題");

  it("shows only collapsed folder rows until they are expanded", () => {
    expect(flattenVisibleRows(tree, new Set()).every((row) => row.depth === 0)).toBe(true);
    const rows = flattenVisibleRows(tree, new Set(["f-a"]));
    const ids = rows.map((row) => row.node.id);
    expect(ids.slice(0, 4)).toEqual(["f-a", "f-a1", "x2", "x4"]);
    expect(rows.find((row) => row.node.id === "x2")?.depth).toBe(1);
  });
});

describe("searchFiles", () => {
  const tree = buildFileTree(folders, files, "無題");

  it("matches every term against the name and folder path, ignoring width and case", () => {
    expect(searchFiles(tree, "二次関数").map((row) => row.node.id).sort()).toEqual(["x2", "x3"]);
    expect(searchFiles(tree, "ＮＩ次")).toEqual([]);
    expect(searchFiles(tree, "演習 二次").map((row) => row.node.id)).toEqual(["x3"]);
    expect(searchFiles(tree, "第2章 二次").map((row) => row.node.id).sort()).toEqual(["x2", "x3"]);
    expect(searchFiles(tree, "   ")).toEqual([]);
  });

  it("normalizes full-width text", () => {
    expect(normalizeSearchText("　ＡＢＣ　")).toBe("abc");
  });
});

describe("ancestorFolderIds", () => {
  it("lists the folder chain from the file's folder upward and survives cycles", () => {
    expect(ancestorFolderIds(folders, "f-a1")).toEqual(["f-a1", "f-a"]);
    expect(ancestorFolderIds(folders, null)).toEqual([]);
    expect(ancestorFolderIds([{ id: "a", parentFolderId: "b", name: "a" }, { id: "b", parentFolderId: "a", name: "b" }], "a")).toEqual(["a", "b"]);
  });
});
