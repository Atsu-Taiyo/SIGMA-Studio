// @vitest-environment happy-dom
import { act, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createInitialOverlayInteractionMode } from "./interaction-mode";
import { useOverlayPointerSession } from "./use-pointer-session";

it("owns one shared capture/scroll lifetime, releases it on file switch and unmount, and keeps refs stable", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const surface = document.createElement("div"); const captured = new Set<number>();
  surface.setPointerCapture = vi.fn(id => { captured.add(id); }); surface.hasPointerCapture = vi.fn(id => captured.has(id)); surface.releasePointerCapture = vi.fn(id => { captured.delete(id); });
  const bleedSurfaceRef = { current: surface }; const modeRef = { current: createInitialOverlayInteractionMode() }; const transitionMode = vi.fn();
  let session!: ReturnType<typeof useOverlayPointerSession>;
  function Harness({ documentId }: { documentId: string }) { session = useOverlayPointerSession({ documentId, modeRef, transitionMode, bleedSurfaceRef }); return null; }
  const root = createRoot(document.createElement("div")); await act(async () => root.render(<Harness documentId="first" />));
  const original = session; session.capturePointer({ pointerId: 7, clientX: 20, clientY: 30 } as ReactPointerEvent<Element>);
  const stop = vi.fn(); session.dragAutoScrollerRef.current = { stop, update: vi.fn() };
  await act(async () => root.render(<Harness documentId="second" />));
  expect(surface.releasePointerCapture).toHaveBeenCalledWith(7); expect(stop).toHaveBeenCalledOnce(); expect(session.dragPointerRef.current).toBeNull(); expect(session).toBe(original);
  session.capturePointer({ pointerId: 8, clientX: 0, clientY: 0 } as ReactPointerEvent<Element>);
  await act(async () => root.unmount()); expect(surface.releasePointerCapture).toHaveBeenCalledWith(8); expect(captured.size).toBe(0);
});
