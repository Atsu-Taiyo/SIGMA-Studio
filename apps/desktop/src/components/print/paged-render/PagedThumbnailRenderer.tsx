"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  PagedRenderSurface,
  type PagedRenderStateSnapshot,
} from "@/components/print/paged-render/PagedRenderSurface";
import { findPagedFirstPage, rasterizePagedPageTopHalf } from "@/components/print/rasterize-print-thumbnail";
import type { OutputProfileName, SigmaDocument } from "@/features/document";

/**
 * A late decorating pass can rebuild the page windows after the surface first
 * reports `ready` (see PagedRenderSurface). Capture only once the revision has
 * stopped changing for this long.
 */
const QUIET_AFTER_READY_MS = 350;

/**
 * Each render mounts a full page canvas. Rendering them one at a time keeps a
 * workspace with many cards from stalling the editor while thumbnails fill in.
 */
const MAX_CONCURRENT_RENDERS = 1;
let activeRenders = 0;
const waiting: Array<() => void> = [];

function acquireRenderSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      activeRenders += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeRenders -= 1;
        waiting.shift()?.();
      });
    };
    if (activeRenders < MAX_CONCURRENT_RENDERS) grant();
    else waiting.push(grant);
  });
}

/**
 * Renders a document's first page with the print preview's own surface
 * (`PagedRenderSurface`, the editor canvas cut into paper windows) off screen, and
 * reports the top half as a PNG. There is no thumbnail-specific layout: a
 * thumbnail is exactly what the print preview and the PDF show.
 */
export function PagedThumbnailRenderer({
  document,
  profile = "teacher",
  onRendered,
  onFailed,
}: {
  document: SigmaDocument;
  profile?: OutputProfileName;
  onRendered: (dataUrl: string) => void;
  onFailed: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [slotHeld, setSlotHeld] = useState(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const captureTimerRef = useRef(0);
  const doneRef = useRef(false);
  const callbacksRef = useRef({ onRendered, onFailed });
  useEffect(() => {
    callbacksRef.current = { onRendered, onFailed };
  }, [onRendered, onFailed]);

  useEffect(() => {
    let cancelled = false;
    void acquireRenderSlot().then((release) => {
      if (cancelled) {
        release();
        return;
      }
      releaseRef.current = release;
      setSlotHeld(true);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(captureTimerRef.current);
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, []);

  const finish = useCallback((result: { dataUrl: string } | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    releaseRef.current?.();
    releaseRef.current = null;
    if (result) callbacksRef.current.onRendered(result.dataUrl);
    else callbacksRef.current.onFailed();
  }, []);

  const handleRenderState = useCallback((snapshot: PagedRenderStateSnapshot) => {
    window.clearTimeout(captureTimerRef.current);
    if (doneRef.current) return;
    if (snapshot.state === "stalled") {
      finish(null);
      return;
    }
    if (snapshot.state !== "ready") return;
    captureTimerRef.current = window.setTimeout(() => {
      const page = hostRef.current ? findPagedFirstPage(hostRef.current) : null;
      if (!page) {
        finish(null);
        return;
      }
      void rasterizePagedPageTopHalf(page)
        .then((dataUrl) => finish({ dataUrl }))
        .catch(() => finish(null));
    }, QUIET_AFTER_READY_MS);
  }, [finish]);

  if (!slotHeld || typeof window === "undefined") return null;
  // Portaled to <body>: the caller is often a card button, and the page canvas must
  // neither nest its own controls inside it nor inherit the card's text styles.
  return createPortal(
    <div ref={hostRef} className="paged-thumbnail-host" aria-hidden="true" inert>
      <PagedRenderSurface document={document} profile={profile} onRenderStateChange={handleRenderState} />
    </div>,
    window.document.body,
  );
}
