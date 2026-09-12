// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCameraDragAutoScrollPanBy,
  createDragAutoScroller,
  findDragAutoScrollScroller,
  panDragAutoScrollElement,
  resolveDragAutoScrollStep,
} from "./drag-auto-scroll";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("resolveDragAutoScrollStep", () => {
  it("帯の外では動かず、上下端では対応する符号を返す", () => {
    expect(resolveDragAutoScrollStep(400, 0, 800, 1100)).toBe(0);
    expect(resolveDragAutoScrollStep(4, 0, 800, 1100)).toBeLessThan(0);
    expect(resolveDragAutoScrollStep(796, 0, 800, 1100)).toBeGreaterThan(0);
  });

  it("端への食い込みを帯幅で正規化し、最大速度でクランプする", () => {
    const shallow = resolveDragAutoScrollStep(772, 0, 800, 1100);
    const deep = resolveDragAutoScrollStep(784, 0, 800, 1100);
    expect(deep).toBeGreaterThan(shallow);
    expect(resolveDragAutoScrollStep(784, 0, 800, 1100)).toBe(550);
    expect(resolveDragAutoScrollStep(2000, 0, 800, 1100)).toBe(1100);
    expect(resolveDragAutoScrollStep(-2000, 0, 800, 1100)).toBe(-1100);
  });

  it("両端の帯を置けない狭い viewport では動かない", () => {
    expect(resolveDragAutoScrollStep(10, 0, 40, 1100)).toBe(0);
  });

  it("横軸にも同じ式を使える", () => {
    expect(resolveDragAutoScrollStep(16, 0, 1000, 480)).toBe(-240);
    expect(resolveDragAutoScrollStep(984, 0, 1000, 480)).toBe(240);
  });
});

describe("findDragAutoScrollScroller", () => {
  it("断片 viewport を避けて editor-canvas を選ぶ", () => {
    const canvas = document.createElement("section");
    canvas.className = "editor-canvas";
    const fragmentViewport = document.createElement("div");
    fragmentViewport.className = "editor-box-fragment-viewport";
    fragmentViewport.style.overflowY = "auto";
    Object.defineProperties(fragmentViewport, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
    });
    const child = document.createElement("span");
    fragmentViewport.append(child);
    canvas.append(fragmentViewport);
    document.body.append(canvas);

    expect(findDragAutoScrollScroller(child)).toBe(canvas);
  });
});

describe("drag auto-scroll pan direction", () => {
  it("紙面は step と同じ向きへスクロールし、camera pan は反転する", () => {
    const scroller = document.createElement("div");
    scroller.scrollTop = 20;
    expect(panDragAutoScrollElement(scroller, 0, 10)).toEqual({
      appliedDx: 0,
      appliedDy: 10,
      rectSettled: true,
    });
    expect(scroller.scrollTop).toBe(30);

    const panBy = vi.fn();
    const cameraPanBy = createCameraDragAutoScrollPanBy(panBy);
    expect(cameraPanBy(0, 10)).toEqual({
      appliedDx: 0,
      appliedDy: 10,
      rectSettled: false,
    });
    expect(panBy).toHaveBeenCalledWith(0, -10);

    panBy.mockClear();
    expect(cameraPanBy(0, 0)).toBeNull();
    expect(panBy).not.toHaveBeenCalled();
  });
});

describe("createDragAutoScroller", () => {
  function createFrameHarness() {
    let frameCallback: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 7;
    });
    const cancelAnimationFrame = vi.fn();
    return {
      cancelAnimationFrame,
      ownerWindow: { requestAnimationFrame, cancelAnimationFrame } as unknown as Window,
      requestAnimationFrame,
      runFrame(time: number) {
        expect(frameCallback).not.toBeNull();
        const callback = frameCallback as unknown as FrameRequestCallback;
        frameCallback = null;
        callback(time);
      },
    };
  }

  it("矩形は実 pointer update でだけ測り、未反映 pan の累計で client 座標を補正する", () => {
    const frames = createFrameHarness();
    const getViewportBounds = vi.fn(() => ({ top: 0, bottom: 800, left: 0, right: 1000 }));
    const panBy = vi.fn((dx: number, dy: number) => ({
      appliedDx: dx,
      appliedDy: dy,
      rectSettled: false,
    }));
    const onPan = vi.fn();
    const scroller = createDragAutoScroller({
      ownerWindow: frames.ownerWindow,
      getViewportBounds,
      panBy,
      onPan,
      maxSpeedPxPerSec: 1000,
    });

    scroller.update(1000, 800);
    frames.runFrame(0);
    frames.runFrame(10);
    frames.runFrame(20);
    expect(getViewportBounds).toHaveBeenCalledTimes(1);
    expect(panBy).toHaveBeenNthCalledWith(1, 10, 10);
    expect(panBy).toHaveBeenNthCalledWith(2, 10, 10);
    expect(onPan).toHaveBeenNthCalledWith(1, 1010, 810, { rectSettled: false });
    expect(onPan).toHaveBeenNthCalledWith(2, 1020, 820, { rectSettled: false });

    scroller.stop();
    expect(frames.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });

  it("経過時間が 2 倍なら移動量も 2 倍になる", () => {
    const frames = createFrameHarness();
    const panBy = vi.fn((dx: number, dy: number) => ({ appliedDx: dx, appliedDy: dy, rectSettled: true }));
    const scroller = createDragAutoScroller({
      ownerWindow: frames.ownerWindow,
      getViewportBounds: () => ({ top: 0, bottom: 800, left: 0, right: 1000 }),
      panBy,
      onPan: vi.fn(),
      maxSpeedPxPerSec: 600,
    });

    scroller.update(500, 800);
    frames.runFrame(0);
    frames.runFrame(10);
    frames.runFrame(30);
    expect(panBy.mock.calls[0][1]).toBe(6);
    expect(panBy.mock.calls[1][1]).toBe(12);
    scroller.stop();
  });

  it("長い停止は 1/15 秒ぶんまでにクランプする", () => {
    const frames = createFrameHarness();
    const panBy = vi.fn((dx: number, dy: number) => ({ appliedDx: dx, appliedDy: dy, rectSettled: true }));
    const scroller = createDragAutoScroller({
      ownerWindow: frames.ownerWindow,
      getViewportBounds: () => ({ top: 0, bottom: 800, left: 0, right: 1000 }),
      panBy,
      onPan: vi.fn(),
      maxSpeedPxPerSec: 600,
    });

    scroller.update(500, 800);
    frames.runFrame(0);
    frames.runFrame(1000);
    expect(panBy).toHaveBeenCalledWith(0, 40);
    scroller.stop();
  });

  it("1px 未満の端数を持ち越して最終的に移動する", () => {
    const frames = createFrameHarness();
    const panBy = vi.fn((dx: number, dy: number) => ({ appliedDx: dx, appliedDy: dy, rectSettled: true }));
    const scroller = createDragAutoScroller({
      ownerWindow: frames.ownerWindow,
      getViewportBounds: () => ({ top: 0, bottom: 800, left: 0, right: 1000 }),
      panBy,
      onPan: vi.fn(),
      maxSpeedPxPerSec: 10,
    });

    scroller.update(500, 800);
    frames.runFrame(0);
    frames.runFrame(50);
    expect(panBy).not.toHaveBeenCalled();
    frames.runFrame(100);
    expect(panBy).toHaveBeenCalledWith(0, 1);
    scroller.stop();
  });
});
