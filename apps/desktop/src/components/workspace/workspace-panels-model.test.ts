import { describe, expect, it } from "vitest";

import type { UserCommentThread } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import type { WorkspaceSummary } from "@/lib/runtime/types";
import type { WorkspaceBookmark } from "@/lib/workspace-bookmarks";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

import {
  buildBookmarkEntries,
  buildCommentEntries,
  countUnresolvedMentions,
  filterCommentEntries,
  resolveItemLocation,
  type WorkspacePanelContext,
} from "./workspace-panels-model";

const t = createTranslator("ja", "workspace");
const STAMP = "2026-09-01T00:00:00.000Z";

const workspaces: WorkspaceSummary[] = [
  { id: "w1", name: "マイ教材", createdAt: STAMP, updatedAt: STAMP },
  { id: "shared-items", name: "shared", createdAt: STAMP, updatedAt: STAMP },
];
const folders: WorkspaceFolderSummary[] = [
  { id: "f-root", workspaceId: "w1", parentFolderId: null, name: "数学", fileCount: 1, createdAt: STAMP, updatedAt: STAMP },
  { id: "f-child", workspaceId: "w1", parentFolderId: "f-root", name: "中1", fileCount: 1, createdAt: STAMP, updatedAt: STAMP },
];
const files: WorkspaceFileSummary[] = [
  { fileId: "a", workspaceId: "w1", folderId: "f-child", docId: "d-a", title: "方程式", revision: 1, createdAt: STAMP, updatedAt: STAMP },
  { fileId: "b", workspaceId: "w1", folderId: null, docId: "d-b", title: "", revision: 1, createdAt: STAMP, updatedAt: STAMP },
  { fileId: "catalog_c", workspaceId: "shared-items", folderId: null, docId: "d-c", title: "共有された教材", revision: 1, createdAt: STAMP, updatedAt: STAMP, sharing: {} as WorkspaceFileSummary["sharing"] },
];
const context: WorkspacePanelContext = {
  workspaces,
  folders,
  files,
  workspaceLabel: (workspace) => workspace.id === "shared-items" ? "共有アイテム" : workspace.name,
};

describe("resolveItemLocation", () => {
  it("joins the workspace and the folder path", () => {
    expect(resolveItemLocation(context, "w1", "f-child")).toBe("マイ教材 / 数学 / 中1");
    expect(resolveItemLocation(context, "w1", null)).toBe("マイ教材");
  });

  it("uses the display label for shared items and survives an unknown workspace", () => {
    expect(resolveItemLocation(context, "shared-items", null)).toBe("共有アイテム");
    expect(resolveItemLocation(context, "gone", null)).toBe("");
  });
});

describe("buildBookmarkEntries", () => {
  const bookmarks: WorkspaceBookmark[] = [
    { kind: "file", id: "a", addedAt: "2026-09-10T00:00:00.000Z" },
    { kind: "folder", id: "f-child", addedAt: "2026-09-12T00:00:00.000Z" },
    { kind: "file", id: "deleted", addedAt: "2026-09-13T00:00:00.000Z" },
    { kind: "file", id: "catalog_c", addedAt: "2026-09-11T00:00:00.000Z" },
    { kind: "file", id: "b", addedAt: "2026-09-09T00:00:00.000Z" },
  ];

  it("resolves items, newest bookmark first, and leaves out ones that are not visible", () => {
    const entries = buildBookmarkEntries(bookmarks, context, t);
    expect(entries.map((entry) => entry.key)).toEqual(["folder:f-child", "file:catalog_c", "file:a", "file:b"]);
    expect(entries[0]).toMatchObject({ kind: "folder", name: "中1", location: "マイ教材 / 数学", parentFolderId: "f-root", workspaceId: "w1", shared: false });
    expect(entries[1]).toMatchObject({ name: "共有された教材", location: "共有アイテム", shared: true });
    expect(entries[2]).toMatchObject({ name: "方程式", location: "マイ教材 / 数学 / 中1", parentFolderId: "f-child" });
  });

  it("names an untitled material the way the list does", () => {
    const entries = buildBookmarkEntries([{ kind: "file", id: "b", addedAt: STAMP }], context, t);
    expect(entries[0].name).toBe(t("untitledMaterial"));
  });

  it("does not drop bookmarks whose target is only temporarily missing from the input", () => {
    const withoutShared = { ...context, files: files.filter((file) => !file.sharing) };
    expect(buildBookmarkEntries(bookmarks, withoutShared, t).map((entry) => entry.id)).not.toContain("catalog_c");
    // 入力の bookmarks は変わらない: 共有が戻れば再び出せる。
    expect(bookmarks.some((bookmark) => bookmark.id === "catalog_c")).toBe(true);
    expect(buildBookmarkEntries(bookmarks, context, t).map((entry) => entry.id)).toContain("catalog_c");
  });
});

