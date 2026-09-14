// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bridge from "@/lib/desktop-bridge";
import type { DesktopAPI, DesktopExternalDocument } from "@/types/desktop";
import { useExternalDocumentOpen } from "./use-external-document-open";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); });

function Probe({ ready, open }: { ready: boolean; open: (pending: DesktopExternalDocument) => Promise<boolean> }) {
  useExternalDocumentOpen(ready, open, (error) => { throw error; });
  return null;
}

it("waits for workspace readiness, serializes arrivals using the latest callback, and unsubscribes", async () => {
  const pending: DesktopExternalDocument[] = [{ id: 1, filePath: "/first.sigma", data: "first" }];
  let notify = () => {};
  const unsubscribe = vi.fn();
  const getPendingOpenDocument = vi.fn(async () => pending[0] ?? null);
  const acknowledgeOpenDocument = vi.fn(async (_id: number) => { pending.shift(); });
  vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ file: {
    getPendingOpenDocument, acknowledgeOpenDocument,
    onOpenDocumentAvailable: (handler: () => void) => { notify = handler; return unsubscribe; },
  } } as unknown as DesktopAPI);
  let finish!: (handled: boolean) => void;
  const firstOpen = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const latestOpen = vi.fn(async () => true);
  await act(async () => root.render(<Probe ready={false} open={firstOpen} />));
  expect(getPendingOpenDocument).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe ready open={firstOpen} />));
  expect(firstOpen).toHaveBeenCalledOnce();
  expect(acknowledgeOpenDocument).not.toHaveBeenCalled();
  pending.push({ id: 2, filePath: "/second.sigma.json", data: "second" });
  await act(async () => { root.render(<Probe ready open={latestOpen} />); notify(); notify(); });
  expect(latestOpen).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(firstOpen).toHaveBeenCalledOnce();
  expect(latestOpen).toHaveBeenCalledWith({ id: 2, filePath: "/second.sigma.json", data: "second" });
  expect(acknowledgeOpenDocument.mock.calls).toEqual([[1], [2]]);
  await act(async () => root.render(<Probe ready={false} open={latestOpen} />));
  expect(unsubscribe).toHaveBeenCalledOnce();
  const calls = getPendingOpenDocument.mock.calls.length;
  await act(async () => notify());
  expect(getPendingOpenDocument).toHaveBeenCalledTimes(calls);
});

it("does not lose a queued file when unmounted during the IPC read", async () => {
  let resolveRead!: (pending: DesktopExternalDocument) => void;
  const acknowledgeOpenDocument = vi.fn();
  vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ file: {
    getPendingOpenDocument: () => new Promise((resolve) => { resolveRead = resolve; }),
    acknowledgeOpenDocument, onOpenDocumentAvailable: () => () => {},
  } } as unknown as DesktopAPI);
  const open = vi.fn();
  await act(async () => root.render(<Probe ready open={open} />));
  await act(async () => root.render(<Probe ready={false} open={open} />));
  await act(async () => resolveRead({ id: 1, filePath: "/pending.sigma", data: "pending" }));
  expect(open).not.toHaveBeenCalled();
  expect(acknowledgeOpenDocument).not.toHaveBeenCalled();
});

it("remembers an arrival while an empty IPC read is still resolving", async () => {
  let resolveRead!: (pending: null) => void;
  let notify = () => {};
  const pending = { id: 1, filePath: "/arrival.sigma", data: "arrival" };
  const getPendingOpenDocument = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }))
    .mockResolvedValueOnce(pending)
    .mockResolvedValue(null);
  const acknowledgeOpenDocument = vi.fn();
  vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ file: {
    getPendingOpenDocument, acknowledgeOpenDocument,
    onOpenDocumentAvailable: (handler: () => void) => { notify = handler; return () => {}; },
  } } as unknown as DesktopAPI);
  const open = vi.fn(async () => true);
  await act(async () => root.render(<Probe ready open={open} />));
  await act(async () => { notify(); resolveRead(null); });
  expect(open).toHaveBeenCalledExactlyOnceWith(pending);
  expect(acknowledgeOpenDocument).toHaveBeenCalledExactlyOnceWith(1);
});

it("retains the request on failed save and waits for a new open action before retrying", async () => {
  let finish!: (handled: boolean) => void;
  let notify = () => {};
  const pending = { id: 1, filePath: "/pending.sigma", data: "pending" };
  const getPendingOpenDocument = vi.fn(async () => pending);
  const acknowledgeOpenDocument = vi.fn();
  vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ file: {
    getPendingOpenDocument, acknowledgeOpenDocument,
    onOpenDocumentAvailable: (handler: () => void) => { notify = handler; return () => {}; },
  } } as unknown as DesktopAPI);
  const open = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Probe ready open={open} />));
  await act(async () => { notify(); finish(false); });
  expect(open).toHaveBeenCalledOnce();
  expect(acknowledgeOpenDocument).not.toHaveBeenCalled();
  await act(async () => notify());
  expect(open).toHaveBeenCalledTimes(2);
  await act(async () => finish(false));
});
