"use client";

import { ArrowLeft, ArrowRight, Download, Globe, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IconButton } from "@/components/ui/Button";
import {
  DEFAULT_SEARCH_ENGINE_ID,
  SEARCH_ENGINES,
  type DesktopBrowserAPI,
  type InAppBrowserState,
  type SearchEngineId,
} from "@/lib/browser/in-app-browser-contract";
import { useT } from "@/lib/i18n/react";
import { activeDownloadCount, displayAddress } from "../model/browser-format";
import { BrowserDownloads } from "./BrowserDownloads";
import { BrowserOmnibox, type BrowserOmniboxHandle } from "./BrowserOmnibox";
import { BrowserStartPage } from "./BrowserStartPage";
import styles from "./BrowserPanel.module.css";
import { useNativeOverlayPresent } from "./use-native-overlay";

const ENGINE_STORAGE_KEY = "sigma-studio:browser-engine";
/** 位置が変わってもサイズが変わらない配置換えを拾うための保険。通常はResizeObserverで足りる。 */
const VIEWPORT_POLL_MS = 250;
/** ページ面を隠す前に静止画を撮る、最大の待ち時間。 */
const SNAPSHOT_TIMEOUT_MS = 250;
/** ページ面を戻してから静止画を消すまでの猶予。 */
const SNAPSHOT_RELEASE_MS = 90;

function readEngine(): SearchEngineId {
  try {
    const stored = window.localStorage.getItem(ENGINE_STORAGE_KEY);
    return SEARCH_ENGINES.find((engine) => engine.id === stored)?.id ?? DEFAULT_SEARCH_ENGINE_ID;
  } catch {
    return DEFAULT_SEARCH_ENGINE_ID;
  }
}

export interface BrowserPanelProps {
  /** ドックが開いていて、ブラウザのページを見せているか。false の間はページ面を隠す。 */
  active: boolean;
  /** 見せているブラウザのタブ。タブの並びと切り替えはサイドバーのタブ列が持つ。 */
  tabId: string | null;
  bridge: DesktopBrowserAPI | null;
  state: InAppBrowserState;
  /** メインプロセスの状態を最初に受け取ったか。 */
  loaded: boolean;
}

/**
 * アプリ内ブラウザの面。ページ面そのものはメインプロセスのネイティブビューで、ここは
 * アドレス欄・ダウンロードと、ビューを置く場所の計測だけを担当する。
 */
