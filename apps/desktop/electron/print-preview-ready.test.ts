// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printPreviewReadyScript } from "./print-preview-ready";

const wait = (requirePageWindows = false) => window.eval(printPreviewReadyScript({
  timeoutMs: 65_000, requirePageWindows,
  documentLoadFailed: "load failed", preparationTimedOut: "preparation failed",
})) as Promise<{ pageCount: number }>;

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; });
afterEach(() => { Reflect.deleteProperty(document, "fonts"); vi.useRealTimers(); });

function surface(state: string, stage = "assets") {
  document.body.innerHTML = `<div class="paged-surface" data-paged-surface-state="${state}"
    data-paged-surface-stage="${stage}" data-paged-surface-page-count="51" data-paged-surface-revision="1"></div>`;
  return document.querySelector<HTMLElement>(".paged-surface")!;
}

describe("preview readiness used by canonical measurements", () => {
  it("reports terminal failure with its stage immediately and cancels polling", async () => {
    surface("stalled", "assets");
    const result = expect(wait()).rejects.toThrow("stage: assets; stalled");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline even when fonts never finish and removes its frame", async () => {
    surface("ready");
    Object.defineProperty(document, "fonts", { configurable: true, value: { status: "loading", ready: new Promise(() => {}) } });
    const result = expect(wait()).rejects.toThrow("stage: assets");
    await vi.advanceTimersByTimeAsync(65_001);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const requirePageWindows of [false, true]) {
    it(`waits for delayed readiness and the current stable revision (windows=${requirePageWindows})`, async () => {
      const stack = surface("pending");
      for (let i = 0; i < 51; i++) stack.append(Object.assign(document.createElement("div"), { className: "paged-surface-page" }));
      let resolved = false;
      const result = wait(requirePageWindows).then(value => { resolved = true; return value; });
      await vi.advanceTimersByTimeAsync(16_000);
      expect(resolved).toBe(false);
      stack.setAttribute("data-paged-surface-state", "ready");
      await vi.advanceTimersByTimeAsync(60);
      stack.setAttribute("data-paged-surface-state", "pending");
      await vi.advanceTimersByTimeAsync(150);
      expect(resolved).toBe(false);
      stack.setAttribute("data-paged-surface-state", "ready");
      stack.setAttribute("data-paged-surface-revision", "2");
      await vi.advanceTimersByTimeAsync(300);
      expect(await result).toMatchObject({ pageCount: 51, renderedPageCount: 51 });
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});
