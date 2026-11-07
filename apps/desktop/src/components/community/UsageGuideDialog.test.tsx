// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: Root;
let container: HTMLDivElement;
let component: typeof import("./UsageGuideDialog");
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
  component = await import("./UsageGuideDialog");
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
  await act(async () => { root.render(<component.UsageGuideDialog />); });
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
  expect(dialog()?.textContent).toContain("使い方を見て");
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


it("persists opt-out across new sessions and leaves the star invitation available", async () => {
  await mount();
  await advance(30_000);
  const link = dialog()!.querySelector("a")!;
  expect(link.href).toBe("https://chocoschools.com/sigma-studio/manual/");
  expect(link.rel).toBe("noopener noreferrer");
  expect(link.dataset.tone).toBe("primary");
  await act(async () => { Array.from(dialog()!.querySelectorAll("button")).find(b => b.textContent === "もう表示しない")!.click(); });
  expect(values.get(component.USAGE_GUIDE_DISMISSED_KEY)).toBe("1");
  await act(async () => root.unmount());
  vi.resetModules();
  component = await import("./UsageGuideDialog");
  root = createRoot(container);
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
  const { GitHubStarDialog } = await import("./GitHubStarDialog");
  await act(async () => root.render(<GitHubStarDialog />));
  window.dispatchEvent(new Event("sigma-studio:app-ready"));
  await advance(60_000);
  expect(dialog()?.textContent).toContain("GitHubのStar");
});

it("closes for this session only when viewing the guide", async () => {
  await mount();
  await advance(30_000);
  await act(async () => { const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    dialog()!.querySelector("a")!.addEventListener("click", e => e.preventDefault());
    dialog()!.querySelector("a")!.dispatchEvent(event); });
  expect(values.get(component.USAGE_GUIDE_DISMISSED_KEY)).toBeUndefined();
  expect(dialog()).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
  await act(async () => root.unmount());
  vi.resetModules();
  component = await import("./UsageGuideDialog");
  root = createRoot(container);
  await mount();
  await advance(30_000);
  expect(dialog()).not.toBeNull();
});

it("expires after seven days without resetting the introduction period", async () => {
  values.set(component.USAGE_GUIDE_FIRST_SEEN_KEY, String(Date.now() - component.USAGE_GUIDE_INTRO_PERIOD_MS));
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
});

it("translates live and closes when another window opts out", async () => {
  await mount();
  await advance(30_000);
  const { setAppLocale } = await import("@/lib/i18n/react");
  await act(async () => setAppLocale("en"));
  expect(dialog()?.textContent).toContain("View usage guide");
  expect(dialog()?.textContent).toContain("Don’t show again");
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: component.USAGE_GUIDE_DISMISSED_KEY, newValue: "1" })); });
  expect(dialog()).toBeNull();
});

it("fails closed when storage cannot preserve preferences", async () => {
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  await mount();
  await advance(70_000);
  expect(dialog()).toBeNull();
});

it("does not stack with the star invitation when both become eligible together", async () => {
  const { GitHubStarDialog } = await import("./GitHubStarDialog");
  await act(async () => root.render(<><component.UsageGuideDialog /><GitHubStarDialog /></>));
  window.dispatchEvent(new Event("sigma-studio:app-ready"));
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  await advance(70_000);
  input.blur();
  await advance(1000);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(dialog()?.textContent).toContain("使い方を見て");
});

it("honors an opt-out from another window before the invitation opens", async () => {
  await mount();
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: component.USAGE_GUIDE_DISMISSED_KEY, newValue: "1" })); });
  await advance(70_000);
  expect(dialog()).toBeNull();
});