export function BrowserPanel({ active, tabId, bridge, state, loaded }: BrowserPanelProps) {
  const t = useT("chrome");
  const tab = state.snapshot.tabs.find((candidate) => candidate.id === tabId) ?? null;
  const [engineId, setEngineId] = useState<SearchEngineId>(readEngine);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  // ページ面を隠した時点の静止画。null は「まだ隠していない」で、image が null でも隠してはいる。
  const [capture, setCapture] = useState<{ image: string | null } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const omniboxRef = useRef<BrowserOmniboxHandle | null>(null);
  const seenDownloadsRef = useRef<Set<string> | null>(null);
  const overlayPresent = useNativeOverlayPresent(active);

  const showsPage = active && Boolean(tab?.url) && !tab?.error;
  const suspended = active && (overlayPresent || suggestionsOpen || downloadsOpen);

  // 新しいタブは、すぐ入力できるようアドレス欄にフォーカスする。
  useEffect(() => {
    if (active && tab && !tab.url) omniboxRef.current?.focus();
  }, [active, tab]);

  useEffect(() => bridge?.onFocusAddress(() => omniboxRef.current?.focus()), [bridge]);

  // ダウンロードが始まったら一覧を開いて、保存が始まったことを見せる。
  useEffect(() => {
    if (!loaded) return;
    const seen = seenDownloadsRef.current;
    const ids = new Set(state.downloads.map((download) => download.id));
    seenDownloadsRef.current = ids;
    if (!seen) return;
    if (state.downloads.some((download) => !seen.has(download.id) && download.state === "progressing")) setDownloadsOpen(true);
  }, [loaded, state.downloads]);

  // ダイアログなどが開く間はページ面を隠す。隠すと撮れなくなるので、先に静止画を撮ってから隠す。
  const shouldHide = Boolean(bridge) && suspended && showsPage;
  useEffect(() => {
    if (!bridge || !shouldHide) return;
    let settled = false;
    const settle = (image: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      setCapture({ image });
    };
    const timeout = window.setTimeout(() => settle(null), SNAPSHOT_TIMEOUT_MS);
    bridge.captureSnapshot().then(settle, () => settle(null));
    return () => {
      settled = true;
      window.clearTimeout(timeout);
      // ページ面が戻るまでのわずかな間、静止画を残して画面が白く抜けないようにする。
      window.setTimeout(() => setCapture(null), SNAPSHOT_RELEASE_MS);
    };
  }, [bridge, shouldHide]);
  const pageHidden = shouldHide && capture !== null;
  const snapshot = capture?.image ?? null;

  // ページ面を置く場所を、メインプロセスへ伝え続ける。
  useEffect(() => {
    if (!bridge) return;
    const element = viewportRef.current;
    if (!active || !element) {
      void bridge.setViewport({ bounds: null, visible: false });
      return;
    }
    let last = "";
    const push = () => {
      const rect = element.getBoundingClientRect();
      const visible = showsPage && !pageHidden;
      const key = `${rect.left}|${rect.top}|${rect.width}|${rect.height}|${visible}`;
      if (key === last) return;
      last = key;
      void bridge.setViewport({ bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible });
    };
    push();
    const observer = new ResizeObserver(push);
    observer.observe(element);
    window.addEventListener("resize", push);
    const poll = window.setInterval(push, VIEWPORT_POLL_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", push);
      window.clearInterval(poll);
    };
  }, [active, bridge, pageHidden, showsPage, tab?.id]);

  useEffect(() => () => {
    void bridge?.setViewport({ bounds: null, visible: false });
  }, [bridge]);

  // サイトのアイコンを取りに行く手段。呼び出しごとに作り直さない (開始ページが取得をやり直すため)。
  const loadSiteIcon = useMemo(
    () => (bridge && typeof bridge.siteIcon === "function" ? (url: string) => bridge.siteIcon(url) : undefined),
    [bridge],
  );

  const chooseEngine = useCallback((id: SearchEngineId) => {
    setEngineId(id);
    try {
      window.localStorage.setItem(ENGINE_STORAGE_KEY, id);
    } catch {
      // 選択は今回の操作にだけ効く。
    }
  }, []);

  if (!bridge) {
    return <div className={styles.center}>{t("rightDock.browser.unavailable")}</div>;
  }

  const go = (input: string) => {
    if (!input.trim()) return;
    if (tab) void bridge.navigate(tab.id, input, engineId);
  };
  const runningDownloads = activeDownloadCount(state.downloads);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.navigation}>
          <IconButton label={t("rightDock.browser.back")} tone="ghost" size="sm" disabled={!tab?.canGoBack} onClick={() => tab && void bridge.goBack(tab.id)}>
            <ArrowLeft size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label={t("rightDock.browser.forward")} tone="ghost" size="sm" disabled={!tab?.canGoForward} onClick={() => tab && void bridge.goForward(tab.id)}>
            <ArrowRight size={15} aria-hidden="true" />
          </IconButton>
          {tab?.loading ? (
            <IconButton label={t("rightDock.browser.stop")} tone="ghost" size="sm" onClick={() => void bridge.stop(tab.id)}>
              <X size={15} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton label={t("rightDock.browser.reload")} tone="ghost" size="sm" disabled={!tab?.url} onClick={() => tab && void bridge.reload(tab.id)}>
              <RotateCw size={14} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <BrowserOmnibox
          bridge={bridge}
          engineId={engineId}
          display={displayAddress(tab?.url ?? "")}
          fullValue={tab?.url ?? ""}
          faviconDataUrl={tab?.faviconDataUrl ?? null}
          onSubmit={go}
          onSuggestionsOpenChange={setSuggestionsOpen}
          handleRef={omniboxRef}
        />
        <span className={styles.downloadButton} data-downloads-toggle="">
          <IconButton
            label={t("rightDock.browser.downloads")}
            tone="ghost"
            size="sm"
            aria-expanded={downloadsOpen}
            aria-pressed={downloadsOpen}
            onClick={() => setDownloadsOpen((open) => !open)}
          >
            <Download size={15} aria-hidden="true" />
          </IconButton>
          {runningDownloads > 0 && <span className={styles.downloadBadge} aria-hidden="true">{runningDownloads}</span>}
        </span>
        {tab?.loading && <span className={styles.progress} role="progressbar" aria-label={t("rightDock.browser.reload")} />}
        {downloadsOpen && <BrowserDownloads bridge={bridge} downloads={state.downloads} onClose={() => setDownloadsOpen(false)} />}
      </div>

      <div ref={viewportRef} className={styles.viewport} data-browser-viewport="">
        {tab && !tab.url && <BrowserStartPage engineId={engineId} onEngineChange={chooseEngine} onOpen={go} loadSiteIcon={loadSiteIcon} />}
        {tab?.error && (
          <div className={styles.center} role="alert">
            <Globe size={28} aria-hidden="true" color="var(--text-muted)" />
            <h2 className={styles.errorTitle}>{t("rightDock.browser.errorTitle")}</h2>
            <p className={styles.errorDetail}>{displayAddress(tab.url)}</p>
            <p className={styles.errorDetail}>{t("rightDock.browser.errorDetail", { description: tab.error.description, code: tab.error.code })}</p>
            <IconButton label={t("rightDock.browser.reload")} tone="secondary" onClick={() => void bridge.reload(tab.id)}>
              <RotateCw size={15} aria-hidden="true" />
            </IconButton>
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element -- ネイティブビューの静止画 (data URL) */}
        {snapshot && (pageHidden || capture) && <img className={styles.snapshot} src={snapshot} alt="" aria-hidden="true" />}
      </div>
    </div>
  );
}
