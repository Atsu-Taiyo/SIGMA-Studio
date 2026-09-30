/**
 * アプリ内ブラウザの、メインプロセス (electron/browser) とレンダラの共有契約。
 * 型と定数だけを置き、Electron にも React にも依存しない。
 *
 * ページの描画はメインプロセスの WebContentsView が担う。レンダラは操作 (URL入力・戻る・
 * タブ) と表示位置を伝え、状態 (タブ一覧・ダウンロード) を購読するだけで、ページの内容には
 * 一切触れない。
 */

export const IN_APP_BROWSER_MAX_TABS = 8;

/** 検索エンジンの選択肢。検索URLと候補の取得先はメインプロセス側 (electron/browser/omnibox.ts) が持つ。 */
export const SEARCH_ENGINES = [
  { id: "google", label: "Google" },
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "bing", label: "Bing" },
  { id: "yahoo-japan", label: "Yahoo! JAPAN" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];
export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = "google";

export interface InAppBrowserTabError {
  code: number;
  description: string;
}

export interface InAppBrowserTab {
  id: string;
  /** 空文字は「新しいタブ」(まだ何も開いていない)。 */
  url: string;
  title: string;
  /** メイン側で取得して data URL にしたもの。レンダラの CSP は外部画像を許さない。 */
  faviconDataUrl: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: InAppBrowserTabError | null;
}

export interface InAppBrowserSnapshot {
  tabs: InAppBrowserTab[];
  activeTabId: string | null;
}

export type InAppBrowserDownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export interface InAppBrowserDownload {
  id: string;
  filename: string;
  sourceUrl: string;
  /** 保存先。まだ決まっていない/失敗したときは null。 */
  savePath: string | null;
  state: InAppBrowserDownloadState;
  receivedBytes: number;
  /** 0 は不明。 */
  totalBytes: number;
  startedAt: number;
}

export interface InAppBrowserState {
  snapshot: InAppBrowserSnapshot;
  downloads: InAppBrowserDownload[];
}

export interface InAppBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 表示位置。null か visible=false のときページ面は隠れる。 */
export interface InAppBrowserViewport {
  bounds: InAppBrowserBounds | null;
  visible: boolean;
}

export interface InAppBrowserOpenRequest {
  /** URLか検索語。省略すると「新しいタブ」。 */
  input?: string;
  engineId?: string;
  activate?: boolean;
}

export type InAppBrowserResult = { ok: true; tabId: string } | { ok: false; error: string };

export interface DesktopBrowserAPI {
  getState(): Promise<InAppBrowserState>;
  openTab(request?: InAppBrowserOpenRequest): Promise<InAppBrowserResult>;
  closeTab(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  navigate(tabId: string, input: string, engineId?: string): Promise<InAppBrowserResult>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  setViewport(viewport: InAppBrowserViewport): Promise<void>;
  /** ダイアログなどでページ面を一時的に隠す間に、DOM側へ出す静止画 (data URL)。 */
  captureSnapshot(): Promise<string | null>;
  suggest(query: string, engineId?: string): Promise<string[]>;
  /** 開始ページのタイルに出す、サイトのアイコン (data URL)。取得できなければ null。 */
  siteIcon(url: string): Promise<string | null>;
  cancelDownload(downloadId: string): Promise<void>;
  openDownload(downloadId: string): Promise<{ ok: boolean; error?: string }>;
  revealDownload(downloadId: string): Promise<void>;
  clearDownloads(): Promise<void>;
  onState(handler: (snapshot: InAppBrowserSnapshot) => void): () => void;
  onDownloads(handler: (downloads: InAppBrowserDownload[]) => void): () => void;
  /** ページ面にフォーカスがある間の ⌘L / Ctrl+L。アドレス欄へ戻す。 */
  onFocusAddress(handler: () => void): () => void;
}
