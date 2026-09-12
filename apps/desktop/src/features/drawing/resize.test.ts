import { describe, expect, it } from "vitest";

import type { OverlayBounds, OverlayShape } from "@/features/document";

import {
  createInitialOverlayInteractionMode,
  overlayInteractionModeReducer,
  type OverlayInteractionMode,
  type ResizeHandle,
} from "./interaction-mode";
import { resolveResizePointer } from "./resize";

const bounds: OverlayBounds = { x: 10, y: 20, w: 100, h: 80 };

describe("overlay resize pointer resolution", () => {
  it("keeps edge resize axis-only even when Shift requests aspect preservation", () => {
    const resolution = resolveResizePointer(
      startResize([rectangle()], "e"),
      { x: 25, y: 400 },
      { ctrlKey: false, shiftKey: true },
    );

    expect(resolution).toEqual({
      bounds: { x: 10, y: 20, w: 125, h: 80 },
      isRotated: false,
      preserveAspect: true,
      targetAspect: null,
    });
  });

  it("converts a rotated single-shape drag into the selection's local axes", () => {
    const mode = startResize([rectangle(Math.PI / 2)], "e");
    const resolution = resolveResizePointer(
      mode,
      { x: 0, y: 25 },
      { ctrlKey: false, shiftKey: false },
    );

    expect(mode.rotation).toBeCloseTo(Math.PI / 2);
    expect(resolution.bounds).toEqual({ x: 10, y: 20, w: 125, h: 80 });
    expect(resolution.isRotated).toBe(true);
  });

  it("preserves the existing aspect for a Shift corner resize", () => {
    const resolution = resolveResizePointer(
      startResize([rectangle()], "se"),
      { x: 20, y: 1 },
      { ctrlKey: false, shiftKey: true },
    );

    expect(resolution.bounds).toEqual({ x: 10, y: 20, w: 120, h: 96 });
    expect(resolution.preserveAspect).toBe(true);
    expect(resolution.targetAspect).toBeNull();
  });

  it("uses Ctrl regular-shape aspects for rectangle and triangle corners", () => {
    const rectangleResolution = resolveResizePointer(
      startResize([rectangle()], "se"),
      { x: 20, y: 1 },
      { ctrlKey: true, shiftKey: false },
    );
    const triangleResolution = resolveResizePointer(
      startResize([triangle()], "se"),
      { x: 20, y: 1 },
      { ctrlKey: true, shiftKey: false },
    );

    expect(rectangleResolution.targetAspect).toBe(1);
    expect(rectangleResolution.bounds).toEqual({ x: 10, y: 20, w: 120, h: 120 });
    expect(triangleResolution.targetAspect).toBeCloseTo(Math.sqrt(3) / 2);
    expect(triangleResolution.bounds.w).toBe(120);
    expect(triangleResolution.bounds.h).toBeCloseTo(120 * Math.sqrt(3) / 2);
  });

  it("keeps multi-selection free under Ctrl and aspect-locked under Shift", () => {
    const mode = startResize(
      [rectangle(0, "first"), rectangle(0, "second")],
      "se",
      { x: 10, y: 20, w: 200, h: 80 },
    );
    const free = resolveResizePointer(
      mode,
      { x: 40, y: 5 },
      { ctrlKey: true, shiftKey: false },
    );
    const locked = resolveResizePointer(
      mode,
      { x: 40, y: 5 },
      { ctrlKey: false, shiftKey: true },
    );

    expect(free).toMatchObject({
      bounds: { x: 10, y: 20, w: 240, h: 85 },
      preserveAspect: false,
      targetAspect: null,
    });
    expect(locked).toMatchObject({
      bounds: { x: 10, y: 20, w: 240, h: 96 },
      preserveAspect: true,
      targetAspect: null,
    });
  });

  it("keeps image corner aspect by default and lets Shift deform it", () => {
    const mode = startResize([image()], "se");
    const preserved = resolveResizePointer(
      mode,
      { x: 20, y: 1 },
      { ctrlKey: false, shiftKey: false },
    );
    const deformed = resolveResizePointer(
      mode,
      { x: 20, y: 1 },
      { ctrlKey: false, shiftKey: true },
    );

    expect(preserved.bounds).toEqual({ x: 10, y: 20, w: 120, h: 96 });
    expect(deformed.bounds).toEqual({ x: 10, y: 20, w: 120, h: 81 });
  });
});

function startResize(
  shapes: OverlayShape[],
  handle: ResizeHandle,
  selectionBounds = bounds,
): Extract<OverlayInteractionMode, { id: "overlay.resize" }> {
  const mode = overlayInteractionModeReducer(createInitialOverlayInteractionMode(), {
    type: "startResize",
    shapes,
    handle,
    start: { x: 0, y: 0 },
    bounds: selectionBounds,
  });
  if (mode.id !== "overlay.resize") {
    throw new Error("Expected resize mode");
  }
  return mode;
}

function rectangle(rotation = 0, id = "rectangle"): OverlayShape {
  return {
    id,
    type: "geo",
    x: 10,
    y: 20,
    rotation,
    props: {
      w: 100,
      h: 80,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function triangle(): OverlayShape {
  const shape = rectangle();
  if (shape.type !== "geo") {
    throw new Error("Expected geo shape");
  }
  return {
    ...shape,
    props: {
      ...shape.props,
      geo: "triangle",
    },
  };
}

function image(): Extract<OverlayShape, { type: "image" }> {
  return {
    id: "image",
    type: "image",
    x: 10,
    y: 20,
    props: {
      assetId: "asset",
      w: 100,
      h: 80,
    },
  };
}
