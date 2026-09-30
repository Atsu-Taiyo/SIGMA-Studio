// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_ENGINES } from "@/lib/browser/in-app-browser-contract";
import { setAppLocale } from "@/lib/i18n";
import { BrowserStartPage } from "./BrowserStartPage";

let root: Root;
let container: HTMLDivElement;

function render(overrides: Partial<Parameters<typeof BrowserStartPage>[0]> = {}) {
  const props = { engineId: "google" as const, onEngineChange: vi.fn(), onOpen: vi.fn(), ...overrides };
  act(() => root.render(<BrowserStartPage {...props} />));
  return props;
}

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

describe("BrowserStartPage", () => {
  it("offers the search engines as icon choices, not a dropdown", () => {
    render({ engineId: "bing" });
    expect(container.querySelector("select, [role='combobox'], [aria-haspopup]")).toBeNull();

    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-labelledby")).toBe("browser-engine-label");
    const radios = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(SEARCH_ENGINES.map((engine) => engine.label));
    expect(radios.every((radio) => radio.querySelector("svg"))).toBe(true);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
  });

  it("reports the chosen engine", () => {
    const props = render();
    const duck = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) => radio.textContent === "DuckDuckGo");
    act(() => duck!.click());
    expect(props.onEngineChange).toHaveBeenCalledWith("duckduckgo");
  });

  it("draws every quick link with a stand-in icon when no logo can be loaded", async () => {
    const loadSiteIcon = vi.fn(async () => null);
    render({ loadSiteIcon });
    await act(async () => {});
    const links = [...container.querySelectorAll<HTMLButtonElement>("button:not([role='radio'])")];
    expect(links.every((link) => link.querySelector("svg") && !link.querySelector("img"))).toBe(true);
    // 取得に失敗しても、開始ページは使える。
    expect(container.querySelectorAll('[role="radio"] svg')).toHaveLength(4);
  });

  it("draws every quick link with an icon and opens its site", () => {
    const props = render();
    const links = [...container.querySelectorAll<HTMLButtonElement>("button:not([role='radio'])")];
    expect(links).toHaveLength(6);
    expect(links.every((link) => link.querySelector("svg"))).toBe(true);
    act(() => links.find((link) => link.textContent === "Wikipedia")!.click());
    expect(props.onOpen).toHaveBeenCalledWith("https://ja.wikipedia.org");
  });

  // 取得できたロゴは、アプリを開いている間の使い回しに載る。他のテストへ持ち越さないよう、最後に置く。
  it("swaps in each site's own logo once it arrives, asking for every site once", async () => {
    const loadSiteIcon = vi.fn(async (url: string) => `data:image/png;base64,${btoa(url)}`);
    render({ loadSiteIcon });
    await act(async () => {});

    expect(loadSiteIcon).toHaveBeenCalledTimes(9);
    expect(new Set(loadSiteIcon.mock.calls.map(([url]) => url)).size).toBe(9);

    const links = [...container.querySelectorAll<HTMLButtonElement>("button:not([role='radio'])")];
    expect(links.every((link) => link.querySelector("img") && !link.querySelector("svg"))).toBe(true);
    const wikipedia = links.find((link) => link.textContent === "Wikipedia")!.querySelector("img");
    expect(wikipedia?.getAttribute("src")).toBe(`data:image/png;base64,${btoa("https://ja.wikipedia.org")}`);
    expect(wikipedia?.getAttribute("alt")).toBe("");

    const radios = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.every((radio) => radio.querySelector("img"))).toBe(true);
    // ロゴは名前に入らない。ラジオの名前はエンジン名のまま。
    expect(radios.map((radio) => radio.textContent)).toEqual(SEARCH_ENGINES.map((engine) => engine.label));
  });
});
