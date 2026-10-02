"use client";

import { useCallback, useEffect, useRef } from "react";

/** One draft owns its outstanding reads and deferred focus/selection work. */
export function useAiComposerLifetime(documentIdentityKey: string) {
  const controllerRef = useRef(new AbortController());
  const timers = useRef(new Set<number>());
  const frames = useRef(new Set<number>());
  const invalidate = useCallback(() => {
    controllerRef.current.abort();
    controllerRef.current = new AbortController();
    for (const timer of timers.current) window.clearTimeout(timer);
    for (const frame of frames.current) window.cancelAnimationFrame(frame);
    timers.current.clear();
    frames.current.clear();
  }, []);

  useEffect(() => {
    invalidate();
    const currentTimers = timers.current;
    const currentFrames = frames.current;
    return () => {
      // A room reset may have replaced the controller since this effect ran.
      controllerRef.current.abort();
      for (const timer of currentTimers) window.clearTimeout(timer);
      for (const frame of currentFrames) window.cancelAnimationFrame(frame);
      currentTimers.clear();
      currentFrames.clear();
    };
  }, [documentIdentityKey, invalidate]);

  const capture = useCallback(() => {
    const controller = controllerRef.current;
    return { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  }, []);
  const defer = useCallback((callback: () => void, animationFrame = false) => {
    const controller = controllerRef.current;
    if (animationFrame) {
      const handle = window.requestAnimationFrame(() => {
        frames.current.delete(handle);
        if (!controller.signal.aborted) callback();
      });
      frames.current.add(handle);
    } else {
      const handle = window.setTimeout(() => {
        timers.current.delete(handle);
        if (!controller.signal.aborted) callback();
      }, 0);
      timers.current.add(handle);
    }
  }, []);
  return { invalidate, capture, defer };
}
