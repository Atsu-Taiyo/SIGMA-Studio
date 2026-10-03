"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { RightDockPeek } from "./RightDockPeek";
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
  /** サイドバーを開く。版履歴を閉じるなど、開く側の約束ごとを含む。閉じたまま内容を見せるカードが使う。 */
  onOpen?(): void;
  /** カードを出してよい場面か (読み込み中・版履歴の表示中などは出さない)。 */
  peekEnabled?: boolean;
  /** カードを差し込む場所 (コメントのカードの並びの先頭)。無ければ、固定位置に出す。 */
  peekHost?: HTMLElement | null;
  /** カードを差し込む並びが小さなアイコンだけのとき。 */
  peekCompact?: boolean;
}

/**
 * サイドバーの合成。ブラウザのタブはメインプロセスが正本なので、ここでその一覧を購読して
 * ページの並びへ映し (タブ列は1本)、ファイル・チャットの面は呼び出し側から受け取る。
 * 閉じている間にウェブのページが開いていれば、その一覧のカードも出す。
 */
export function RightDockHost({
  state, onStateChange, width, onResize, files, chat, onOpenChat, onCloseChat, onCollapse, onOpen, peekEnabled = false, peekHost = null, peekCompact = false,
}: RightDockHostProps) {
  const t = useT("chrome");
  const { bridge, state: browser, loaded } = useInAppBrowser(true);
  const { tabs, activeTabId } = browser.snapshot;
  // 自分で「ブラウザ」を選んだ直後は、増えたタブを Hub の場所へ迎え入れる。既に知っているタブの集合と比べて「増えた」を決める。
  const adoptRef = useRef(false);
  const knownTabIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  // カードを閉じたときのウェブページの顔ぶれ。ページが増減すれば、また出す。
  const [dismissedPeekKey, setDismissedPeekKey] = useState<string | null>(null);

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

  const peekItems = useMemo(() => items.filter((item) => item.kind !== "hub"), [items]);
  const peekKey = peekItems.filter((item) => item.kind === "browser").map((item) => item.id).join("\n");
  const showPeek = peekEnabled && !state.open && peekKey !== "" && dismissedPeekKey !== peekKey;

  // カードから開くときは、状態の遷移でページを見せたうえで、開く側の約束ごと (版履歴を閉じるなど) も済ませる。
  const openPeekPage = useCallback((id: string) => {
    select(id);
    onOpen?.();
  }, [onOpen, select]);
  const openPeekHub = useCallback(() => {
    newTab();
    onOpen?.();
  }, [newTab, onOpen]);

  const peekCard = showPeek ? (
    <RightDockPeek
      items={peekItems}
      onOpenPage={openPeekPage}
      onNewWebPage={openPeekHub}
      onShowAll={() => onOpen?.()}
      onDismiss={() => setDismissedPeekKey(peekKey)}
      docked={peekHost !== null}
      compact={peekHost !== null && peekCompact}
    />
  ) : null;

  return (
    <>
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
      {peekHost ? (peekCard && createPortal(peekCard, peekHost)) : peekCard}
    </>
  );
}
