"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/** Measure the floating UI itself; document zoom and pagination do not own its bounds. */
export function useAiInlineViewport(hostRef: RefObject<HTMLElement | null>, visible: boolean) {
  const [bounds, setBounds] = useState({ width: 0, height: 0, hostHeight: 0 });
  useLayoutEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    const measure = () => {
      const next = { width: window.innerWidth, height: window.innerHeight, hostHeight: host?.offsetHeight ?? 0 };
      setBounds(current => current.width === next.width && current.height === next.height
        && current.hostHeight === next.hostHeight ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (host) observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hostRef, visible]);
  return bounds;
}
