// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForSpaceAfterCommitPaint } from "./space-after-commit-paint";
import { SpaceAfterDragSession, type SpaceAfterCommit } from "./space-after-drag-session";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function harness() {
  const canvas = document.createElement("div");
  canvas.innerHTML = '<div class="page-flow"><p data-sigma-doc-id="body" style="padding-bottom: 0px">body</p></div>';
  document.body.append(canvas);
  const block = canvas.querySelector("p")!;
  const flow = canvas.firstElementChild as HTMLElement;
  const session = new SpaceAfterDragSession();
  const commit: SpaceAfterCommit = { blockId: "body", px: 24, deltaPx: 24, bottomBefore: 100 };
  session.beginCommit(commit);
  const frames = new Map<number, FrameRequestCallback>();
  const timeouts = new Map<number, () => void>();
  const observers: Array<{ check: () => void; disconnected: boolean; options?: MutationObserverInit; target?: Node }> = [];
  let sequence = 0;
  const browserWindow: Window = window;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => { const id = ++sequence; frames.set(id, fn); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  vi.spyOn(browserWindow, "setTimeout").mockImplementation((fn, delay) => {
    expect(delay).toBe(1000);
    const id = ++sequence;
    timeouts.set(id, () => { if (typeof fn === "function") fn(); });
    return id;
  });
  vi.spyOn(browserWindow, "clearTimeout").mockImplementation((id) => { if (id !== undefined) timeouts.delete(id); });
  vi.stubGlobal("MutationObserver", class {
    private entry: (typeof observers)[number];
    constructor(check: () => void) { this.entry = { check, disconnected: false }; observers.push(this.entry); }
    observe(target: Node, options: MutationObserverInit) { this.entry.target = target; this.entry.options = options; }
    disconnect() { this.entry.disconnected = true; }
  });
  const onFinished = vi.fn<(commit: SpaceAfterCommit, painted: boolean) => void>(() => {
    // Host preview removal and thaw run only after this wait has relinquished ownership.
    expect(session.pendingCommit).toBeNull();
  });
  const elements = { canvas };
  const ports = { getCanvas: () => elements.canvas, getFlow: (): HTMLElement | null => flow, onFinished };
  const tick = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  };
  const expire = () => { const pending = [...timeouts.values()]; timeouts.clear(); for (const callback of pending) callback(); };
  const mutate = () => { for (const observer of observers) if (!observer.disconnected) observer.check(); };
  const wait = () => waitForSpaceAfterCommitPaint(session, ports);
  return { canvas, block, flow, elements, session, commit, frames, timeouts, observers, ports, onFinished, tick, expire, mutate, wait };
}

describe("space-after commit paint handoff", () => {
  it("releases on the DOM mutation before a frame and cleans up every fallback", () => {
    const h = harness();
    h.wait();
    expect(h.session.isFrozen).toBe(true);
    expect(h.observers[0]).toMatchObject({ target: h.flow, options: {
      attributeFilter: ["style"], attributes: true, childList: true, subtree: true,
    } });
    h.mutate();
    expect(h.onFinished).not.toHaveBeenCalled();
    h.block.style.paddingBottom = "24px";
    h.mutate();
    expect(h.onFinished).toHaveBeenCalledExactlyOnceWith(h.commit, true);
    expect(h.session.isFrozen).toBe(false);
    expect(h.frames.size).toBe(0);
    expect(h.timeouts.size).toBe(0);
    expect(h.observers[0].disconnected).toBe(true);
    h.tick(); h.expire(); h.mutate();
    expect(h.onFinished).toHaveBeenCalledOnce();
  });

  it("observes node replacement and reads the current canvas rather than a stale node", () => {
    const h = harness();
    h.wait();
    const nextCanvas = document.createElement("div");
    nextCanvas.innerHTML = '<div class="page-flow"><p data-sigma-doc-id="body" style="padding-bottom:24px"></p></div>';
    document.body.append(nextCanvas);
    h.elements.canvas = nextCanvas;
    h.mutate();
    expect(h.onFinished).toHaveBeenCalledExactlyOnceWith(h.commit, true);
  });

  it("uses the frame fallback when the surface has no observer", () => {
    const h = harness();
    h.ports.getFlow = () => null;
    h.wait();
    expect(h.observers).toHaveLength(0);
    h.block.style.paddingBottom = "24px";
    h.tick();
    expect(h.onFinished).toHaveBeenCalledExactlyOnceWith(h.commit, true);
  });

  it("bounds a rejected commit by twelve frames and releases the frozen preview", () => {
    const h = harness();
    h.wait();
    for (let frame = 0; frame < 11; frame += 1) h.tick();
    expect(h.onFinished).not.toHaveBeenCalled();
    expect(h.session.isFrozen).toBe(true);
    h.tick();
    expect(h.onFinished).toHaveBeenCalledExactlyOnceWith(h.commit, false);
    expect(h.frames.size).toBe(0);
    expect(h.timeouts.size).toBe(0);
  });

  it.each([false, true])("bounds a background-tab wait by the timer, reporting painted=%s", (painted) => {
    const h = harness();
    h.wait();
    if (painted) h.block.style.paddingBottom = "24px";
    h.expire();
    expect(h.onFinished).toHaveBeenCalledExactlyOnceWith(h.commit, painted);
    expect(h.frames.size).toBe(0);
    expect(h.observers[0].disconnected).toBe(true);
  });

  it.each(["mutation", "frame", "timer"])("a replaced generation only cleans up its own %s wait", (trigger) => {
    const h = harness();
    h.wait();
    const next = { ...h.commit, px: 50, deltaPx: 26 };
    h.session.resetForStart();
    h.session.beginCommit(next);
    h.block.style.paddingBottom = "24px";
    if (trigger === "mutation") h.mutate();
    else if (trigger === "frame") h.tick();
    else h.expire();
    expect(h.onFinished).not.toHaveBeenCalled();
    expect(h.session.pendingCommit).toBe(next);
    expect(h.session.isFrozen).toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.timeouts.size).toBe(0);
  });

  it("releases cancelled wait resources without finishing a discarded commit", () => {
    const h = harness();
    h.wait();
    h.session.cancel();
    h.tick();
    expect(h.onFinished).not.toHaveBeenCalled();
    expect(h.timeouts.size).toBe(0);
    expect(h.observers[0].disconnected).toBe(true);
  });

  it("does nothing without a pending commit", () => {
    const h = harness();
    h.session.cancel();
    h.wait();
    expect(h.observers).toHaveLength(0);
    expect(h.frames.size).toBe(0);
    expect(h.timeouts.size).toBe(0);
  });
});
