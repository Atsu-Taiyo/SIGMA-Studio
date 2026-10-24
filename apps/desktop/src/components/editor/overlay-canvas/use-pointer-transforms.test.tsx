// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createOverlaySnapGeometry } from "@/features/drawing";
import { getRenderableShapes, getUnlockedTransformShapes, groupOverlayShapes } from "./grouping";
import { createInitialOverlayInteractionMode, overlayInteractionModeReducer, resolveMovePointerUp, type OverlayInteractionAction } from "./interaction-mode";
import type { OverlayShape } from "./types";
import { useOverlayPointerTransforms } from "./use-pointer-transforms";

const rect = (id: string, x: number, y: number): OverlayShape => ({
  id, type: "geo", x, y,
  props: { w: 60, h: 40, geo: "rectangle", fill: "solid", color: "black", labelColor: "black", dash: "solid", size: "m" },
});

describe("selection click and move preview", () => {
  it.each(["shape", "group", "member"].flatMap(scope => [1, 8].map(zoom => ({ scope, zoom }))))("keeps a $scope still during click jitter at zoom $zoom", async ({ scope, zoom }) => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const members = [rect("a", 100, 100), rect("b", 230, 200)];
    const shapes = scope === "shape" ? members : groupOverlayShapes(members, ["a", "b"], () => "group").shapes;
    shapes.push(rect("nearby", 106, 300));
    const before = structuredClone(shapes);
    const shapesRef = { current: shapes };
    const modeRef = { current: createInitialOverlayInteractionMode() };
    const transitionMode = (action: OverlayInteractionAction) => {
      modeRef.current = overlayInteractionModeReducer(modeRef.current, action);
    };
    const createSnapGeometry = vi.fn((excludedShapeIds?: Iterable<string>) => createOverlaySnapGeometry(getRenderableShapes(shapesRef.current), { excludedShapeIds }));
    const setShapes = vi.fn();
    const clearSnapGuides = vi.fn();
    let transforms!: ReturnType<typeof useOverlayPointerTransforms>;
    function Harness() {
      transforms = useOverlayPointerTransforms({
        session: { transitionMode, lastInteractionPointRef: { current: null }, resizePaddingRef: { current: { left: 0, top: 0, right: 0, bottom: 0 } } },
        editing: { shapesRef, setShapes, assetsRef: { current: {} }, replaceShape: vi.fn() },
        geometry: { clientPointFromPage: point => ({ x: point.x * zoom, y: point.y * zoom }), createSnapGeometry, getOverlaySnapThreshold: () => 8 / zoom, anchorMeasurementsRef: { current: { rects: new Map(), ordered: [] } } },
        snapDisabledRef: { current: false }, setSnapGuides: vi.fn(), clearSnapGuides,
        lastCalloutCornerRadiusRef: { current: 0 }, imageCropDirtyRef: { current: false },
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    try {
      const start = { x: 120, y: 120 };
      transitionMode({ type: "startMove", shapes: getUnlockedTransformShapes(shapes, [scope === "group" ? "group" : "a"]), start });
      const applyAt = (point: { x: number; y: number }) => {
        if (modeRef.current.id !== "overlay.move") throw new Error("Expected move mode");
        transforms.applyMoveInteractionAtPoint(modeRef.current, point);
      };
      for (const point of [start, { x: 120 + 1 / zoom, y: 120 + 1 / zoom }, { x: 120 + 2 / zoom, y: 120 }]) applyAt(point);
      expect(createSnapGeometry).not.toHaveBeenCalled();
      if (modeRef.current.id !== "overlay.move") throw new Error("Expected move mode");
      expect(modeRef.current.offset).toBeNull();
      expect(resolveMovePointerUp(modeRef.current, { x: 122, y: 120 })).toEqual({ kind: "noop" });
      expect(setShapes).not.toHaveBeenCalled();
      expect(shapesRef.current).toEqual(before);

      // Crossing the click threshold enables real snapping and uses the same offset on release.
      applyAt({ x: 120 + 5 / zoom, y: 120 });
      expect(createSnapGeometry).toHaveBeenCalledOnce();
      if (modeRef.current.id !== "overlay.move") throw new Error("Expected move mode");
      expect(modeRef.current.offset?.x).toBe(zoom === 1 ? 6 : 5 / zoom);
      expect(resolveMovePointerUp({ ...modeRef.current, start: { x: 120 * zoom, y: 120 * zoom } }, { x: 120 * zoom + 5, y: 120 * zoom })).toEqual({ kind: "commit", offset: modeRef.current.offset });

      // Returning to the click area also removes the visual preview.
      applyAt(start);
      if (modeRef.current.id !== "overlay.move") throw new Error("Expected move mode");
      expect(modeRef.current.offset).toEqual({ x: 0, y: 0 });
      expect(resolveMovePointerUp(modeRef.current, start)).toEqual({ kind: "noop" });
      expect(clearSnapGuides).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
