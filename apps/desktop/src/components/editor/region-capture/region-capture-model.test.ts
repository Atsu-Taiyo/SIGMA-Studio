import { describe, expect, it } from "vitest";

import {
  CAPTURE_BAR_GAP_PX,
  CAPTURE_BAR_MARGIN_PX,
  MIN_CAPTURE_SIZE_PX,
  clampPointToBounds,
  createCaptureFileName,
  isCaptureChord,
  isCaptureRectLargeEnough,
  placeCaptureActionBar,
  rectFromDrag,
} from "./region-capture-model";

const bounds = { left: 100, top: 50, right: 700, bottom: 450 };
const none = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };

describe("isCaptureChord", () => {
  it("is Option/Alt + Shift and nothing else", () => {
    expect(isCaptureChord({ ...none, altKey: true, shiftKey: true })).toBe(true);
    expect(isCaptureChord({ ...none, altKey: true })).toBe(false);
    expect(isCaptureChord({ ...none, shiftKey: true })).toBe(false);
    expect(isCaptureChord(none)).toBe(false);
  });

  it("leaves Cmd/Ctrl chords to additive shape selection", () => {
    expect(isCaptureChord({ ...none, altKey: true, shiftKey: true, metaKey: true })).toBe(false);
    expect(isCaptureChord({ ...none, altKey: true, shiftKey: true, ctrlKey: true })).toBe(false);
  });
});

describe("rectFromDrag", () => {
  it("builds the same rectangle whichever way the drag goes", () => {
    const down = rectFromDrag({ x: 200, y: 100 }, { x: 320, y: 180 }, bounds);
    const up = rectFromDrag({ x: 320, y: 180 }, { x: 200, y: 100 }, bounds);
    expect(down).toEqual({ left: 200, top: 100, width: 120, height: 80 });
    expect(up).toEqual(down);
  });

  it("keeps the rectangle inside the host", () => {
    expect(rectFromDrag({ x: 650, y: 400 }, { x: 900, y: 600 }, bounds)).toEqual({
      left: 650,
      top: 400,
      width: 50,
      height: 50,
    });
    expect(rectFromDrag({ x: 120, y: 60 }, { x: 0, y: 0 }, bounds)).toEqual({
      left: 100,
      top: 50,
      width: 20,
      height: 10,
    });
  });

  it("clamps a point onto the nearest edge", () => {
    expect(clampPointToBounds({ x: 0, y: 1000 }, bounds)).toEqual({ x: 100, y: 450 });
  });
});

describe("isCaptureRectLargeEnough", () => {
  it("treats a tiny drag as a click", () => {
    expect(isCaptureRectLargeEnough({ left: 0, top: 0, width: MIN_CAPTURE_SIZE_PX - 1, height: 200 })).toBe(false);
    expect(isCaptureRectLargeEnough({ left: 0, top: 0, width: 200, height: MIN_CAPTURE_SIZE_PX - 1 })).toBe(false);
    expect(isCaptureRectLargeEnough({ left: 0, top: 0, width: MIN_CAPTURE_SIZE_PX, height: MIN_CAPTURE_SIZE_PX })).toBe(true);
  });
});

describe("placeCaptureActionBar", () => {
  const viewport = { width: 1000, height: 700 };
  const bar = { width: 200, height: 40 };

  it("centres the bar under the rectangle", () => {
    const placed = placeCaptureActionBar({ left: 300, top: 100, width: 200, height: 100 }, bar, viewport);
    expect(placed).toEqual({ left: 300, top: 100 + 100 + CAPTURE_BAR_GAP_PX });
  });

  it("moves above the rectangle when there is no room below", () => {
    const placed = placeCaptureActionBar({ left: 300, top: 500, width: 200, height: 160 }, bar, viewport);
    expect(placed.top).toBe(500 - CAPTURE_BAR_GAP_PX - bar.height);
  });

  it("sits inside the rectangle when it fills the height", () => {
    const placed = placeCaptureActionBar({ left: 300, top: 4, width: 200, height: 692 }, bar, viewport);
    expect(placed.top).toBe(viewport.height - bar.height - CAPTURE_BAR_MARGIN_PX);
  });

  it("stays inside the window horizontally", () => {
    expect(placeCaptureActionBar({ left: 0, top: 100, width: 20, height: 20 }, bar, viewport).left)
      .toBe(CAPTURE_BAR_MARGIN_PX);
    expect(placeCaptureActionBar({ left: 990, top: 100, width: 10, height: 20 }, bar, viewport).left)
      .toBe(viewport.width - bar.width - CAPTURE_BAR_MARGIN_PX);
  });
});

describe("createCaptureFileName", () => {
  it("uses the local time with fixed-width fields", () => {
    expect(createCaptureFileName(new Date(2026, 9, 3, 4, 5, 6))).toBe("screenshot-20261003-040506.png");
  });
});
