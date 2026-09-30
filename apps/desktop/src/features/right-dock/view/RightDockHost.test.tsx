// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBrowserAPI,
  InAppBrowserResult,
  InAppBrowserSnapshot,
  InAppBrowserTab,
} from "@/lib/browser/in-app-browser-contract";
import { setAppLocale } from "@/lib/i18n";
import {
  closeRightDock,
  INITIAL_RIGHT_DOCK_STATE,
  openRightDock,
  openRightDockTool,
  type RightDockState,
} from "../model/right-dock-state";
import { RightDockHost } from "./RightDockHost";

let root: Root;
let container: HTMLDivElement;
let latest: RightDockState;

/** メインプロセスのブラウザの代わり。タブの正本を持ち、変わるたびに状態を流す。 */
function createFakeBrowser() {
  let tabs: InAppBrowserTab[] = [];
  let activeTabId: string | null = null;
  let counter = 0;
  const listeners = new Set<(snapshot: InAppBrowserSnapshot) => void>();
  const emit = () => listeners.forEach((listener) => listener({ tabs: [...tabs], activeTabId }));
  const make = (url: string): InAppBrowserTab => ({
    id: `tab-${++counter}`, url, title: url ? `page ${counter}` : "", faviconDataUrl: null,
    loading: false, canGoBack: false, canGoForward: false, error: null,
  });
  const bridge = {
    getState: vi.fn(async () => ({ snapshot: { tabs: [...tabs], activeTabId }, downloads: [] })),
    openTab: vi.fn(async (request?: { input?: string }): Promise<InAppBrowserResult> => {
      if (tabs.length >= 2) return { ok: false, error: "タブは最大2つまでです" };
      const tab = make(request?.input ?? "");
      tabs = [...tabs, tab];
      activeTabId = tab.id;
      emit();
      return { ok: true, tabId: tab.id };
    }),
    closeTab: vi.fn(async (id: string) => {
      tabs = tabs.filter((tab) => tab.id !== id);
      if (activeTabId === id) activeTabId = tabs[0]?.id ?? null;
      emit();
    }),
    activateTab: vi.fn(async (id: string) => {
      activeTabId = id;
      emit();
    }),
    setViewport: vi.fn(async () => undefined),
    captureSnapshot: vi.fn(async () => null),
    siteIcon: vi.fn(async () => null),
    suggest: vi.fn(async () => []),
    onState: (handler: (snapshot: InAppBrowserSnapshot) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    onDownloads: () => () => undefined,
    onFocusAddress: () => () => undefined,
  };
  return { bridge, seed: (...urls: string[]) => { urls.forEach((url) => { const tab = make(url); tabs = [...tabs, tab]; activeTabId = tab.id; }); } };
}

function Harness({ initial, onOpenChat, onCloseChat }: { initial: RightDockState; onOpenChat(): void; onCloseChat(): void }) {
  const [state, setState] = useState(initial);
  useEffect(() => {
    latest = state;
  }, [state]);
  return (
    <RightDockHost
      state={state}
      onStateChange={setState}
      width={400}
      onResize={() => undefined}
      files={<div data-probe="files" />}
      chat={<div data-probe="chat" />}
      onOpenChat={onOpenChat}
      onCloseChat={onCloseChat}
      onCollapse={() => setState(closeRightDock)}
    />
  );
}

async function mount(initial: RightDockState, browser: ReturnType<typeof createFakeBrowser> | null, handlers = { onOpenChat: vi.fn(), onCloseChat: vi.fn() }) {
  (window as unknown as { desktopAPI?: unknown }).desktopAPI = browser ? { browser: browser.bridge as unknown as DesktopBrowserAPI } : undefined;
  await act(async () => root.render(<Harness initial={initial} {...handlers} />));
  await act(async () => {});
  return handlers;
}

const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const labels = () => tabs().map((tab) => tab.textContent);
const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const tool = (name: string) => container.querySelector<HTMLButtonElement>(`button[data-tool="${name}"]`)!;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1600 });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
});