describe("buildCommentEntries", () => {
  function thread(threadId: string, activityAt: string, extra: Partial<UserCommentThread> = {}): UserCommentThread {
    return {
      threadId, resolved: false, mentioned: true, authored: false, messageId: `m-${threadId}`, ownMessage: false,
      excerpt: `@私 ${threadId}`, quote: "", messageCount: 1, activityAt, ...extra,
    };
  }

  it("orders by the latest activity and carries the document and its location", () => {
    const entries = buildCommentEntries(new Map([
      ["a", [thread("t1", "2026-09-10T00:00:00.000Z", { authorName: "佐藤", quote: "引用", messageCount: 3 })]],
      ["catalog_c", [thread("t2", "2026-09-12T00:00:00.000Z"), thread("t3", "2026-09-11T00:00:00.000Z", { resolved: true })]],
    ]), context, t);
    expect(entries.map((entry) => entry.key)).toEqual(["catalog_c:t2", "catalog_c:t3", "a:t1"]);
    expect(entries[0]).toMatchObject({ title: "共有された教材", location: "共有アイテム", shared: true, fileId: "catalog_c", threadId: "t2" });
    expect(entries[2]).toMatchObject({ title: "方程式", location: "マイ教材 / 数学 / 中1", authorName: "佐藤", quote: "引用", shared: false, messageCount: 3 });
    expect("authorName" in entries[0]).toBe(false);
  });

  it("ignores scan results for documents that are no longer listed", () => {
    expect(buildCommentEntries(new Map([["gone", [thread("t1", STAMP)]]]), context, t)).toEqual([]);
  });

  it("sorts unreadable timestamps last, deterministically", () => {
    const entries = buildCommentEntries(new Map([
      ["a", [thread("bad", "not a date"), thread("ok", "2026-09-10T00:00:00.000Z")]],
    ]), context, t);
    expect(entries.map((entry) => entry.threadId)).toEqual(["ok", "bad"]);
  });
});

describe("filterCommentEntries and countUnresolvedMentions", () => {
  const base = { fileId: "a", title: "", location: "", shared: false, ownMessage: false, excerpt: "", quote: "", messageCount: 1, activityAt: STAMP };
  const entries = [
    { ...base, key: "1", threadId: "1", resolved: false, mentioned: true, authored: false },
    { ...base, key: "2", threadId: "2", resolved: true, mentioned: true, authored: true },
    { ...base, key: "3", threadId: "3", resolved: false, mentioned: false, authored: true },
    { ...base, key: "4", threadId: "4", resolved: true, mentioned: false, authored: true },
  ];
  const keys = (relation: "all" | "mentioned" | "authored", includeResolved: boolean) =>
    filterCommentEntries(entries, { relation, includeResolved }).map((entry) => entry.key);

  it("hides resolved threads unless asked, and narrows by why a thread is related", () => {
    expect(keys("all", false)).toEqual(["1", "3"]);
    expect(keys("all", true)).toEqual(["1", "2", "3", "4"]);
    expect(keys("mentioned", true)).toEqual(["1", "2"]);
    expect(keys("authored", false)).toEqual(["3"]);
  });

  it("counts only unresolved threads that mention me", () => {
    expect(countUnresolvedMentions(entries)).toBe(1);
    expect(countUnresolvedMentions([])).toBe(0);
  });
});
