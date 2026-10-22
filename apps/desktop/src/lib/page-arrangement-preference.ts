"use client";

import { subscribeStoragePreference } from "./subscribe-storage-preference";

import { useCallback, useSyncExternalStore } from "react";

/**
 * 編集画面のページの並び (1 列 / 2 ページずつ横に並べる)。
 *
 * 見た目だけの設定なので文書には書かず、端末ごとに覚える (次回起動時も維持する)。
 * ホワイトボードと印刷・PDF の面は常に 1 列で、この値を読まない。
 */
export type PageArrangementPreference = "single" | "spread";

const STORAGE_KEY = "sigma-studio:page-arrangement-preference";
const CHANGE_EVENT = "sigma-studio:page-arrangement-preference-change";
const DEFAULT_PREFERENCE: PageArrangementPreference = "single";

function isPageArrangementPreference(value: unknown): value is PageArrangementPreference {
  return value === "single" || value === "spread";
}

function readPageArrangementPreference(): PageArrangementPreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isPageArrangementPreference(raw) ? raw : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

let cachedSnapshot: PageArrangementPreference | null = null;

function getSnapshot(): PageArrangementPreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  cachedSnapshot ??= readPageArrangementPreference();
  return cachedSnapshot;
}

// SSR と最初のクライアント描画を揃える (localStorage を描画中に読むと hydration がずれる)。
function getServerSnapshot(): PageArrangementPreference {
  return DEFAULT_PREFERENCE;
}

export function getPageArrangementPreference(): PageArrangementPreference {
  return getSnapshot();
}

export function savePageArrangementPreference(value: PageArrangementPreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    // 保存できなくても今の画面の切り替えは効かせる (次回起動で 1 列に戻るだけ)。
    console.warn("Failed to persist the page arrangement preference", error);
  }
  cachedSnapshot = isPageArrangementPreference(value) ? value : null;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribePageArrangementPreference(onStoreChange: () => void): () => void {
  return subscribeStoragePreference(STORAGE_KEY, CHANGE_EVENT, () => {
    cachedSnapshot = null;
  }, onStoreChange);
}

export function usePageArrangementPreference(): [
  PageArrangementPreference,
  (value: PageArrangementPreference) => void,
] {
  const preference = useSyncExternalStore(subscribePageArrangementPreference, getSnapshot, getServerSnapshot);
  const update = useCallback((value: PageArrangementPreference) => {
    savePageArrangementPreference(value);
  }, []);
  return [preference, update];
}
