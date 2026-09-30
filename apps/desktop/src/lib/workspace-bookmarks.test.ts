import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeWorkspaceBookmarks, toggleBookmarkIn, workspaceBookmarkKey, type WorkspaceBookmark } from "./workspace-bookmarks";

const STORAGE_KEY = "sigma-studio:workspace-bookmarks";

class FakeWindow extends EventTarget {
  private readonly store = new Map<string, string>();
  failWrites = false;

  localStorage = {
    getItem: (key: string): string | null => this.store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      if (this.failWrites) throw new Error("QuotaExceededError");
      this.store.set(key, value);
    },
    removeItem: (key: string): void => { this.store.delete(key); },
    clear: (): void => { this.store.clear(); },
  };
}

describe("normalizeWorkspaceBookmarks", () => {
  it("drops malformed rows and duplicates", () => {
    expect(normalizeWorkspaceBookmarks("nope")).toEqual([]);
    expect(normalizeWorkspaceBookmarks([
      null,
      { kind: "file", id: "a", addedAt: "2026-09-30T00:00:00.000Z" },
      { kind: "file", id: "a", addedAt: "2026-10-01T00:00:00.000Z" },
      { kind: "folder", id: "a", addedAt: "2026-09-29T00:00:00.000Z" },
      { kind: "workspace", id: "w" },
      { kind: "file", id: "" },
      { kind: "file", id: 5 },
      { kind: "file", id: "b" },
    ])).toEqual([
      { kind: "file", id: "a", addedAt: "2026-09-30T00:00:00.000Z" },
      { kind: "folder", id: "a", addedAt: "2026-09-29T00:00:00.000Z" },
      { kind: "file", id: "b", addedAt: "" },
    ]);
  });
});

describe("toggleBookmarkIn", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const existing: WorkspaceBookmark[] = [{ kind: "file", id: "old", addedAt: "2026-09-01T00:00:00.000Z" }];

  it("adds new bookmarks to the front without mutating the input", () => {
    const next = toggleBookmarkIn(existing, "folder", "f1", now);
    expect(next).toEqual([{ kind: "folder", id: "f1", addedAt: now.toISOString() }, ...existing]);
    expect(existing).toHaveLength(1);
  });

  it("removes a bookmark when it is toggled again, and keeps same-id items of the other kind", () => {
    const both = toggleBookmarkIn(existing, "folder", "old", now);
    expect(both.map((item) => workspaceBookmarkKey(item.kind, item.id))).toEqual(["folder:old", "file:old"]);
    expect(toggleBookmarkIn(both, "file", "old", now).map((item) => workspaceBookmarkKey(item.kind, item.id))).toEqual(["folder:old"]);
  });
});

describe("workspace bookmark store", () => {
  let fakeWindow: FakeWindow;
  // モジュール直下のスナップショットが別テストへ漏れないよう、毎回読み込み直す。
  let mod: typeof import("./workspace-bookmarks");

  beforeEach(async () => {
    fakeWindow = new FakeWindow();
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    mod = await import("./workspace-bookmarks");
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("starts empty and returns a stable snapshot between changes", () => {
    expect(mod.getWorkspaceBookmarks()).toEqual([]);
    expect(mod.getWorkspaceBookmarks()).toBe(mod.getWorkspaceBookmarks());
  });

  it("persists toggles so a reload sees the same bookmarks, newest first", async () => {
    mod.toggleWorkspaceBookmark("file", "a");
    mod.toggleWorkspaceBookmark("folder", "b");
    expect(mod.getWorkspaceBookmarks().map((item) => `${item.kind}:${item.id}`)).toEqual(["folder:b", "file:a"]);
    expect(JSON.parse(fakeWindow.localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(2);

    vi.resetModules();
    const reloaded = await import("./workspace-bookmarks");
    expect(reloaded.getWorkspaceBookmarks().map((item) => `${item.kind}:${item.id}`)).toEqual(["folder:b", "file:a"]);

    reloaded.toggleWorkspaceBookmark("folder", "b");
    expect(reloaded.getWorkspaceBookmarks().map((item) => `${item.kind}:${item.id}`)).toEqual(["file:a"]);
  });

  it("notifies subscribers when a bookmark changes", () => {
    const listener = vi.fn();
    fakeWindow.addEventListener("sigma-studio:workspace-bookmarks-change", listener);
    mod.toggleWorkspaceBookmark("file", "a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("recovers from corrupt stored JSON", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(mod.getWorkspaceBookmarks()).toEqual([]);
  });

  it("leaves the previous state when storage refuses the write", () => {
    mod.toggleWorkspaceBookmark("file", "a");
    fakeWindow.failWrites = true;
    expect(() => mod.toggleWorkspaceBookmark("file", "b")).not.toThrow();
    expect(mod.getWorkspaceBookmarks().map((item) => item.id)).toEqual(["a"]);
  });
});
