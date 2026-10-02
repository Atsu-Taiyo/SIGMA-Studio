// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePageCanvasViewport } from "./use-page-canvas-viewport";

it("materializes every output page while editing retains viewport windowing, and cleans pending scroll work", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const scroller = document.createElement("div"); scroller.className = "editor-canvas";
  const canvas = document.createElement("div"); scroller.append(canvas); document.body.append(scroller);
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 500, 12000);
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, 600);
  const frames = new Map<number, FrameRequestCallback>(); let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { const id = ++nextId; frames.set(id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  let owner!: ReturnType<typeof usePageCanvasViewport>;
  const canvasRef = { current: canvas };
  function Probe({ output }: { output: boolean }) {
    const current = usePageCanvasViewport({ isPagedRender: output, pageCount: 12, pageHeightPx: 1000, canvasRef, zoom: 100 });
    useLayoutEffect(() => { owner = current; }); return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<StrictMode><Probe output={false} /></StrictMode>));
    expect(owner.visiblePageRange.end).toBeLessThan(11);
    await act(async () => root.render(<StrictMode><Probe output /></StrictMode>));
    expect(owner.visiblePageRange).toEqual({ start: 0, end: 11, overscan: 0 });
    scroller.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    await act(async () => root.unmount()); expect(frames.size).toBe(0);
    scroller.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);
  } finally { await act(async () => root.unmount()); scroller.remove(); vi.restoreAllMocks(); }
});
