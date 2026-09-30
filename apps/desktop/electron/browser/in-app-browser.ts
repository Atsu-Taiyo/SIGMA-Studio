import { randomUUID } from "node:crypto";
import {
  app,
  clipboard,
  Menu,
  net,
  session as electronSession,
  shell,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";

import {
  IN_APP_BROWSER_MAX_TABS,
  type InAppBrowserOpenRequest,
  type InAppBrowserResult,
  type InAppBrowserSnapshot,
  type InAppBrowserState,
  type InAppBrowserTab,
  type InAppBrowserViewport,
} from "@/lib/browser/in-app-browser-contract";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { DownloadTracker } from "./download-tracker";
import { isBrowsableUrl, parseSuggestions, resolveOmniboxInput, searchUrl, suggestionEndpoint } from "./omnibox";
import { siteIconServiceUrl } from "./site-icon";

const te = createCurrentLocaleTranslator("error");

/** ログインやCookieを保つ専用パーティション。アプリ本体のセッションとは共有しない。 */
export const IN_APP_BROWSER_PARTITION = "persist:sigma-studio-browser";

const FAVICON_MAX_BYTES = 128 * 1024;
const SUGGEST_TIMEOUT_MS = 1500;
const SITE_ICON_TIMEOUT_MS = 4000;
const STATE_EMIT_DELAY_MS = 16;

export interface InAppBrowserOptions {
  getWindow(): BrowserWindow | null;
  /** レンダラへ通知する。ウィンドウが無いときは何もしない。 */
  send(channel: string, payload?: unknown): void;
}

interface TabRecord {
  view: WebContentsView;
  state: InAppBrowserTab;
}

/**
 * アプリ内ブラウザ。ページ自体はメインウィンドウの上に重ねた WebContentsView が描き、
 * レンダラは位置 (setViewport) と操作だけを送る。`<webview>` を使わないのは、それだと
 * 本体のレンダラで webviewTag を有効にしてCSP (frame-src 'none') を緩める必要があるため。
 * ページは sandbox・contextIsolation・preloadなしで、Node にも本体のIPCにも触れない。
 */
export class InAppBrowser {
  private readonly session: Session;
  private readonly downloads: DownloadTracker;
  private readonly tabs = new Map<string, TabRecord>();
  private readonly favicons = new Map<string, string | null>();
  /** 開始ページのタイル用。取得できたものだけを持ち、失敗は次に開いたときに取り直す。 */
  private readonly siteIcons = new Map<string, string>();
  private activeTabId: string | null = null;
  private viewport: InAppBrowserViewport = { bounds: null, visible: false };
  private attachedWindow: BrowserWindow | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: InAppBrowserOptions) {
    this.session = electronSession.fromPartition(IN_APP_BROWSER_PARTITION);
    this.hardenSession(this.session);
    this.downloads = new DownloadTracker({
      downloadsDir: () => app.getPath("downloads"),
      onChange: (downloads) => this.options.send("browser:downloads", downloads),
      onProgress: (fraction) => {
        const window = this.options.getWindow();
        if (window && !window.isDestroyed()) window.setProgressBar(fraction ?? -1);
      },
      onCompleted: (download) => {
        if (process.platform === "darwin" && download.savePath) app.dock?.downloadFinished(download.savePath);
      },
    });
    this.session.on("will-download", (_event, item) => {
      this.downloads.track(item);
    });
  }

  getState(): InAppBrowserState {
    return { snapshot: this.snapshot(), downloads: this.downloads.list() };
  }

  openTab(request: InAppBrowserOpenRequest = {}): InAppBrowserResult {
    if (this.tabs.size >= IN_APP_BROWSER_MAX_TABS) {
      return { ok: false, error: te("electron.browser.tabLimit", { count: IN_APP_BROWSER_MAX_TABS }) };
    }
    const resolution = request.input ? resolveOmniboxInput(request.input, request.engineId) : { kind: "empty" as const };
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    const id = randomUUID();
    const record: TabRecord = {
      view,
      state: {
        id,
        url: "",
        title: "",
        faviconDataUrl: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
      },
    };
    this.tabs.set(id, record);
    this.wireWebContents(record);
    if (request.activate !== false || this.activeTabId === null) this.activeTabId = id;
    if (resolution.kind !== "empty") this.load(record, resolution.url);
    this.applyViewport();
    this.scheduleEmit();
    return { ok: true, tabId: id };
  }

  closeTab(tabId: string): void {
    const record = this.tabs.get(tabId);
    if (!record) return;
    this.tabs.delete(tabId);
    this.detach(record);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining.at(-1) ?? null;
    }
    this.applyViewport();
    this.scheduleEmit();
  }

  activateTab(tabId: string): void {
    if (!this.tabs.has(tabId) || this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.applyViewport();
    this.scheduleEmit();
  }

  navigate(tabId: string, input: string, engineId?: string): InAppBrowserResult {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: te("electron.browser.unsupportedAddress") };
    const resolution = resolveOmniboxInput(input, engineId);
    if (resolution.kind === "empty") return { ok: false, error: te("electron.browser.unsupportedAddress") };
    this.load(record, resolution.url);
    this.applyViewport();
    return { ok: true, tabId };
  }

  goBack(tabId: string): void {
    const history = this.tabs.get(tabId)?.view.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  goForward(tabId: string): void {
    const history = this.tabs.get(tabId)?.view.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload(tabId: string): void {
    const record = this.tabs.get(tabId);
    if (!record || !record.state.url) return;
    // 読み込みに失敗したページは、履歴の現在位置ではなく開こうとしたURLをもう一度開く。
    if (record.state.error) this.load(record, record.state.url);
    else record.view.webContents.reload();
  }

  stop(tabId: string): void {
    this.tabs.get(tabId)?.view.webContents.stop();
  }

  setViewport(viewport: InAppBrowserViewport): void {
    this.viewport = viewport;
    this.applyViewport();
  }

  async captureSnapshot(): Promise<string | null> {
    const record = this.activeRecord();
    if (!record || !record.state.url || record.view.webContents.isDestroyed()) return null;
    try {
      const image = await record.view.webContents.capturePage();
      if (image.isEmpty()) return null;
      return `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`;
    } catch {
      return null;
    }
  }

  async suggest(query: string, engineId?: string): Promise<string[]> {
    const text = query.trim();
    if (!text || text.length > 200) return [];
    try {
      const response = await net.fetch(suggestionEndpoint(text, engineId), {
        credentials: "omit",
        signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      });
      return response.ok ? parseSuggestions(await response.json()) : [];
    } catch {
      return [];
    }
  }

  /**
   * 開始ページのタイルに出す、サイトのアイコン (data URL)。ブラウザのログイン状態 (Cookie) は
   * 取得先へ送らない。取得できない (オフライン・非対応の宛先) ときは null。
   */
  async siteIcon(pageUrl: string): Promise<string | null> {
    const url = siteIconServiceUrl(pageUrl);
    if (!url) return null;
    const cached = this.siteIcons.get(url);
    if (cached) return cached;
    try {
      const response = await net.fetch(url, { credentials: "omit", signal: AbortSignal.timeout(SITE_ICON_TIMEOUT_MS) });
      const dataUrl = await readImageDataUrl(response);
      if (dataUrl) this.siteIcons.set(url, dataUrl);
      return dataUrl;
    } catch {
      return null;
    }
  }

  cancelDownload(downloadId: string): void {
    this.downloads.cancel(downloadId);
  }

  async openDownload(downloadId: string): Promise<{ ok: boolean; error?: string }> {
    const savePath = this.downloads.completedPath(downloadId);
    if (!savePath) return { ok: false };
    const error = await shell.openPath(savePath);
    return error ? { ok: false, error } : { ok: true };
  }

  revealDownload(downloadId: string): void {
    const savePath = this.downloads.completedPath(downloadId);
    if (savePath) shell.showItemInFolder(savePath);
  }

  clearDownloads(): void {
    this.downloads.clearFinished();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.downloads.dispose();
    for (const record of this.tabs.values()) {
      this.detach(record);
      if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    }
    this.tabs.clear();
  }

  private activeRecord(): TabRecord | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  private snapshot(): InAppBrowserSnapshot {
    return {
      tabs: [...this.tabs.values()].map((record) => ({ ...record.state })),
      activeTabId: this.activeTabId,
    };
  }

  private load(record: TabRecord, url: string): void {
    if (!isBrowsableUrl(url)) return;
    record.state.url = url;
    record.state.error = null;
    record.state.loading = true;
    // 読み込み失敗は did-fail-load で状態へ入る。loadURL の reject (別の遷移に置き換わった等) は無視してよい。
    void record.view.webContents.loadURL(url).catch(() => undefined);
    this.scheduleEmit();
  }

  private hardenSession(target: Session): void {
    // ページからのカメラ・マイク・位置情報・通知などの許可要求はすべて断る。
    // クリップボードへの書き込み (「コピー」ボタン) だけは、ユーザー操作に伴うので許す。
    const allowed = (permission: string) => permission === "clipboard-sanitized-write";
    target.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
    target.setPermissionCheckHandler((_contents, permission) => allowed(permission));
    target.setDevicePermissionHandler(() => false);
    // 「Electron」や本アプリ名を名乗ると、ログインを拒むサイトがある。中身は同じ Chromium なので通常の Chrome として振る舞う。
    const appToken = new RegExp(` ${app.getName().replace(/[^A-Za-z0-9]/g, ".*")}/\\S+`, "i");
    target.setUserAgent(target.getUserAgent().replace(/ Electron\/\S+/, "").replace(appToken, ""));
  }

  private wireWebContents(record: TabRecord): void {
    const { view, state } = record;
    const contents = view.webContents;
    contents.setVisualZoomLevelLimits(1, 3).catch(() => undefined);

    const syncNavigation = () => {
      if (contents.isDestroyed()) return;
      const url = contents.getURL();
      // 読み込み前・失敗後の about:blank で、開こうとしたURLを消さない。
      if (url && url !== "about:blank") state.url = url;
      state.canGoBack = contents.navigationHistory.canGoBack();
      state.canGoForward = contents.navigationHistory.canGoForward();
      this.scheduleEmit();
    };

    contents.on("did-start-loading", () => {
      state.loading = true;
      this.scheduleEmit();
    });
    contents.on("did-stop-loading", () => {
      state.loading = false;
      syncNavigation();
    });
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        state.error = null;
        this.scheduleEmit();
      }
    });
    contents.on("did-navigate", () => {
      state.title = "";
      syncNavigation();
    });
    contents.on("did-navigate-in-page", syncNavigation);
    contents.on("page-title-updated", (_event, title) => {
      state.title = title;
      this.scheduleEmit();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      void this.resolveFavicon(favicons[0]).then((dataUrl) => {
        if (this.tabs.get(state.id) === record) {
          state.faviconDataUrl = dataUrl;
          this.scheduleEmit();
        }
      });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // -3 (ABORTED) は別ページへ移った・停止したときの通常の中断。
      if (!isMainFrame || errorCode === -3) return;
      state.loading = false;
      state.error = { code: errorCode, description: errorDescription };
      if (validatedUrl && isBrowsableUrl(validatedUrl)) state.url = validatedUrl;
      this.scheduleEmit();
    });
    contents.on("render-process-gone", (_event, details) => {
      state.loading = false;
      state.error = { code: -1000, description: details.reason };
      this.scheduleEmit();
    });

    // 別ウィンドウを開くリンク (target=_blank, window.open) は新しいタブにする。web以外は開かない。
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (isBrowsableUrl(url)) this.openTab({ input: url, activate: disposition !== "background-tab" });
      return { action: "deny" };
    });
    const guardNavigation = (event: { url: string; preventDefault(): void }) => {
      if (!isBrowsableUrl(event.url) && event.url !== "about:blank") event.preventDefault();
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);

    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const command = process.platform === "darwin" ? input.meta : input.control;
      if (!command || input.alt || input.shift) return;
      if (input.key.toLowerCase() === "l") {
        event.preventDefault();
        this.options.send("browser:focus-address");
      } else if (input.key === "[") {
        event.preventDefault();
        this.goBack(state.id);
      } else if (input.key === "]") {
        event.preventDefault();
        this.goForward(state.id);
      } else if (input.key.toLowerCase() === "r") {
        event.preventDefault();
        this.reload(state.id);
      }
    });
    contents.on("context-menu", (_event, params) => this.showContextMenu(record, params));
  }

  private showContextMenu(record: TabRecord, params: ContextMenuParams): void {
    const contents = record.view.webContents;
    const template: MenuItemConstructorOptions[] = [];
    const separator = () => {
      if (template.length > 0 && template.at(-1)?.type !== "separator") template.push({ type: "separator" });
    };
    const text = params.selectionText.trim();

    if (params.linkURL && isBrowsableUrl(params.linkURL)) {
      template.push(
        { label: te("electron.browser.menu.openLinkInNewTab"), click: () => this.openTab({ input: params.linkURL }) },
        { label: te("electron.browser.menu.copyLinkAddress"), click: () => clipboard.writeText(params.linkURL) },
        { label: te("electron.browser.menu.saveLink"), click: () => contents.downloadURL(params.linkURL) },
      );
      separator();
    }
    if (params.mediaType === "image" && params.srcURL && isBrowsableUrl(params.srcURL)) {
      template.push(
        { label: te("electron.browser.menu.saveImage"), click: () => contents.downloadURL(params.srcURL) },
        { label: te("electron.browser.menu.copyImage"), click: () => contents.copyImageAt(params.x, params.y) },
        { label: te("electron.browser.menu.copyImageAddress"), click: () => clipboard.writeText(params.srcURL) },
      );
      separator();
    }
    if (params.isEditable) {
      template.push(
        { label: te("electron.browser.menu.cut"), role: "cut", enabled: params.editFlags.canCut },
        { label: te("electron.browser.menu.copy"), role: "copy", enabled: params.editFlags.canCopy },
        { label: te("electron.browser.menu.paste"), role: "paste", enabled: params.editFlags.canPaste },
        { label: te("electron.browser.menu.selectAll"), role: "selectAll" },
      );
    } else if (text) {
      template.push({ label: te("electron.browser.menu.copy"), role: "copy" });
      const preview = text.length > 24 ? `${text.slice(0, 24)}…` : text;
      template.push({
        label: te("electron.browser.menu.searchSelection", { value: preview }),
        click: () => this.openTab({ input: searchUrl(text) }),
      });
    }
    if (!params.isEditable && !text && !params.linkURL) {
      separator();
      template.push(
        { label: te("electron.browser.menu.back"), enabled: contents.navigationHistory.canGoBack(), click: () => this.goBack(record.state.id) },
        { label: te("electron.browser.menu.forward"), enabled: contents.navigationHistory.canGoForward(), click: () => this.goForward(record.state.id) },
        { label: te("electron.browser.menu.reload"), click: () => this.reload(record.state.id) },
      );
    }
    if (!app.isPackaged) {
      separator();
      template.push({ label: te("electron.browser.menu.inspect"), click: () => contents.inspectElement(params.x, params.y) });
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: this.options.getWindow() ?? undefined });
  }

  private async resolveFavicon(url: string | undefined): Promise<string | null> {
    if (!url || !isBrowsableUrl(url)) return null;
    if (this.favicons.has(url)) return this.favicons.get(url) ?? null;
    let dataUrl: string | null = null;
    try {
      dataUrl = await readImageDataUrl(await this.session.fetch(url, { signal: AbortSignal.timeout(4000) }));
    } catch {
      dataUrl = null;
    }
    this.favicons.set(url, dataUrl);
    if (this.favicons.size > 200) this.favicons.delete(this.favicons.keys().next().value as string);
    return dataUrl;
  }

  /** メインウィンドウへ載せ替え、位置・表示を反映する。 */
  private applyViewport(): void {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    this.ensureAttached(window);
    const { bounds, visible } = this.viewport;
    const zoom = window.webContents.getZoomFactor();
    for (const record of this.tabs.values()) {
      const shown = Boolean(bounds && visible && record.state.url && record.state.id === this.activeTabId && !record.state.error);
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        record.view.setBounds({
          x: Math.round(bounds.x * zoom),
          y: Math.round(bounds.y * zoom),
          width: Math.max(1, Math.round(bounds.width * zoom)),
          height: Math.max(1, Math.round(bounds.height * zoom)),
        });
      }
      record.view.setVisible(shown && bounds !== null && bounds.width > 0 && bounds.height > 0);
    }
  }

  private ensureAttached(window: BrowserWindow): void {
    if (this.attachedWindow === window) {
      for (const record of this.tabs.values()) {
        if (!window.contentView.children.includes(record.view)) window.contentView.addChildView(record.view);
      }
      return;
    }
    if (this.attachedWindow && !this.attachedWindow.isDestroyed()) {
      for (const record of this.tabs.values()) this.attachedWindow.contentView.removeChildView(record.view);
    }
    this.attachedWindow = window;
    for (const record of this.tabs.values()) window.contentView.addChildView(record.view);
    // 本体の画面を読み込み直す間は、古い位置にページ面が残らないよう隠す。表示はレンダラが位置を送り直して復帰させる。
    window.webContents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.setViewport({ bounds: null, visible: false });
    });
    window.once("closed", () => {
      if (this.attachedWindow === window) this.attachedWindow = null;
    });
  }

  private detach(record: TabRecord): void {
    const window = this.attachedWindow;
    if (window && !window.isDestroyed() && window.contentView.children.includes(record.view)) {
      window.contentView.removeChildView(record.view);
    }
  }

  private scheduleEmit(): void {
    if (this.emitTimer || this.disposed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.options.send("browser:state", this.snapshot());
    }, STATE_EMIT_DELAY_MS);
  }
}

/** 画像の応答だけを、上限サイズ内で data URL にする。レンダラの CSP は外部画像を許さないので、data URL で渡す。 */
async function readImageDataUrl(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!response.ok || !type.startsWith("image/")) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length > 0 && bytes.length <= FAVICON_MAX_BYTES ? `data:${type};base64,${bytes.toString("base64")}` : null;
}
