// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useOverlayPreviewHandoff } from "./use-overlay-preview-handoff";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function mount() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const complete = vi.fn(); const activate = vi.fn();
  function Harness() {
    const start = useOverlayPreviewHandoff(complete, activate);
    return <div onPointerDown={event => start(event, new DOMRect(10, 20, 100, 200), "shape")} />;
  }
  await act(async () => root.render(<Harness />));
  let mounted = true;
  const unmount = async () => { if (!mounted) return; mounted = false; await act(async () => root.unmount()); host.remove(); };
  cleanups.push(unmount);
  const down = async (pointerId = 1) => act(async () => host.firstElementChild!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId, pointerType: "touch", clientX: 30, clientY: 40 })));
  return { complete, activate, unmount, down };
}

it("hands the matching gesture to the editor once with initial and final screen coordinates", async () => {
  const controller = await mount(); await controller.down();
  expect(controller.activate).toHaveBeenCalledOnce();
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, pointerType: "touch", clientX: 70, clientY: 90 }));
  expect(controller.complete).not.toHaveBeenCalled();
  const move = new PointerEvent("pointermove", { pointerId: 1, pointerType: "touch", cancelable: true });
  window.dispatchEvent(move); expect(move.defaultPrevented).toBe(true);
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "touch", clientX: 70, clientY: 90 }));
  expect(controller.complete).toHaveBeenCalledWith(new DOMRect(10, 20, 100, 200), { x: 30, y: 40 }, { x: 70, y: 90 }, "shape");
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "touch" }));
  expect(controller.complete).toHaveBeenCalledOnce();
});

it("replaces a pending gesture and detaches listeners when the editor unmounts", async () => {
  const controller = await mount(); await controller.down(1); await controller.down(2);
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "touch" }));
  expect(controller.complete).not.toHaveBeenCalled();
  await controller.unmount();
  const move = new PointerEvent("pointermove", { pointerId: 2, pointerType: "touch", cancelable: true });
  window.dispatchEvent(move); expect(move.defaultPrevented).toBe(false);
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 2, pointerType: "touch" }));
  expect(controller.complete).not.toHaveBeenCalled();
});
