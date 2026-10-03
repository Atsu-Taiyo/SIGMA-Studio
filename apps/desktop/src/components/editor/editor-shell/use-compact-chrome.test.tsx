// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMPACT_CHROME_MAX_WIDTH, useCompactChrome } from "./use-compact-chrome";

let root: Root;
let container: HTMLDivElement;
let observers: Array<{ callback: () => void; disconnected: boolean }>;
let headerWidth = 0;

function Shell() {
  const ref = useRef<HTMLDivElement>(null);
  useCompactChrome(ref, "docs");
  return (
    <div ref={ref} className="app-shell">
      <header className="editor-menubar" />
    </div>
  );
}

const shell = () => container.querySelector<HTMLElement>(".app-shell")!;
/** ウィンドウやサイドバーの幅が変わったことにする。 */
const resizeHeader = (width: number) => {
  headerWidth = width;
  act(() => observers.forEach((observer) => !observer.disconnected && observer.callback()));
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observers = [];
  headerWidth = 1000;
  globalThis.ResizeObserver = class {
    private readonly entry: { callback: () => void; disconnected: boolean };
    constructor(callback: () => void) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    disconnect() { this.entry.disconnected = true; }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("editor-menubar") ? headerWidth : 0; } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe("useCompactChrome", () => {
  it("marks the shell only while the title bar's column is narrower than the threshold", () => {
    act(() => root.render(<Shell />));
    expect(shell().dataset.chromeCompact).toBeUndefined();
    resizeHeader(COMPACT_CHROME_MAX_WIDTH - 1);
    expect(shell().dataset.chromeCompact).toBe("true");
    resizeHeader(COMPACT_CHROME_MAX_WIDTH);
    expect(shell().dataset.chromeCompact).toBeUndefined();
  });

  it("starts out marked when the column is already narrow, and clears the mark on unmount", () => {
    headerWidth = 600;
    act(() => root.render(<Shell />));
    const element = shell();
    expect(element.dataset.chromeCompact).toBe("true");
    act(() => root.unmount());
    expect(element.dataset.chromeCompact).toBeUndefined();
    root = createRoot(container);
  });
});
