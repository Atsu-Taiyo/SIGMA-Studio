"use client";

import { useEffect, useState } from "react";

import { getExtensionBridge, normalizeExtensionMenu, type ExtensionMenuGroup } from "@/lib/extension-contracts";

const NO_GROUPS: ExtensionMenuGroup[] = [];

/**
 * メニューバーの「拡張機能」に出す内容を、ホストから受け取る。
 * ホストが返すのは、インストール済み・有効・今この本人に権限がある拡張機能だけ。
 * 何も無ければ空で、メニュー自体を出さない。ログイン状態や権限が変わるとホストが知らせてくる。
 */
export function useExtensionMenu(enabled: boolean): ExtensionMenuGroup[] {
  const [groups, setGroups] = useState<ExtensionMenuGroup[]>(NO_GROUPS);
  useEffect(() => {
    const bridge = enabled ? getExtensionBridge() : null;
    if (!bridge) return;
    let disposed = false;
    const load = () => {
      bridge.menu().then((next) => { if (!disposed) setGroups(normalizeExtensionMenu(next)); })
        .catch(() => { if (!disposed) setGroups(NO_GROUPS); });
    };
    load();
    const unsubscribe = bridge.onMenuChange((next) => { if (!disposed) setGroups(normalizeExtensionMenu(next)); });
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  // 無効のあいだは、前に受け取った内容が残っていても出さない。
  return enabled ? groups : NO_GROUPS;
}
