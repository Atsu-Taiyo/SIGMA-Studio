// @vitest-environment happy-dom
import * as bridge from "@/lib/desktop-bridge";
import { createTranslator } from "@/lib/i18n";
import type { DesktopAPI } from "@/types/desktop";
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { useWindowCloseBoundary } from "./use-window-close-boundary";

type Ports = Parameters<typeof useWindowCloseBoundary>[0];
let root: Root;
const tE = createTranslator("ja", "editor");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("window-close transaction lifetime", () => {
  let current: ReturnType<typeof useWindowCloseBoundary>;
  function Probe(props: Ports) { current = useWindowCloseBoundary(props); return null; }
function setup(overrides: Partial<Ports> = {}) {
  const notifyCloseReady = vi.fn(async () => true);
  const cancelCloseRequest = vi.fn(async () => true);
  const unsubscribe = vi.fn();
  vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ app: { notifyCloseReady, cancelCloseRequest, onCloseRequested: () => unsubscribe } } as unknown as DesktopAPI);
  const ports: Ports = { attemptBoundarySave: vi.fn(async () => ({ ok: true })), isCurrentDocumentDirty: () => false, cleanupUntouchedDraftsBeforeClose: vi.fn(async () => ({ ok: true })), tE, ...overrides };
  act(() => root.render(<Probe {...ports} />));
  return { ports, notifyCloseReady, cancelCloseRequest, unsubscribe };
}

  it("never cleans or notifies after disposal while boundary save is pending", async () => {
    const pending = deferred<{ ok: boolean }>();
    const fixture = setup({ attemptBoundarySave: () => pending.promise });
    let attempt!: Promise<void>;
    act(() => { attempt = current.attemptWindowCloseSave(); });
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { pending.resolve({ ok: true }); await attempt; });
    expect(fixture.ports.cleanupUntouchedDraftsBeforeClose).not.toHaveBeenCalled();
    expect(fixture.notifyCloseReady).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });
  it("a cancel wins over a draft cleanup that was already awaiting", async () => {
    const pending = deferred<{ ok: boolean }>();
    const fixture = setup({ cleanupUntouchedDraftsBeforeClose: () => pending.promise });
    let attempt!: Promise<void>;
    await act(async () => { attempt = current.attemptWindowCloseSave(); });
    await act(async () => current.finishWindowCloseSave("cancel"));
    await act(async () => { pending.resolve({ ok: true }); await attempt; });
    expect(fixture.cancelCloseRequest).toHaveBeenCalledOnce();
    expect(fixture.notifyCloseReady).not.toHaveBeenCalled();
    expect(current.windowCloseSaveDialog).toBeNull();
  });
  it("a newer retry wins over an older cleanup result", async () => {
    const pending = deferred<{ ok: boolean }>();
    const cleanup = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue({ ok: true });
    const fixture = setup({ cleanupUntouchedDraftsBeforeClose: cleanup });
    let oldAttempt!: Promise<void>;
    await act(async () => { oldAttempt = current.attemptWindowCloseSave(); });
    await act(async () => current.attemptWindowCloseSave());
    await act(async () => { pending.resolve({ ok: false }); await oldAttempt; });
    expect(fixture.notifyCloseReady).toHaveBeenCalledOnce();
    expect(current.windowCloseSaveDialog).toBeNull();
  });
  it("cannot notify after disposal during draft cleanup", async () => {
    const pending = deferred<{ ok: boolean }>();
    const fixture = setup({ cleanupUntouchedDraftsBeforeClose: () => pending.promise });
    let attempt!: Promise<void>;
    await act(async () => { attempt = current.attemptWindowCloseSave(); });
    act(() => root.render(null));
    await act(async () => { pending.resolve({ ok: true }); await attempt; });
    expect(fixture.notifyCloseReady).not.toHaveBeenCalled();
  });
  it("saves and cleans before reporting ready on a legitimate close", async () => {
    const order: string[] = [];
    const fixture = setup({ attemptBoundarySave: async () => { order.push("save"); return { ok: true }; }, cleanupUntouchedDraftsBeforeClose: async () => { order.push("cleanup"); return { ok: true }; } });
    fixture.notifyCloseReady.mockImplementation(async () => { order.push("ready"); return true; });
    await act(async () => current.attemptWindowCloseSave());
    expect(order).toEqual(["save", "cleanup", "ready"]);
  });
});
