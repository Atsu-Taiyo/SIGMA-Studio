"use client";

import { subscribeStoragePreference } from "./subscribe-storage-preference";

import { useCallback, useSyncExternalStore } from "react";

export type WorkspaceViewMode = "grid" | "list";
export type WorkspaceSortKey = "name" | "updatedAt";
export type WorkspaceSortDirection = "asc" | "desc";

export interface WorkspaceViewPreference {
  mode: WorkspaceViewMode;
  sortKey: WorkspaceSortKey;
  sortDirection: WorkspaceSortDirection;
}

const STORAGE_KEY = "sigma-studio:workspace-view-preference";
const CHANGE_EVENT = "sigma-studio:workspace-view-preference-change";

const DEFAULT_PREFERENCE: WorkspaceViewPreference = {
  mode: "grid",
  sortKey: "updatedAt",
  sortDirection: "desc",
};

function isWorkspaceViewMode(value: unknown): value is WorkspaceViewMode {
  return value === "grid" || value === "list";
}

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
      mode: isWorkspaceViewMode(parsed.mode) ? parsed.mode : DEFAULT_PREFERENCE.mode,
      sortKey: isWorkspaceSortKey(parsed.sortKey) ? parsed.sortKey : DEFAULT_PREFERENCE.sortKey,
      sortDirection: isWorkspaceSortDirection(parsed.sortDirection)
        ? parsed.sortDirection
        : DEFAULT_PREFERENCE.sortDirection,
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
