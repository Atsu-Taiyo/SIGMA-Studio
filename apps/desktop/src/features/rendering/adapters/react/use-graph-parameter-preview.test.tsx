// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import { dispatchGraphParameterPreview, dispatchGraphParametersOpen } from "@/lib/graph-parameter-preview";
import { useGraphParameterPreview } from "./use-graph-parameter-preview";

it("receives stop/close while cropping is frozen, then resumes page playback and cleans up", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  const spec = { ...createGraph2DSpecPreset("line"), parameters: [{ id: "s", name: "s", value: 0, min: 0, max: 2,
    animation: { durationMs: 1000, loop: "repeat" as const, playOnPage: true } }] };
  function Harness({ frozen }: { frozen: boolean }) {
    const projected = useGraphParameterPreview(spec, "graph", frozen);
    return <output>{projected.parameters![0].value}</output>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness frozen={false} />));
    await act(async () => {
      dispatchGraphParametersOpen("graph", true);
      dispatchGraphParameterPreview({ shapeId: "graph", overrides: { s: 1 }, playing: true });
    });
    expect(container.textContent).toBe("1");
    await act(async () => root.render(<Harness frozen />));
    expect(container.textContent).toBe("0");
    await act(async () => {
      dispatchGraphParameterPreview({ shapeId: "graph", overrides: { s: 1 }, playing: false });
      dispatchGraphParametersOpen("graph", false);
    });
    await act(async () => root.render(<Harness frozen={false} />));
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(250);
    });
    expect(container.textContent).toBe("0.5");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    expect(frames.size).toBe(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
