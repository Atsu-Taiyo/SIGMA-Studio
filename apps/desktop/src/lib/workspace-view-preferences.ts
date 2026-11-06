"use client";

import { subscribeStoragePreference } from "./subscribe-storage-preference";

import { useCallback, useSyncExternalStore } from "react";

export type WorkspaceSortKey = "name" | "updatedAt";
export type WorkspaceSortDirection = "asc" | "desc";

/**
 * 教材一覧はリスト表示だけ。以前のグリッド表示の選択 (`mode`) が保存に残っていても読まず、
 * 次に書くときに落とす。
 */
export interface WorkspaceViewPreference {
  sortKey: WorkspaceSortKey;
  sortDirection: WorkspaceSortDirection;
  /** 左サイドバーを細いアイコン列へ畳む。並び順と同じく次回起動時も維持する。 */
  sidebarCollapsed: boolean;
}

const STORAGE_KEY = "sigma-studio:workspace-view-preference";
const CHANGE_EVENT = "sigma-studio:workspace-view-preference-change";

const DEFAULT_PREFERENCE: WorkspaceViewPreference = {
  sortKey: "updatedAt",
  sortDirection: "desc",
  sidebarCollapsed: false,
};

function isWorkspaceSortKey(value: unknown): value is WorkspaceSortKey {
  return value === "name" || value === "updatedAt";
}

function isWorkspaceSortDirection(value: unknown): value is WorkspaceSortDirection {
  return value === "asc" || value === "desc";
}

function readWorkspaceViewPreference(): WorkspaceViewPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCE;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFERENCE;
    }
    const parsed = JSON.parse(raw) as Partial<WorkspaceViewPreference> | null;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_PREFERENCE;
    }
    return {
      sortKey: isWorkspaceSortKey(parsed.sortKey) ? parsed.sortKey : DEFAULT_PREFERENCE.sortKey,
      sortDirection: isWorkspaceSortDirection(parsed.sortDirection)
        ? parsed.sortDirection
        : DEFAULT_PREFERENCE.sortDirection,
      sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean"
        ? parsed.sidebarCollapsed
        : DEFAULT_PREFERENCE.sidebarCollapsed,
    };
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

// useSyncExternalStore requires getSnapshot() to return a referentially
// stable value between store changes: recomputing from localStorage on every
// call would hand back a brand-new object each render and infinite-loop.
// This module-level cache is that stable snapshot. It is invalidated (and
// lazily recomputed on the next read) only when the preference actually
// changes — locally via saveWorkspaceViewPreference, or in another tab via
// the storage event — never on a plain read.
let cachedSnapshot: WorkspaceViewPreference | null = null;

function getSnapshot(): WorkspaceViewPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCE;
  }
  if (!cachedSnapshot) {
    cachedSnapshot = readWorkspaceViewPreference();
  }
  return cachedSnapshot;
}

// This route is server-rendered by Next; a useState(() => get()) initializer
// would read localStorage during the client render and hydration-mismatch
// against the server-rendered markup. useSyncExternalStore's getServerSnapshot
// keeps the server and first client render identical (always the default).
function getServerSnapshot(): WorkspaceViewPreference {
  return DEFAULT_PREFERENCE;
}

export function getWorkspaceViewPreference(): WorkspaceViewPreference {
  return getSnapshot();
}

export function saveWorkspaceViewPreference(patch: Partial<WorkspaceViewPreference>): void {
  if (typeof window === "undefined") {
    return;
  }
  const next: WorkspaceViewPreference = { ...getWorkspaceViewPreference(), ...patch };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  cachedSnapshot = null;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeStoragePreference(STORAGE_KEY, CHANGE_EVENT, () => {
    cachedSnapshot = null;
  }, onStoreChange);
}

export function useWorkspaceViewPreference(): [
  WorkspaceViewPreference,
  (patch: Partial<WorkspaceViewPreference>) => void,
] {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const update = useCallback((patch: Partial<WorkspaceViewPreference>) => {
    saveWorkspaceViewPreference(patch);
  }, []);
  return [preference, update];
}
