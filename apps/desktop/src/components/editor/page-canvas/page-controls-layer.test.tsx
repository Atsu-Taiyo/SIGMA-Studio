// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LiftedPageControl, PageControlsLayerContext } from "./page-controls-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it("preserves a source fragment's clipping after lifting its control at 200 percent zoom", async () => {
  const canvas = document.createElement("div");
  canvas.style.transform = "matrix(2, 0, 0, 2, 0, 0)";
  document.body.append(canvas);
  const layer = document.createElement("div");
  const source = document.createElement("div");
  source.className = "editor-box-fragment-viewport";
  canvas.append(layer, source);
  let sourceTop = 160;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === layer) return new DOMRect(0, 0, 399.984, 600);
    if (this === source) return new DOMRect(0, 0, 180, 200);
    return new DOMRect(20, sourceTop, 200, 80);
  });
  let nextFrame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { nextFrame = callback; return 1; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const root = createRoot(source);
  try {
    await act(async () => root.render(
      <PageControlsLayerContext.Provider value={layer}>
        <LiftedPageControl className="test-control" render={() => <button>Apply</button>} />
      </PageControlsLayerContext.Provider>,
    ));
    const lifted = layer.querySelector<HTMLElement>("[data-page-control-lifted]")!;
    expect(lifted.hidden).toBe(false);
    expect(lifted.style.left).toBe("10px");
    expect(lifted.style.top).toBe("80px");
    expect(lifted.style.width).toBe("100px");
    expect(lifted.style.clipPath).toBe("inset(0px 20px 20px 0px)");
    sourceTop = 220;
    await act(async () => nextFrame!(0));
    expect(lifted.hidden).toBe(true);
    expect(getComputedStyle(lifted).display).toBe("none");
  } finally {
    await act(async () => root.unmount());
  }
  expect(cancel).toHaveBeenCalledWith(1);
});
