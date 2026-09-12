"use client";

import { subscribeStoragePreference } from "./subscribe-storage-preference";

import { useCallback, useSyncExternalStore } from "react";

export type UiLayoutMode = "docs" | "word";

export interface UiLayoutPreference {
  mode: UiLayoutMode;
  onboardingCompleted: boolean;
  /** Word風リボン本体を畳んでいるか。docs では読まれない。 */
  ribbonCollapsed: boolean;
}

const STORAGE_KEY = "sigma-studio:ui-layout-preference";
const CHANGE_EVENT = "sigma-studio:ui-layout-preference-change";

const DEFAULT_PREFERENCE: UiLayoutPreference = {
  mode: "docs",
  onboardingCompleted: false,
  ribbonCollapsed: false,
};

function isUiLayoutMode(value: unknown): value is UiLayoutMode {
  return value === "docs" || value === "word";
}

function readUiLayoutPreference(): UiLayoutPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCE;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFERENCE;
    }
    const parsed = JSON.parse(raw) as Partial<UiLayoutPreference> | null;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_PREFERENCE;
    }
    // Per-field type guards, not an all-or-nothing parse: a single corrupt
    // field must not throw away the rest of the user's choice.
    return {
      mode: isUiLayoutMode(parsed.mode) ? parsed.mode : DEFAULT_PREFERENCE.mode,
      onboardingCompleted:
        typeof parsed.onboardingCompleted === "boolean"
          ? parsed.onboardingCompleted
          : DEFAULT_PREFERENCE.onboardingCompleted,
      // 既存の保存値にこのフィールドは無い。per-field ガードなので既定 false で
      // 読めるだけでよく、移行コードは要らない。
      ribbonCollapsed:
        typeof parsed.ribbonCollapsed === "boolean"
          ? parsed.ribbonCollapsed
          : DEFAULT_PREFERENCE.ribbonCollapsed,
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
// changes — locally via saveUiLayoutPreference, or in another tab via the
// storage event — never on a plain read.
let cachedSnapshot: UiLayoutPreference | null = null;

function getSnapshot(): UiLayoutPreference {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCE;
  }
  if (!cachedSnapshot) {
    cachedSnapshot = readUiLayoutPreference();
  }
  return cachedSnapshot;
}

// This route is server-rendered by Next; a useState(() => get()) initializer
// would read localStorage during the client render and hydration-mismatch
// against the server-rendered markup. useSyncExternalStore's getServerSnapshot
// keeps the server and first client render identical (always the default).
function getServerSnapshot(): UiLayoutPreference {
  return DEFAULT_PREFERENCE;
}

export function getUiLayoutPreference(): UiLayoutPreference {
  return getSnapshot();
}

export function saveUiLayoutPreference(patch: Partial<UiLayoutPreference>): void {
  if (typeof window === "undefined") {
    return;
  }
  // Merge onto a fresh read, not onto cachedSnapshot: a window with no mounted
  // subscriber never sees the storage event, so its cache can be stale and a
  // partial save would write the stale field back over another window's change.
  const next: UiLayoutPreference = { ...readUiLayoutPreference(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    // Storage can reject the write (sandboxed iframe without same-origin,
    // blocked third-party storage, quota exhausted). Losing persistence is
    // survivable; letting it throw out of a React onClick is not.
    console.warn("Failed to persist the UI layout preference", error);
  }
  // Invalidate rather than adopt `next`, on the failed path too: the cache must
  // never claim a value storage does not hold, or the next partial save (which
  // merges onto a fresh read) would silently drop it.
  cachedSnapshot = null;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

// The subscribe half of the useSyncExternalStore triple. Exported (unlike its
// workspace-view-preferences twin) so the cross-tab / clear() invalidation is
// covered by unit tests instead of being left to manual verification.
export function subscribeUiLayoutPreference(onStoreChange: () => void): () => void {
  return subscribeStoragePreference(STORAGE_KEY, CHANGE_EVENT, () => {
    cachedSnapshot = null;
  }, onStoreChange);
}

export function useUiLayoutPreference(): [
  UiLayoutPreference,
  (patch: Partial<UiLayoutPreference>) => void,
] {
  const preference = useSyncExternalStore(
    subscribeUiLayoutPreference,
    getSnapshot,
    getServerSnapshot,
  );
  const update = useCallback((patch: Partial<UiLayoutPreference>) => {
    saveUiLayoutPreference(patch);
  }, []);
  return [preference, update];
}

/**
 * オンボーディングの表示条件。EditorShellのショートカット抑止と表示側で同じ判定を
 * 使うための純関数。
 */
export function shouldShowUiLayoutOnboarding(input: {
  onboardingCompleted: boolean;
  isDesktopApp: boolean;
  isEmbedded: boolean;
  appReady: boolean;
}): boolean {
  return (
    !input.onboardingCompleted && input.isDesktopApp && !input.isEmbedded && input.appReady
  );
}
