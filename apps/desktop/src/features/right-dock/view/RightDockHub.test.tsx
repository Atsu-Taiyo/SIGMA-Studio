// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import { RightDockHub, type RightDockHubProps } from "./RightDockHub";

let root: Root;
let container: HTMLDivElement;

function render(overrides: Partial<RightDockHubProps> = {}) {
  const props: RightDockHubProps = { browserAvailable: true, onChoose: vi.fn(), onOpenSite: vi.fn(), ...overrides };
  act(() => root.render(<RightDockHub {...props} />));
  return props;
}

const tools = () => [...container.querySelectorAll<HTMLButtonElement>("button[data-tool]")];

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

describe("RightDockHub", () => {
  it("offers files, the browser and the side chat, in that order, each with an icon", () => {
    render();
    expect(tools().map((tool) => tool.textContent)).toEqual(["ファイル", "ブラウザ", "サイドチャット"]);
    expect(tools().every((tool) => tool.querySelector("svg"))).toBe(true);
  });

  it("reports which tool was chosen", () => {
    const props = render();
    act(() => tools()[1].click());
    expect(props.onChoose).toHaveBeenCalledWith("browser");
    act(() => tools()[2].click());
    expect(props.onChoose).toHaveBeenLastCalledWith("chat");
  });

  it("recommends sites that open in the browser", () => {
    const props = render();
    const sites = [...container.querySelectorAll<HTMLButtonElement>("button:not([data-tool])")];
    expect(sites.map((site) => site.textContent)).toContain("Wikipedia");
    act(() => sites.find((site) => site.textContent === "Wikipedia")!.click());
    expect(props.onOpenSite).toHaveBeenCalledWith("https://ja.wikipedia.org");
  });

  it("leaves out the browser and the sites where the browser cannot run", () => {
    render({ browserAvailable: false });
    expect(tools().map((tool) => tool.textContent)).toEqual(["ファイル", "サイドチャット"]);
    expect(container.querySelectorAll("button:not([data-tool])")).toHaveLength(0);
  });

  it("says why a choice could not be made", () => {
    render({ notice: "タブは最大8つまでです" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("タブは最大8つまでです");
  });
});
