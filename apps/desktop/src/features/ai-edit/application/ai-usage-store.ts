"use client";
import { useSyncExternalStore } from "react";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { emptyAiUsageSnapshot, parseAiUsageSnapshot, type AiUsageSnapshot } from "@/lib/ai/ai-usage";
import { getDesktopBridge } from "@/lib/desktop-bridge";

// AIごとの利用枠。値は main が各 AI から受け取って覚えていて、変わるたびに知らせてくる。
// チャットの入力欄と AI設定の両方が同じ値を見るので、画面ごとに問い合わせず 1 か所に持つ。

let snapshot: AiUsageSnapshot = emptyAiUsageSnapshot();
let connected = false;
const listeners = new Set<() => void>();

function publish(next: unknown): void {
  snapshot = parseAiUsageSnapshot(next);
  for (const listener of listeners) listener();
}

function connect(): void {
  const bridge = getDesktopBridge()?.aiUsage;
  if (connected || !bridge) return;
  connected = true;
  bridge.onChanged(publish);
  void bridge.get().then(publish).catch(() => {});
}

function subscribe(listener: () => void): () => void {
  connect();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): AiUsageSnapshot {
  return snapshot;
}

/** いまの利用枠。最初に使われた時に main へつなぐ。 */
export function useAiUsage(): AiUsageSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * AI に問い合わせて読み直す (ChatGPT と内蔵AI)。利用者が使用状況を開いたときに呼ぶ。
 * Claude は実行中に届く値だけなので、ここでは変わらない。
 */
export async function refreshAiUsage(provider?: AiProvider): Promise<void> {
  const bridge = getDesktopBridge()?.aiUsage;
  if (!bridge) return;
  try {
    publish(await bridge.refresh(provider));
  } catch {
    // 読めなければ、覚えている値のまま。
  }
}

/**
 * main が覚えている値を読み直す (AI には問い合わせない)。main は、リセットの時刻を過ぎた窓を
 * 外して返すので、開いたままの画面が古い「上限に達しています」を出し続けない。
 */
export async function syncAiUsage(): Promise<void> {
  const bridge = getDesktopBridge()?.aiUsage;
  if (!bridge) return;
  try {
    publish(await bridge.get());
  } catch {
    // 読めなければ、いまの値のまま。
  }
}

/** テスト用: 値と接続を初期状態へ戻す。 */
export function resetAiUsageStoreForTests(): void {
  snapshot = emptyAiUsageSnapshot();
  connected = false;
  listeners.clear();
}
