// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMathLiveCompositionAnchor, placeFixedElementAtViewportPoint } from "./mathlive-composition-anchor";

/** fixed の基準が「原点 (originX, originY)・倍率 scale」の transform を持つ祖先になったときの見え方。 */
function fixedInTransformedAncestor(element: HTMLElement, originX: number, originY: number, scale: number) {
  element.getBoundingClientRect = () => {
    const x = originX + (parseFloat(element.style.left) || 0) * scale;
    const y = originY + (parseFloat(element.style.top) || 0) * scale;
    return new DOMRect(x, y, 0, 5 * scale);
  };
}

function mountMathLiveSink() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const sink = document.createElement("span");
  sink.className = "ML__keyboard-sink";
  root.append(sink);
  return { root, sink };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("placeFixedElementAtViewportPoint", () => {
  it.each([
    ["the page stack at 100%", 38, -564, 1],
    ["a zoomed page stack", 38, -1200, 1.5],
    ["the viewport", 0, 0, 1],
  ])("lands on the viewport point inside %s", (_, originX, originY, scale) => {
    const element = document.createElement("span");
    fixedInTransformedAncestor(element, originX, originY, scale);

    placeFixedElementAtViewportPoint(element, 239.5, 543.25);

    const rect = element.getBoundingClientRect();
    expect(rect.left).toBeCloseTo(239.5, 6);
    expect(rect.top).toBeCloseTo(543.25, 6);
  });
});

describe("installMathLiveCompositionAnchor", () => {
  function queueAnimationFrames() {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    return () => frames.splice(0).forEach((callback) => callback(0));
  }

  it("re-anchors the sink MathLive moved to caret coordinates in the same frame", () => {
    const flushFrame = queueAnimationFrames();
    const { root, sink } = mountMathLiveSink();
    fixedInTransformedAncestor(sink, 38, -564, 1);
    // MathLive 0.111: sink 上の capture で rAF を積み、キャレットの画面座標を top/left に書く。
    sink.addEventListener("compositionstart", () => requestAnimationFrame(() => {
      sink.style.top = "543px";
      sink.style.left = "240px";
    }), { capture: true });
    installMathLiveCompositionAnchor(root);
    installMathLiveCompositionAnchor(root);

    sink.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed: true }));
    flushFrame();

    expect(sink.getBoundingClientRect().top).toBe(543);
    expect(sink.getBoundingClientRect().left).toBe(240);
    expect(sink.style.top).toBe("1107px");
  });

  it("keeps the previous anchor when MathLive did not move the sink", () => {
    const flushFrame = queueAnimationFrames();
    const { root, sink } = mountMathLiveSink();
    fixedInTransformedAncestor(sink, 38, -564, 1);
    sink.style.top = "1107px";
    sink.style.left = "202px";
    installMathLiveCompositionAnchor(root);

    sink.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed: true }));
    flushFrame();

    expect(sink.style.top).toBe("1107px");
    expect(sink.style.left).toBe("202px");
  });
});
