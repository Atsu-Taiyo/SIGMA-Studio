"use client";

import { useEffect, useState } from "react";

import type { DesktopBrowserAPI, InAppBrowserState } from "@/lib/browser/in-app-browser-contract";
import { getDesktopBridge } from "@/lib/desktop-bridge";

const EMPTY_STATE: InAppBrowserState = { snapshot: { tabs: [], activeTabId: null }, downloads: [] };

/**
 * メインプロセスのアプリ内ブラウザの状態 (タブ・ダウンロード) を購読する。
 * 状態の正本はメイン側にあるので、この画面を閉じても開いたタブは残る。
 */
export function useInAppBrowser(enabled: boolean): { bridge: DesktopBrowserAPI | null; state: InAppBrowserState; loaded: boolean } {
  const bridge = getDesktopBridge()?.browser ?? null;
  const [state, setState] = useState<InAppBrowserState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled || !bridge) return;
    let cancelled = false;
    void bridge.getState().then((initial) => {
      if (cancelled) return;
      if (initial) setState(initial);
      setLoaded(true);
    });
    const offState = bridge.onState((snapshot) => setState((current) => ({ ...current, snapshot })));
    const offDownloads = bridge.onDownloads((downloads) => setState((current) => ({ ...current, downloads })));
    return () => {
      cancelled = true;
      offState();
      offDownloads();
    };
  }, [bridge, enabled]);

  return { bridge, state, loaded };
}
