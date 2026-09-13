// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: Root;
let container: HTMLDivElement;
let component: typeof import("./GitHubStarDialog");
let values: Map<string, string>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  values = new Map([["sigma-studio:ui-locale", "ja"]]);
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  component = await import("./GitHubStarDialog");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const dialog = () => document.querySelector('[role="dialog"]');
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount(ready = true) {
  await act(async () => { root.render(<component.GitHubStarDialog />); });
  if (ready) window.dispatchEvent(new Event("sigma-studio:app-ready"));
}

it("waits for app readiness and startup completion before inviting", async () => {
  await mount(false);
  await advance(70_000);
  expect(dialog()).toBeNull();
  window.dispatchEvent(new Event("sigma-studio:app-ready"));
  const splash = document.createElement("div");
  splash.setAttribute("data-startup-splash", "");
  document.body.append(splash);
  await advance(70_000);
  expect(dialog()).toBeNull();
  splash.remove();
  await advance(1000);
  expect(dialog()?.textContent).toContain("GitHubのStar");
});

it("waits while input is focused, a drag is held, or another modal is open", async () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
  input.blur();
  window.dispatchEvent(new Event("pointerdown"));
  await advance(20_000);
  expect(dialog()).toBeNull();
  window.dispatchEvent(new Event("pointerup"));
  const other = document.createElement("div");
  other.setAttribute("data-modal-backdrop", "");
  document.body.append(other);
  await advance(20_000);
  expect(dialog()).toBeNull();
  other.remove();
  await advance(1000);
  expect(dialog()).not.toBeNull();
});

it("waits for composition and recent activity to finish", async () => {
  await mount();
  window.dispatchEvent(new Event("compositionstart"));
  await advance(70_000);
  expect(dialog()).toBeNull();
  window.dispatchEvent(new Event("compositionend"));
  await advance(9000);
  expect(dialog()).toBeNull();
  await advance(1000);
  expect(dialog()).not.toBeNull();
});

it("does not open in a background window", async () => {
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
});

it("persists dismissal and stays closed after remount", async () => {
  await mount();
  await advance(60_000);
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!.click(); });
  expect(values.get(component.STAR_PROMPT_DISMISSED_KEY)).toBe("1");
  expect(dialog()).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
});

it("honors a persisted dismissal in a fresh component session", async () => {
  values.set(component.STAR_PROMPT_DISMISSED_KEY, "1");
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
});

it("always closes when persistence fails and stays dismissed after remount", async () => {
  await mount();
  await advance(60_000);
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!.click(); });
  expect(dialog()).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
});

it("links to the public repository, translates live, and closes across windows", async () => {
  await mount();
  await advance(60_000);
  const { setAppLocale } = await import("@/lib/i18n/react");
  await act(async () => { setAppLocale("en"); });
  expect(dialog()?.textContent).toContain("Support Sigma Studio");
  const link = dialog()!.querySelector("a")!;
  expect(link.href).toBe("https://github.com/Atsu-Taiyo/SIGMA-Studio");
  expect(link.rel).toBe("noopener noreferrer");
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: component.STAR_PROMPT_DISMISSED_KEY, newValue: "1" })); });
  expect(dialog()).toBeNull();
});
