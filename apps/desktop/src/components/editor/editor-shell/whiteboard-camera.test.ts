import { describe, expect, it } from "vitest";

import { MAX_ZOOM, MIN_ZOOM } from "@/components/editor/editor-shell/constants";
import {
  getScrollForZoomAnchor,
  normalizeWheelDelta,
  panCamera,
  resetCamera,
  resolveNextZoom,
  resolveWheelIntent,
  WHEEL_LINE_HEIGHT_PX,
  zoomCameraAt,
  type WhiteboardCamera,
} from "@/components/editor/editor-shell/whiteboard-camera";

/** 錨の下にあるワールド座標。ズームの前後でこれが一致すれば「錨が効いた」。 */
function worldPointUnder(camera: WhiteboardCamera, anchor: { x: number; y: number }) {
  const scale = camera.zoom / 100;
  return {
    x: (anchor.x - camera.panX) / scale,
    y: (anchor.y - camera.panY) / scale,
  };
}

const SCALE = { lineHeightPx: WHEEL_LINE_HEIGHT_PX, pageWidthPx: 1200, pageHeightPx: 800 };

describe("zoomCameraAt", () => {
  it("keeps the world point under the anchor fixed when zooming in from the origin", () => {
    const camera: WhiteboardCamera = { zoom: 100, panX: 0, panY: 0 };
    const anchor = { x: 600, y: 400 };

    const next = zoomCameraAt(camera, 250, anchor);

    expect(next.zoom).toBe(250);
    expect(worldPointUnder(next, anchor).x).toBeCloseTo(worldPointUnder(camera, anchor).x, 6);
    expect(worldPointUnder(next, anchor).y).toBeCloseTo(worldPointUnder(camera, anchor).y, 6);
  });

  it("keeps the world point fixed when the camera is already panned", () => {
    const camera: WhiteboardCamera = { zoom: 140, panX: -320, panY: 96 };
    const anchor = { x: 512, y: 288 };

    const next = zoomCameraAt(camera, 260, anchor);

    expect(worldPointUnder(next, anchor).x).toBeCloseTo(worldPointUnder(camera, anchor).x, 6);
    expect(worldPointUnder(next, anchor).y).toBeCloseTo(worldPointUnder(camera, anchor).y, 6);
  });

  it("keeps the world point fixed for an anchor away from the viewport centre", () => {
    const camera: WhiteboardCamera = { zoom: 320, panX: 210, panY: -540 };
    const anchor = { x: 37, y: 761 };

    const next = zoomCameraAt(camera, 120, anchor);

    expect(worldPointUnder(next, anchor).x).toBeCloseTo(worldPointUnder(camera, anchor).x, 6);
    expect(worldPointUnder(next, anchor).y).toBeCloseTo(worldPointUnder(camera, anchor).y, 6);
  });

  it("clamps to the shared zoom range and derives the pan from the clamped zoom", () => {
    const camera: WhiteboardCamera = { zoom: 100, panX: 0, panY: 0 };
    const anchor = { x: 400, y: 300 };

    const tooFarIn = zoomCameraAt(camera, MAX_ZOOM + 5000, anchor);
    const tooFarOut = zoomCameraAt(camera, MIN_ZOOM - 5000, anchor);

    expect(tooFarIn.zoom).toBe(MAX_ZOOM);
    expect(tooFarOut.zoom).toBe(MIN_ZOOM);
    // クランプ前の zoom で pan を計算すると錨がずれる。クランプ後の zoom で計算されていること。
    expect(tooFarIn).toEqual(zoomCameraAt(camera, MAX_ZOOM, anchor));
    expect(worldPointUnder(tooFarIn, anchor).x).toBeCloseTo(worldPointUnder(camera, anchor).x, 6);
    expect(worldPointUnder(tooFarOut, anchor).y).toBeCloseTo(worldPointUnder(camera, anchor).y, 6);
  });

  it("returns the same camera when the clamped zoom does not change", () => {
    const camera: WhiteboardCamera = { zoom: 100, panX: 12, panY: -8 };

    expect(zoomCameraAt(camera, 100.4, { x: 400, y: 300 })).toEqual(camera);
  });
});

describe("resolveNextZoom", () => {
  it("passes an ordinary zoom request straight through the shared clamp", () => {
    expect(resolveNextZoom(100, 110)).toBe(110);
    expect(resolveNextZoom(100, 110.4)).toBe(110);
  });

  it("leaves an exact no-op alone", () => {
    expect(resolveNextZoom(100, 100)).toBe(100);
  });

  it("steps by 1% when rounding would swallow a small multiplicative zoom", () => {
    // 10% で factor 0.992 → 9.92 → 丸めると 10 のまま。放置すると縮め切ったあと戻せない。
    expect(resolveNextZoom(10, 10 * 1.008)).toBe(11);
    expect(resolveNextZoom(12, 12 * 0.992)).toBe(11);
  });

  it("does not step past the ends of the range", () => {
    expect(resolveNextZoom(MIN_ZOOM, MIN_ZOOM * 0.992)).toBe(MIN_ZOOM);
    expect(resolveNextZoom(MAX_ZOOM, MAX_ZOOM * 1.008)).toBe(MAX_ZOOM);
  });
});

describe("panCamera", () => {
  it("adds the delta to the pan and leaves the zoom alone", () => {
    expect(panCamera({ zoom: 250, panX: 10, panY: -20 }, 5, 30))
      .toEqual({ zoom: 250, panX: 15, panY: 10 });
  });
});

describe("resetCamera", () => {
  it("returns 100% at the world origin", () => {
    expect(resetCamera()).toEqual({ zoom: 100, panX: 0, panY: 0 });
  });
});

