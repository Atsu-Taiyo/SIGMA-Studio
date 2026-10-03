// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import { RightDock, RightDockToggle, type RightDockProps, type RightDockTabItem } from "./RightDock";

let root: Root;
let container: HTMLDivElement;

const FILES: RightDockTabItem = { id: "files", kind: "files", label: "ファイル" };
const CHAT: RightDockTabItem = { id: "chat", kind: "chat", label: "サイドチャット" };
const HUB: RightDockTabItem = { id: "hub", kind: "hub", label: "新しいタブ" };
const PAGE: RightDockTabItem = { id: "tab-1", kind: "browser", label: "京大化学", iconUrl: "data:image/png;base64,AA" };

function props(overrides: Partial<RightDockProps> = {}): RightDockProps {
  return {
    open: true,
    items: [FILES, PAGE, CHAT],
    activeId: "files",
    width: 400,
    hub: <div data-probe="hub" />,
    files: <div data-probe="files" />,
    browser: <div data-probe="browser" />,
    chat: <div data-probe="chat" />,
    onSelect: vi.fn(),
    onClosePage: vi.fn(),
    onNewTab: vi.fn(),
    onCollapse: vi.fn(),
    onResize: vi.fn(),
    ...overrides,
  };
}

function render(next: RightDockProps) {
  act(() => root.render(<RightDock {...next} />));
}

const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1600 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RightDock tab strip", () => {
  it("lists only the open pages in one tab list and marks the current one selected", () => {
    render(props({ activeId: "tab-1" }));
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(tabs().map((tab) => tab.textContent)).toEqual(["ファイル", "京大化学", "サイドチャット"]);
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("does not put a fixed set of tabs in front of the user before anything is opened", () => {
    render(props({ items: [HUB], activeId: "hub" }));
    expect(tabs().map((tab) => tab.textContent)).toEqual(["新しいタブ"]);
  });

  it("shows a page's own favicon and falls back to an icon", () => {
    render(props({ items: [PAGE, { ...PAGE, id: "tab-2", iconUrl: null }], activeId: "tab-1" }));
    const [withIcon, without] = tabs();
    expect(withIcon.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(without.querySelector("img")).toBeNull();
    expect(without.querySelector("svg")).not.toBeNull();
  });

  it("selects by click and with the arrow, Home and End keys", () => {
    const next = props({ activeId: "files" });
    render(next);
    act(() => tabs()[2].click());
    expect(next.onSelect).toHaveBeenLastCalledWith("chat");
    const key = (index: number, name: string) =>
      act(() => tabs()[index].dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    key(0, "ArrowRight");
    expect(next.onSelect).toHaveBeenLastCalledWith("tab-1");
    key(0, "ArrowLeft");
    expect(next.onSelect).toHaveBeenLastCalledWith("chat");
    key(1, "End");
    expect(next.onSelect).toHaveBeenLastCalledWith("chat");
    key(2, "Home");
    expect(next.onSelect).toHaveBeenLastCalledWith("files");
  });

  it("closes a tab with a middle click, as browser tabs do", () => {
    const next = props();
    render(next);
    act(() => tabs()[1].dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })));
    expect(next.onClosePage).toHaveBeenCalledWith("tab-1");
    act(() => tabs()[0].dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true })));
    expect(next.onClosePage).toHaveBeenCalledTimes(1);
  });

  it("opens a new tab with the plus button, closes a tab from its ×, and collapses from the header", () => {
    const next = props();
    render(next);
    act(() => button("新しいタブを開く").click());
    expect(next.onNewTab).toHaveBeenCalledOnce();
    act(() => button("タブを閉じる: 京大化学").click());
    expect(next.onClosePage).toHaveBeenCalledWith("tab-1");
    act(() => button("サイドバーを閉じる").click());
    expect(next.onCollapse).toHaveBeenCalledOnce();
  });
});

describe("RightDock panels", () => {
  it("shows only the panel of the viewed page's kind", () => {
    render(props({ activeId: "tab-1" }));
    const hidden = (kind: string) => container.querySelector<HTMLElement>(`#right-dock-panel-${kind}`)!.hidden;
    expect(hidden("browser")).toBe(false);
    expect(hidden("files")).toBe(true);
    expect(hidden("chat")).toBe(true);
    expect(container.querySelector("#right-dock-panel-browser")?.getAttribute("aria-labelledby")).toBe("right-dock-tab-tab-1");
  });

  it("mounts files and the browser only while a page for them is open, and the hub only while it is viewed", () => {
    render(props({ items: [HUB, CHAT], activeId: "chat" }));
    expect(container.querySelector('[data-probe="hub"]')).toBeNull();
    expect(container.querySelector('[data-probe="files"]')).toBeNull();
    expect(container.querySelector('[data-probe="browser"]')).toBeNull();
    render(props({ items: [HUB, FILES, PAGE], activeId: "hub" }));
    expect(container.querySelector('[data-probe="hub"]')).not.toBeNull();
    // 見ていなくても、開いているページの中身 (検索語・開いたタブ) は保つ。
    expect(container.querySelector('[data-probe="files"]')).not.toBeNull();
    expect(container.querySelector('[data-probe="browser"]')).not.toBeNull();
    render(props({ items: [FILES, PAGE], activeId: "files" }));
    expect(container.querySelector('[data-probe="hub"]')).toBeNull();
  });

  it("always keeps the chat element mounted so a running AI session is not lost", () => {
    render(props({ items: [FILES], activeId: "files" }));
    expect(container.querySelector('#right-dock-panel-chat [data-probe="chat"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>("#right-dock-panel-chat")!.hidden).toBe(true);
  });
});

describe("RightDock frame", () => {
  it("hides itself from the layout and assistive tech while closed", () => {
    render(props({ open: false }));
    const dock = container.querySelector<HTMLElement>("[data-right-dock]")!;
    expect(dock.classList.contains("is-hidden")).toBe(true);
    expect(dock.getAttribute("aria-hidden")).toBe("true");
  });

  it("resizes from the keyboard within the allowed range", () => {
    const next = props({ width: 400 });
    render(next);
    const handle = container.querySelector<HTMLElement>('button[aria-label="サイドバーの幅を変更"]')!;
    act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(next.onResize).toHaveBeenLastCalledWith(416);
    act(() => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(next.onResize).toHaveBeenLastCalledWith(400);
  });
});

describe("RightDockToggle", () => {
  it("opens the dock from the title bar", () => {
    const onOpen = vi.fn();
    act(() => root.render(<RightDockToggle onOpen={onOpen} />));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="サイドバーを開く"]')!.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
