"use client";

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import type { ClientPoint } from "./caret-focus";

/** Owns the native pointer lifecycle while a static preview becomes an editable overlay. */
export function useOverlayPreviewHandoff(
  onComplete: (bounds: DOMRect, start: ClientPoint, end: ClientPoint, targetShapeId?: string) => void,
  onActivate: () => void,
) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanupRef.current?.(); cleanupRef.current = null; }, []);

  return useCallback((event: ReactPointerEvent<HTMLDivElement>, bounds: DOMRect, targetShapeId?: string) => {
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current?.();
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const pointerType = event.pointerType;
    const matches = (native: PointerEvent) => native.pointerId === pointerId || (native.pointerType === "mouse" && pointerType === "mouse");
    const finish = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (cleanupRef.current === finish) cleanupRef.current = null;
    };
    function move(native: PointerEvent) {
      if (!matches(native)) return;
      native.preventDefault();
      native.stopPropagation();
    }
    function up(native: PointerEvent) {
      if (!matches(native)) return;
      try {
        onComplete(bounds, start, { x: native.clientX, y: native.clientY }, targetShapeId);
        native.preventDefault();
        native.stopPropagation();
      } finally {
        finish();
      }
    }
    cleanupRef.current = finish;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    flushSync(onActivate);
  }, [onActivate, onComplete]);
}
