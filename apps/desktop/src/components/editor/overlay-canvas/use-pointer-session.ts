"use client";
import { ZERO_BOUNDS_PADDING } from "@/features/drawing";
import { useCallback, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { DragAutoScroller } from "../drag-auto-scroll";
import type { OverlayInteractionAction, OverlayInteractionMode } from "./interaction-mode";
import type { OverlayPoint } from "./types";

/** One pointer/capture lifetime shared by start, transforms and finalization. */
export function useOverlayPointerSession({ documentId, modeRef, transitionMode, bleedSurfaceRef }: {
  documentId?: string;
  modeRef: RefObject<OverlayInteractionMode>;
  transitionMode(action: OverlayInteractionAction): void;
  bleedSurfaceRef: RefObject<HTMLDivElement | null>;
}) {
  const lastInteractionPointRef = useRef<OverlayPoint | null>(null);
  const dragPointerRef = useRef<{ pointerId: number; startClientX: number; startClientY: number; autoScrollArmed: boolean } | null>(null);
  const dragCanvasRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const lastPointerModifiersRef = useRef({ ctrlKey: false, shiftKey: false });
  const advanceInteractionFromClientRef = useRef<(clientX: number, clientY: number, modifiers: { ctrlKey: boolean; shiftKey: boolean }, rect?: { left: number; top: number; width: number; height: number } | null) => void>(() => { });
  const resizePaddingRef = useRef(ZERO_BOUNDS_PADDING);
  const suppressNextShapeDoubleClickRef = useRef(0);
  const dragAutoScrollerRef = useRef<DragAutoScroller | null>(null);
  const capturePointer = useCallback((event: ReactPointerEvent<Element>) => {
    dragPointerRef.current = { pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, autoScrollArmed: false };
    bleedSurfaceRef.current?.setPointerCapture(event.pointerId);
  }, [bleedSurfaceRef]);
  const releasePointer = useCallback(() => {
    const pointerId = dragPointerRef.current?.pointerId;
    if (pointerId !== undefined && bleedSurfaceRef.current?.hasPointerCapture(pointerId)) bleedSurfaceRef.current.releasePointerCapture(pointerId);
    dragPointerRef.current = null;
    dragCanvasRectRef.current = null;
    dragAutoScrollerRef.current?.stop();
    dragAutoScrollerRef.current = null;
  }, [bleedSurfaceRef]);
  useLayoutEffect(() => releasePointer, [documentId, releasePointer]);
  return useMemo(() => ({
    modeRef,
    transitionMode,
    bleedSurfaceRef,
    lastInteractionPointRef,
    dragPointerRef,
    dragCanvasRectRef,
    lastPointerModifiersRef,
    advanceInteractionFromClientRef,
    resizePaddingRef,
    suppressNextShapeDoubleClickRef,
    dragAutoScrollerRef,
    capturePointer,
    releasePointer,
  }), [modeRef, transitionMode, bleedSurfaceRef, capturePointer, releasePointer]);
}
export type OverlayPointerSession = ReturnType<typeof useOverlayPointerSession>;
