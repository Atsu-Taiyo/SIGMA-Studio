// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import type { RightDockTabItem } from "./RightDock";
import { RIGHT_DOCK_PEEK_WEB_LIMIT, RightDockPeek, type RightDockPeekProps } from "./RightDockPeek";

let root: Root;
let container: HTMLDivElement;

const FILES: RightDockTabItem = { id: "files", kind: "files", label: "ファイル" };
const page = (n: number, iconUrl: string | null = null): RightDockTabItem => ({ id: `tab-${n}`, kind: "browser", label: `page ${n}`, iconUrl });

function props(overrides: Partial<RightDockPeekProps> = {}): RightDockPeekProps {
  return {
    items: [page(1)],
    onOpenPage: vi.fn(),
    onNewWebPage: vi.fn(),
    onShowAll: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

const render = (next: RightDockPeekProps) => act(() => root.render(<RightDockPeek {...next} />));
const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button[data-kind]")];
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RightDockPeek", () => {
  it("names the sidebar's contents as a region and puts the web pages under their own heading", () => {
    render(props({ items: [FILES, page(1), page(2)] }));
    expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("サイドバーの内容");
    const web = container.querySelector("section")!;
    expect(web.querySelector("h3")?.textContent).toBe("ウェブ");
    expect([...web.querySelectorAll("button[data-kind]")].map((row) => row.textContent)).toEqual(["page 1", "page 2"]);
    expect(rows().map((row) => row.dataset.kind)).toEqual(["files", "browser", "browser"]);
  });

  it("shows a page's own favicon and falls back to an icon", () => {
    render(props({ items: [page(1, "data:image/png;base64,AA"), page(2)] }));
    const [withIcon, without] = rows();
    expect(withIcon.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(without.querySelector("img")).toBeNull();
    expect(without.querySelector("svg")).not.toBeNull();
  });

  it("reports the page that was picked, the plus, 'show all' and the dismiss button", () => {
    const next = props({ items: [FILES, page(1)] });
    render(next);
    act(() => rows()[1].click());
    expect(next.onOpenPage).toHaveBeenLastCalledWith("tab-1");
    act(() => rows()[0].click());
    expect(next.onOpenPage).toHaveBeenLastCalledWith("files");
    act(() => button("新しいタブを開く").click());
    expect(next.onNewWebPage).toHaveBeenCalledOnce();
    act(() => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "すべて表示")!.click());
    expect(next.onShowAll).toHaveBeenCalledOnce();
    act(() => button("閉じる").click());
    expect(next.onDismiss).toHaveBeenCalledOnce();
  });

  it("lists only the first few web pages and leaves the rest to 'show all'", () => {
    const many = Array.from({ length: RIGHT_DOCK_PEEK_WEB_LIMIT + 2 }, (_, index) => page(index + 1));
    render(props({ items: many }));
    expect(rows()).toHaveLength(RIGHT_DOCK_PEEK_WEB_LIMIT);
  });
});

describe("RightDockPeek compact", () => {
  it("is just a sidebar button carrying the number of web pages", () => {
    const next = props({ items: [FILES, page(1), page(2)], compact: true });
    render(next);
    expect(container.querySelector('[role="region"]')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-label")).toBe("サイドバーを開く: ウェブ 2件");
    expect(button.textContent).toBe("2");
    act(() => button.click());
    expect(next.onShowAll).toHaveBeenCalledOnce();
  });
});