describe("normalizeWheelDelta", () => {
  it("passes pixel deltas straight through", () => {
    expect(normalizeWheelDelta({ deltaX: 12, deltaY: -48, deltaMode: 0 }, SCALE))
      .toEqual({ dx: 12, dy: -48 });
  });

  it("scales line deltas by the line height", () => {
    expect(normalizeWheelDelta({ deltaX: 1, deltaY: 3, deltaMode: 1 }, SCALE))
      .toEqual({ dx: WHEEL_LINE_HEIGHT_PX, dy: 3 * WHEEL_LINE_HEIGHT_PX });
  });

  it("scales page deltas by the viewport size", () => {
    expect(normalizeWheelDelta({ deltaX: -1, deltaY: 2, deltaMode: 2 }, SCALE))
      .toEqual({ dx: -1200, dy: 1600 });
  });

  it("treats an unknown delta mode as pixels", () => {
    expect(normalizeWheelDelta({ deltaX: 4, deltaY: 5, deltaMode: 7 }, SCALE))
      .toEqual({ dx: 4, dy: 5 });
  });
});

describe("resolveWheelIntent", () => {
  it("zooms in on ctrl+wheel up", () => {
    const intent = resolveWheelIntent(
      { deltaX: 0, deltaY: -4, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false },
      SCALE,
    );

    expect(intent.kind).toBe("zoom");
    expect(intent.kind === "zoom" && intent.factor).toBeGreaterThan(1);
  });

  it("zooms out on meta+wheel down", () => {
    const intent = resolveWheelIntent(
      { deltaX: 0, deltaY: 4, deltaMode: 0, ctrlKey: false, metaKey: true, shiftKey: false },
      SCALE,
    );

    expect(intent.kind).toBe("zoom");
    expect(intent.kind === "zoom" && intent.factor).toBeLessThan(1);
  });

  it("keeps the paper-mode zoom rate identical on line and page deltas", () => {
    // 倍率は「1 ノッチあたり何倍」。px へ正規化してしまうと行/ページ単位のデバイスだけ
    // 効きが跳ね上がり、抽出元 (紙モード) の挙動と変わってしまう。
    const pixels = resolveWheelIntent(
      { deltaX: 0, deltaY: 3, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false },
      SCALE,
    );
    const lines = resolveWheelIntent(
      { deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: true, metaKey: false, shiftKey: false },
      SCALE,
    );
    const pages = resolveWheelIntent(
      { deltaX: 0, deltaY: 3, deltaMode: 2, ctrlKey: true, metaKey: false, shiftKey: false },
      SCALE,
    );

    expect(lines).toEqual(pixels);
    expect(pages).toEqual(pixels);
    // 抽出元の式そのもの。
    expect(pixels.kind === "zoom" && pixels.factor).toBeCloseTo(Math.exp(-3 * 0.008), 12);
  });

  it("clips a runaway zoom delta so one flick cannot jump the whole range", () => {
    const huge = resolveWheelIntent(
      { deltaX: 0, deltaY: -4000, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false },
      SCALE,
    );
    const clipped = resolveWheelIntent(
      { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false },
      SCALE,
    );

    expect(huge).toEqual(clipped);
  });

  it("pans both axes on an unmodified wheel, opposite to the scroll direction", () => {
    expect(resolveWheelIntent(
      { deltaX: 30, deltaY: -50, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false },
      SCALE,
    )).toEqual({ kind: "pan", dx: -30, dy: 50 });
  });

  it("pans a line-mode wheel by whole lines instead of by 3px", () => {
    expect(resolveWheelIntent(
      { deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false, metaKey: false, shiftKey: false },
      SCALE,
    )).toEqual({ kind: "pan", dx: 0, dy: -3 * WHEEL_LINE_HEIGHT_PX });
  });

  it("turns a shift-only vertical wheel into a horizontal pan", () => {
    expect(resolveWheelIntent(
      { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: true },
      SCALE,
    )).toEqual({ kind: "pan", dx: -40, dy: 0 });
  });

  it("leaves a shifted wheel alone when the platform already moved it to the x axis", () => {
    expect(resolveWheelIntent(
      { deltaX: 40, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: true },
      SCALE,
    )).toEqual({ kind: "pan", dx: -40, dy: 0 });
  });
});

describe("getScrollForZoomAnchor", () => {
  it("reproduces the paper-mode scroll anchor formula", () => {
    const input = {
      scrollLeft: 120,
      scrollTop: 640,
      offsetX: 300,
      offsetY: 210,
      currentZoom: 100,
      nextZoom: 130,
    };

    // 抽出元 (EditorShell.applyZoom) と同じ式を、テスト側にもう一度書いて突き合わせる。
    const unzoomedX = (input.scrollLeft + input.offsetX) / (input.currentZoom / 100);
    const unzoomedY = (input.scrollTop + input.offsetY) / (input.currentZoom / 100);
    const nextFactor = input.nextZoom / 100;

    expect(getScrollForZoomAnchor(input)).toEqual({
      scrollLeft: unzoomedX * nextFactor - input.offsetX,
      scrollTop: unzoomedY * nextFactor - input.offsetY,
    });
  });

  it("keeps the anchored content point still across the zoom change", () => {
    const currentZoom = 150;
    const nextZoom = 90;
    const scrollLeft = 400;
    const scrollTop = 900;
    const offsetX = 250;
    const offsetY = 180;

    const next = getScrollForZoomAnchor({
      scrollLeft, scrollTop, offsetX, offsetY, currentZoom, nextZoom,
    });

    const contentBefore = (scrollTop + offsetY) / (currentZoom / 100);
    const contentAfter = (next.scrollTop + offsetY) / (nextZoom / 100);
    expect(contentAfter).toBeCloseTo(contentBefore, 6);
  });
});