describe("RightDockHost", () => {
  it("shows the hub first, and choosing files replaces the hub with the files page", async () => {
    await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), createFakeBrowser());
    expect(labels()).toEqual(["新しいタブ"]);
    await act(async () => tool("files").click());
    expect(labels()).toEqual(["ファイル"]);
    expect(container.querySelector('#right-dock-panel-files [data-probe="files"]')).not.toBeNull();
  });

  it("hands the side chat to the AI surface instead of opening it itself", async () => {
    const { onOpenChat } = await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), createFakeBrowser());
    await act(async () => tool("chat").click());
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(labels()).toEqual(["新しいタブ"]);
  });

  it("opens a browser tab from the hub in the hub's place, and each further tab joins the same strip", async () => {
    const browser = createFakeBrowser();
    await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), browser);
    await act(async () => tool("browser").click());
    expect(browser.bridge.openTab).toHaveBeenCalledWith({});
    expect(labels()).toEqual(["新しいページ"]);
    expect(latest.activeId).toBe("tab-1");

    await act(async () => byLabel("新しいタブを開く").click());
    expect(labels()).toEqual(["新しいページ", "新しいタブ"]);
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-tool="browser"]')!.click());
    expect(labels()).toEqual(["新しいページ", "新しいページ"]);
    expect(latest.activeId).toBe("tab-2");
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });

  it("opens a recommended site straight into a browser tab", async () => {
    const browser = createFakeBrowser();
    await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), browser);
    const wikipedia = [...container.querySelectorAll<HTMLButtonElement>("button:not([data-tool])")].find((button) => button.textContent === "Wikipedia")!;
    await act(async () => wikipedia.click());
    expect(browser.bridge.openTab).toHaveBeenCalledWith({ input: "https://ja.wikipedia.org" });
    expect(labels()).toEqual(["page 1"]);
  });

  it("keeps the hub and says why when the browser has no room for another tab", async () => {
    const browser = createFakeBrowser();
    browser.seed("https://a.example", "https://b.example");
    await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), browser);
    expect(labels()).toEqual(["新しいタブ", "page 1", "page 2"]);
    await act(async () => tool("browser").click());
    expect(labels()).toEqual(["新しいタブ", "page 1", "page 2"]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("タブは最大2つまでです");
  });

  it("closing a browser tab goes through the browser, then the page leaves the strip", async () => {
    const browser = createFakeBrowser();
    await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), browser);
    await act(async () => tool("browser").click());
    await act(async () => byLabel("タブを閉じる: 新しいページ").click());
    expect(browser.bridge.closeTab).toHaveBeenCalledWith("tab-1");
    // 最後のページが無くなったので、サイドバーごと閉じる。
    expect(latest).toEqual(INITIAL_RIGHT_DOCK_STATE);
  });

  it("switches the browser to the tab the user selects", async () => {
    const browser = createFakeBrowser();
    browser.seed("https://a.example", "https://b.example");
    await mount(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"), browser);
    expect(labels()).toEqual(["ファイル", "page 1", "page 2"]);
    await act(async () => tabs()[1].click());
    expect(latest.activeId).toBe("tab-1");
    expect(browser.bridge.activateTab).toHaveBeenCalledWith("tab-1");
  });

  it("closes files and hub tabs itself, and leaves the side chat to the AI surface", async () => {
    const handlers = await mount(openRightDockTool(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"), "chat"), createFakeBrowser());
    await act(async () => byLabel("タブを閉じる: サイドチャット").click());
    expect(handlers.onCloseChat).toHaveBeenCalledOnce();
    expect(labels()).toEqual(["ファイル", "サイドチャット"]);
    await act(async () => byLabel("タブを閉じる: ファイル").click());
    expect(labels()).toEqual(["サイドチャット"]);
  });

  it("selecting the side chat tab asks the AI surface to show it", async () => {
    const handlers = await mount(openRightDockTool(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"), "chat"), null);
    await act(async () => tabs()[1].click());
    expect(handlers.onOpenChat).toHaveBeenCalledOnce();
  });

  it("leaves the browser out of the hub when there is no in-app browser", async () => {
    await mount(openRightDock(INITIAL_RIGHT_DOCK_STATE), null);
    expect([...container.querySelectorAll<HTMLElement>("button[data-tool]")].map((button) => button.dataset.tool)).toEqual(["files", "chat"]);
  });

  it("restores tabs that are still open in the browser, without opening the dock", async () => {
    const browser = createFakeBrowser();
    browser.seed("https://a.example");
    await mount(INITIAL_RIGHT_DOCK_STATE, browser);
    expect(latest.open).toBe(false);
    expect(labels()).toEqual(["page 1"]);
  });
});
