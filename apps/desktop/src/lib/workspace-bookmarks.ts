"use client";

import { useSyncExternalStore } from "react";

import { subscribeStoragePreference } from "./subscribe-storage-preference";

export type WorkspaceBookmarkKind = "file" | "folder";
export type WorkspaceBookmarkKey = `${WorkspaceBookmarkKind}:${string}`;

/**
 * 端末ごとのブックマーク。教材・フォルダの ID だけを持つ (名前や場所は表示のたびに一覧から引くので、
 * 改名・移動に追随する)。教材ファイルや台帳には書かない。
 */
export interface WorkspaceBookmark {
  kind: WorkspaceBookmarkKind;
  id: string;
  addedAt: string;
}

const STORAGE_KEY = "sigma-studio:workspace-bookmarks";
const CHANGE_EVENT = "sigma-studio:workspace-bookmarks-change";
/** 壊れた保存値や暴走で localStorage を膨らませないための上限。 */
const MAX_BOOKMARKS = 500;

const EMPTY: readonly WorkspaceBookmark[] = Object.freeze([]);

export function workspaceBookmarkKey(kind: WorkspaceBookmarkKind, id: string): WorkspaceBookmarkKey {
  return `${kind}:${id}`;
}

/** 保存値を読み直す。不正な行は落とし、同じ対象の重複は先に現れた方を残す。 */
export function normalizeWorkspaceBookmarks(raw: unknown): WorkspaceBookmark[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: WorkspaceBookmark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { kind, id, addedAt } = item as Partial<WorkspaceBookmark>;
    if ((kind !== "file" && kind !== "folder") || typeof id !== "string" || id.length === 0) continue;
    const key = workspaceBookmarkKey(kind, id);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind, id, addedAt: typeof addedAt === "string" ? addedAt : "" });
    if (result.length >= MAX_BOOKMARKS) break;
  }
  return result;
}

/** 追加していれば外し、無ければ先頭へ追加する (新しいものが上に並ぶ)。 */
export function toggleBookmarkIn(
  bookmarks: readonly WorkspaceBookmark[],
  kind: WorkspaceBookmarkKind,
  id: string,
  now: Date,
): WorkspaceBookmark[] {
  const exists = bookmarks.some((bookmark) => bookmark.kind === kind && bookmark.id === id);
  if (exists) return bookmarks.filter((bookmark) => !(bookmark.kind === kind && bookmark.id === id));
  return [{ kind, id, addedAt: now.toISOString() }, ...bookmarks].slice(0, MAX_BOOKMARKS);
}

function readBookmarks(): readonly WorkspaceBookmark[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeWorkspaceBookmarks(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

// useSyncExternalStore は変更が無い間 getSnapshot が同一参照を返すことを要求する。
// 変更 (このウィンドウの書き込み / 他ウィンドウの storage イベント) のときだけ捨てて読み直す。
let cachedSnapshot: readonly WorkspaceBookmark[] | null = null;

function getSnapshot(): readonly WorkspaceBookmark[] {
  cachedSnapshot ??= readBookmarks();
  return cachedSnapshot;
}

export function getWorkspaceBookmarks(): readonly WorkspaceBookmark[] {
  return getSnapshot();
}

function writeBookmarks(next: readonly WorkspaceBookmark[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 保存できない環境 (容量・無効化) では、その回のブックマークは残らない。画面は前の状態のまま。
    return;
  }
  cachedSnapshot = null;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function toggleWorkspaceBookmark(kind: WorkspaceBookmarkKind, id: string): void {
  writeBookmarks(toggleBookmarkIn(getSnapshot(), kind, id, new Date()));
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeStoragePreference(STORAGE_KEY, CHANGE_EVENT, () => { cachedSnapshot = null; }, onStoreChange);
}

export function useWorkspaceBookmarks(): readonly WorkspaceBookmark[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
