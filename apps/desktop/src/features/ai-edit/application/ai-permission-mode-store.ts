"use client";
import { useSyncExternalStore } from "react";
import {
  DEFAULT_AI_PERMISSION_MODE,
  parseAiPermissionMode,
  resolveAiPermissionMode,
  type AiPermissionMode,
} from "@/lib/ai/ai-permission-mode";
import { getDesktopBridge } from "@/lib/desktop-bridge";

// AIの権限 (読み取りのみ / 承認を求める / 自動で適用)。正本は main の settings.json で、
// 入力欄のピルと設定画面が同じ値を見る。AI 自身が設定を変えたとき (update_ai_settings) も
// main が知らせてくるので、そのたびに読み直す。

let mode: AiPermissionMode = DEFAULT_AI_PERMISSION_MODE;
let connected = false;
const listeners = new Set<() => void>();

function publish(next: AiPermissionMode): void {
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  const settings = getDesktopBridge()?.settings;
  if (!settings) return;
  try {
    const current = await settings.get();
    publish(parseAiPermissionMode(current.aiPermissionMode) ?? resolveAiPermissionMode(current));
  } catch {
    // 読めなければ、いまの値のまま。
  }
}

function connect(): void {
  const settings = getDesktopBridge()?.settings;
  if (connected || !settings) return;
  connected = true;
  settings.onAiSettingsChanged?.(() => void load());
  void load();
}

function subscribe(listener: () => void): () => void {
  connect();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): AiPermissionMode {
  return mode;
}

export function useAiPermissionMode(): AiPermissionMode {
  return useSyncExternalStore(subscribe, read, read);
}

/** この環境で権限を選べるか (デスクトップ版だけ。公開 Editor・Web には設定の口が無い)。 */
export function canSetAiPermissionMode(): boolean {
  return Boolean(getDesktopBridge()?.settings?.setAiPermissionMode);
}

function subscribeNothing(): () => void {
  return () => {};
}

function cannotSet(): boolean {
  return false;
}

/**
 * 権限を選べる環境かを、描画の中で読む。サーバー側の描画と最初の描画では false を返し、
 * その後で実際の値になる (描画の食い違いを起こさない)。
 */
export function useCanSetAiPermissionMode(): boolean {
  return useSyncExternalStore(subscribeNothing, canSetAiPermissionMode, cannotSet);
}

/** 権限を選ぶ。先に画面へ反映し、保存できなければ元へ戻して false を返す。 */
export async function setAiPermissionMode(next: AiPermissionMode): Promise<boolean> {
  const settings = getDesktopBridge()?.settings;
  if (!settings?.setAiPermissionMode) return false;
  const previous = mode;
  publish(next);
  try {
    const result = await settings.setAiPermissionMode(next);
    if (result.ok) return true;
  } catch {
    // 下で元へ戻す。
  }
  publish(previous);
  return false;
}

/** テスト用: 値と接続を初期状態へ戻す。 */
export function resetAiPermissionModeStoreForTests(): void {
  mode = DEFAULT_AI_PERMISSION_MODE;
  connected = false;
  listeners.clear();
}
