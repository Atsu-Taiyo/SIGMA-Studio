// @vitest-environment happy-dom
import { act, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createInitialOverlayInteractionMode, overlayInteractionModeReducer, type OverlayInteractionAction } from "./interaction-mode";
import type { OverlayShape } from "./types";
import { useOverlayPointerLifecycle } from "./use-pointer-lifecycle";
import { useOverlayPointerSession } from "./use-pointer-session";

it("commits a completed move once but restores previews on cancellation and disposal", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const base: OverlayShape = { id: "text", type: "text", x: 10, y: 20, props: { w: 100, h: 30, color: "black", size: "m", blocks: [] } };
  const shapesRef: { current: OverlayShape[] } = { current: [base] }; const modeRef = { current: createInitialOverlayInteractionMode() };
  const surface = document.createElement("div"); const captured = new Set<number>();
  surface.setPointerCapture = vi.fn(id => { captured.add(id); }); surface.hasPointerCapture = vi.fn(id => captured.has(id)); surface.releasePointerCapture = vi.fn(id => { captured.delete(id); });
  const bleedSurfaceRef = { current: surface }; const transitionMode = vi.fn((action: OverlayInteractionAction) => { modeRef.current = overlayInteractionModeReducer(modeRef.current, action); });
  const save = vi.fn(); const noop = vi.fn();
  const restore = vi.fn((interaction: typeof modeRef.current) => { if (interaction.id === "overlay.move") shapesRef.current = interaction.shapes; });
  const updateShapes: Parameters<typeof useOverlayPointerLifecycle>[0]["editing"]["setShapes"] = value => { shapesRef.current = typeof value === "function" ? value(shapesRef.current) : value; };
  const selection = { selectedIdsRef: { current: [base.id] }, focusedGroupIdRef: { current: null }, setSelectedShapeIds: noop, selectShape: noop };
  const geometry = { pagePointFromClient: (x: number, y: number) => ({ x, y }), clientPointFromPage: (p: { x: number; y: number }) => p, getOverlaySnapThreshold: () => 8, getShapeAtPoint: () => undefined, getOpenStrokeShapeAtPoint: () => undefined, refreshAnchorMeasurements: () => ({ rects: new Map(), ordered: [] }) };
  const drawing = { getSnappedDrawingPoint: (p: { x: number; y: number }) => p, getSnappedInsertDragPoint: (_tool: unknown, _start: unknown, p: { x: number; y: number }) => p, createShapeFromInsertDrag: () => null };
  const transforms = { applyMoveInteractionAtPoint: noop, applyResizeInteractionAtPoint: noop, applyPointInteractionAtPoint: noop, applyImageCropInteractionAtPoint: noop };
  let session!: ReturnType<typeof useOverlayPointerSession>; let handlers!: ReturnType<typeof useOverlayPointerLifecycle>;
  function Harness() {
    session = useOverlayPointerSession({ documentId: "doc", modeRef, transitionMode, bleedSurfaceRef });
    handlers = useOverlayPointerLifecycle({
      session, editing: { shapesRef, setShapes: updateShapes, editPolicyLockedShapeIdsRef: { current: new Set() } }, selection, geometry, drawing, transforms,
      clearSnapGuides: noop, setAdjustmentDragReadoutPointerPosition: noop, canvasRef: bleedSurfaceRef, autoScrollPanBy: undefined, autoScrollViewportElement: null,
      originPickShapeId: null, updateOriginPickPreviewFromEvent: noop, setHoverSolidEdge: noop, mode: modeRef.current, cancelTablePlacement: noop,
      restoreTransientInteraction: restore, setRegionSelection: noop, handledCommandRequestIdRef: { current: null }, queueOverlaySave: save, documentId: "doc",
      onRequestTextMode: noop, retainEmptySelection: false, externalRevision: 0, onRequestTextSelection: undefined, queueDirtyImageCropSave: noop
    });
    return null;
  }
  const root = createRoot(document.createElement("div")); await act(async () => root.render(<Harness />));
  const begin = (id: number) => { transitionMode({ type: "startMove", shapes: [base], start: { x: base.x, y: base.y } }); session.capturePointer({ pointerId: id, clientX: base.x, clientY: base.y } as ReactPointerEvent<Element>); };
  begin(1); transitionMode({ type: "updateMove", offset: { x: 30, y: 0 } });
  await act(async () => handlers.handlePointerUp({ pointerId: 1, clientX: 40, clientY: 20 } as ReactPointerEvent<HTMLDivElement>));
  expect(shapesRef.current[0].x).toBe(40); expect(save).toHaveBeenCalledOnce(); expect(captured.size).toBe(0);
  begin(2); shapesRef.current = [{ ...base, x: 70 }]; await act(async () => handlers.handlePointerCancel());
  expect(shapesRef.current).toEqual([base]); expect(modeRef.current.id).toBe("overlay.select"); expect(save).toHaveBeenCalledOnce(); expect(captured.size).toBe(0);
  begin(3); shapesRef.current = [{ ...base, x: 100 }]; await act(async () => root.unmount());
  expect(shapesRef.current).toEqual([base]); expect(save).toHaveBeenCalledOnce(); expect(captured.size).toBe(0); expect(restore).toHaveBeenCalledTimes(2);
});
