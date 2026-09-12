import { getDesktopRuntime } from "./desktop-runtime";
import { getBrowserRuntime } from "./browser/browser-runtime";
import type { AppRuntime, RuntimeTarget } from "./types";

/**
 * 教材の保存先を 1 つ返す。**必ず手に入る**。
 *
 * - Electron の preload bridge があればデスクトップ版 (ユーザーデータ配下の実ファイル)
 * - 無ければブラウザ版 (このブラウザの IndexedDB)
 *
 * desktop でしか意味を持たない操作 (MCP 提案、データフォルダを開く、AI 実行) は
 * ここではなく `getDesktopRuntime()` を使い、`null` を分岐すること。
 */
export function getAppRuntime(): AppRuntime {
  return getDesktopRuntime() ?? getBrowserRuntime();
}

export function getRuntimeTarget(): RuntimeTarget {
  return getAppRuntime().target;
}

/** 保存が次の起動まで残るか。ブラウザが IndexedDB を拒む時だけ false。 */
export function isPersistentRuntime(): boolean {
  const runtime = getAppRuntime();
  return runtime.capabilities.desktopStorage || runtime.capabilities.browserStorage;
}
