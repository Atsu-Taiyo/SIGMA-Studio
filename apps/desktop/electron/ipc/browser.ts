import { ipcMain } from "../trusted-ipc";
import { app, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

import type { InAppBrowserOpenRequest, InAppBrowserViewport } from "@/lib/browser/in-app-browser-contract";
import { InAppBrowser } from "../browser/in-app-browser";

export interface RegisterBrowserIpcDeps {
  getMainWindow(): BrowserWindow | null;
  confirmLink(url: string, signal: AbortSignal): Promise<boolean>;
  openSharedLink(url: string): boolean;
}

const MAX_TEXT_LENGTH = 4096;
const NOT_AVAILABLE = { ok: false as const, error: "unavailable" };

/**
 * アプリ内ブラウザのIPC。ページ面の操作はメインウィンドウの本体画面からだけ受け付ける
 * (ブラウザのページ自身は preload を持たず、そもそもここへ届かない)。
 */
export function registerBrowserIpc(deps: RegisterBrowserIpcDeps): { dispose(): void } {
  let browser: InAppBrowser | null = null;
  const get = () => {
    browser ??= new InAppBrowser({
      getWindow: deps.getMainWindow,
      confirmLink: deps.confirmLink,
      openSharedLink: deps.openSharedLink,
      send: (channel, payload) => {
        const window = deps.getMainWindow();
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
      },
    });
    return browser;
  };
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const window = deps.getMainWindow();
    return Boolean(window && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame);
  };
  const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
  const text = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
  const optionalText = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 64 ? value : undefined);

  ipcMain.handle("browser:get-state", (event) => (trusted(event) ? get().getState() : null));
  ipcMain.handle("browser:open-tab", (event, request: unknown) => {
    if (!trusted(event)) return NOT_AVAILABLE;
    const source = (typeof request === "object" && request !== null ? request : {}) as Partial<InAppBrowserOpenRequest>;
    return get().openTab({
      input: text(source.input) ? source.input : undefined,
      engineId: optionalText(source.engineId),
      activate: source.activate === false ? false : true,
    });
  });
  ipcMain.handle("browser:close-tab", (event, tabId: unknown) => {
    if (trusted(event) && id(tabId)) get().closeTab(tabId);
  });
  ipcMain.handle("browser:activate-tab", (event, tabId: unknown) => {
    if (trusted(event) && id(tabId)) get().activateTab(tabId);
  });
  ipcMain.handle("browser:navigate", (event, tabId: unknown, input: unknown, engineId: unknown) => {
    if (!trusted(event) || !id(tabId) || !text(input)) return NOT_AVAILABLE;
    return get().navigate(tabId, input, optionalText(engineId));
  });
  ipcMain.handle("browser:go-back", (event, tabId: unknown) => {
    if (trusted(event) && id(tabId)) get().goBack(tabId);
  });
  ipcMain.handle("browser:go-forward", (event, tabId: unknown) => {
    if (trusted(event) && id(tabId)) get().goForward(tabId);
  });
  ipcMain.handle("browser:reload", (event, tabId: unknown) => {
    if (trusted(event) && id(tabId)) get().reload(tabId);
  });
  ipcMain.handle("browser:stop", (event, tabId: unknown) => {
    if (trusted(event) && id(tabId)) get().stop(tabId);
  });
  ipcMain.handle("browser:set-viewport", (event, viewport: unknown) => {
    if (!trusted(event)) return;
    // 本体から何も開いていない状態で位置だけ届いても、ブラウザ(セッション)を起こさない。
    if (!browser && !(viewport as InAppBrowserViewport | null)?.visible) return;
    get().setViewport(parseViewport(viewport));
  });
  ipcMain.handle("browser:capture", (event) => (trusted(event) ? get().captureSnapshot() : null));
  ipcMain.handle("browser:suggest", (event, query: unknown, engineId: unknown) => (
    trusted(event) && text(query) ? get().suggest(query, optionalText(engineId)) : []
  ));
  ipcMain.handle("browser:site-icon", (event, url: unknown) => (
    trusted(event) && text(url) ? get().siteIcon(url) : null
  ));
  ipcMain.handle("browser:cancel-download", (event, downloadId: unknown) => {
    if (trusted(event) && id(downloadId)) get().cancelDownload(downloadId);
  });
  ipcMain.handle("browser:open-download", (event, downloadId: unknown) => (
    trusted(event) && id(downloadId) ? get().openDownload(downloadId) : { ok: false }
  ));
  ipcMain.handle("browser:reveal-download", (event, downloadId: unknown) => {
    if (trusted(event) && id(downloadId)) get().revealDownload(downloadId);
  });
  ipcMain.handle("browser:clear-downloads", (event) => {
    if (trusted(event)) get().clearDownloads();
  });

  const dispose = () => {
    browser?.dispose();
    browser = null;
  };
  app.once("before-quit", dispose);
  return { dispose };
}

function parseViewport(value: unknown): InAppBrowserViewport {
  const source = (typeof value === "object" && value !== null ? value : {}) as Partial<InAppBrowserViewport>;
  const bounds = source.bounds;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 100_000;
  const valid = bounds && finite(bounds.x) && finite(bounds.y) && finite(bounds.width) && finite(bounds.height);
  return { bounds: valid ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null, visible: source.visible === true };
}
