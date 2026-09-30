"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useT } from "@/lib/i18n/react";
import { tabLabel } from "../model/browser-format";
import {
  activateRightDockPage,
  activeRightDockPage,
  closeRightDockPage,
  openRightDockHub,
  openRightDockTool,
  syncRightDockBrowserPages,
  type RightDockState,
  type RightDockTool,
} from "../model/right-dock-state";
import { BrowserPanel } from "./BrowserPanel";
import { RightDock, type RightDockTabItem } from "./RightDock";
import { RightDockHub } from "./RightDockHub";
import { useInAppBrowser } from "./use-in-app-browser";

export interface RightDockHostProps {
  state: RightDockState;
  onStateChange(update: (current: RightDockState) => RightDockState): void;
  width: number;
  onResize(width: number): void;
  files: ReactNode;
  chat: ReactNode;
  /** サイドチャットを開く (Hub で選んだとき・チャットのタブを選んだとき)。AI面の状態を持つ側が開く。 */
  onOpenChat(): void;
  /** チャットのタブの ×。AI面の閉じ方に揃える。 */
  onCloseChat(): void;
  /** 右上の ×。タブは残したままサイドバーだけを閉じる。 */
  onCollapse(): void;
}

/**
 * サイドバーの合成。ブラウザのタブはメインプロセスが正本なので、ここでその一覧を購読して
 * ページの並びへ映し (タブ列は1本)、ファイル・チャットの面は呼び出し側から受け取る。
 */
export function RightDockHost({
  state, onStateChange, width, onResize, files, chat, onOpenChat, onCloseChat, onCollapse,
}: RightDockHostProps) {
  const t = useT("chrome");
  const { bridge, state: browser, loaded } = useInAppBrowser(true);
  const { tabs, activeTabId } = browser.snapshot;
  // 自分で「ブラウザ」を選んだ直後は、増えたタブを Hub の場所へ迎え入れる。既に知っているタブの集合と比べて「増えた」を決める。
  const adoptRef = useRef(false);
  const knownTabIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) return;
    const tabIds = tabs.map((tab) => tab.id);
    const fresh = tabIds.some((id) => !knownTabIdsRef.current.has(id));
    const adopt = adoptRef.current && fresh;
    knownTabIdsRef.current = new Set(tabIds);
    if (adopt) adoptRef.current = false;
    onStateChange((current) => syncRightDockBrowserPages(current, { tabIds, activeTabId }, { adopt }));
  }, [activeTabId, loaded, onStateChange, tabs]);

  // 見せるブラウザのページは、メイン側のネイティブビューも同じタブに合わせる。
  const activePage = activeRightDockPage(state);
  const browserTabId = activePage?.kind === "browser" ? activePage.id : null;
  useEffect(() => {
    if (!bridge || !browserTabId || browserTabId === activeTabId) return;
    if (tabs.some((tab) => tab.id === browserTabId)) void bridge.activateTab(browserTabId);
  }, [activeTabId, bridge, browserTabId, tabs]);

  const items = useMemo<RightDockTabItem[]>(() => state.pages.map((page) => {
    if (page.kind !== "browser") return { id: page.id, kind: page.kind, label: t(`rightDock.tab.${page.kind}`) };
    const tab = tabs.find((candidate) => candidate.id === page.id);
    return {
      id: page.id,
      kind: page.kind,
      label: (tab && tabLabel(tab)) || t("rightDock.browser.newTabTitle"),
      iconUrl: tab?.faviconDataUrl ?? null,
    };
  }), [state.pages, tabs, t]);

  // サイトのアイコンを取りに行く手段。呼び出しごとに作り直さない (取得をやり直すため)。
  const loadSiteIcon = useMemo(
    () => (bridge && typeof bridge.siteIcon === "function" ? (url: string) => bridge.siteIcon(url) : undefined),
    [bridge],
  );

  const openBrowser = useCallback((input?: string) => {
    if (!bridge) return;
    setNotice(null);
    adoptRef.current = true;
    void bridge.openTab(input ? { input } : {}).then((result) => {
      if (result.ok) return;
      adoptRef.current = false;
      setNotice(result.error);
    });
  }, [bridge]);

  const choose = useCallback((tool: RightDockTool) => {
    if (tool === "browser") openBrowser();
    else if (tool === "chat") onOpenChat();
    else onStateChange((current) => openRightDockTool(current, tool));
  }, [onOpenChat, onStateChange, openBrowser]);

  const select = useCallback((id: string) => {
    if (state.pages.find((page) => page.id === id)?.kind === "chat") onOpenChat();
    else onStateChange((current) => activateRightDockPage(current, id));
  }, [onOpenChat, onStateChange, state.pages]);

  const closePage = useCallback((id: string) => {
    const kind = state.pages.find((page) => page.id === id)?.kind;
    // ブラウザのタブはメインが正本: 閉じると状態が届き、ページも外れる。
    if (kind === "browser") void bridge?.closeTab(id);
    else if (kind === "chat") onCloseChat();
    else onStateChange((current) => closeRightDockPage(current, id));
  }, [bridge, onCloseChat, onStateChange, state.pages]);

  const newTab = useCallback(() => {
    setNotice(null);
    onStateChange(openRightDockHub);
  }, [onStateChange]);

  return (
    <RightDock
      open={state.open}
      items={items}
      activeId={state.activeId}
      width={width}
      hub={(
        <RightDockHub
          browserAvailable={Boolean(bridge)}
          onChoose={choose}
          onOpenSite={openBrowser}
          loadSiteIcon={loadSiteIcon}
          notice={notice}
        />
      )}
      files={files}
      browser={<BrowserPanel active={state.open && browserTabId !== null} tabId={browserTabId} bridge={bridge} state={browser} loaded={loaded} />}
      chat={chat}
      onSelect={select}
      onClosePage={closePage}
      onNewTab={newTab}
      onCollapse={onCollapse}
      onResize={onResize}
    />
  );
}
