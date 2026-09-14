"use client";

import { useEffect } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useStableCallback } from "@/lib/react/use-stable-callback";
import type { DesktopExternalDocument } from "@/types/desktop";

/** Subscribe before draining: files can arrive before the library/editor has mounted. */
export function useExternalDocumentOpen(
  ready: boolean,
  openDocument: (document: DesktopExternalDocument) => Promise<boolean>,
  onError: (error: unknown) => void,
): void {
  const open = useStableCallback(openDocument);
  const reportError = useStableCallback(onError);
  useEffect(() => {
    const file = getDesktopBridge()?.file;
    if (!ready || !file?.getPendingOpenDocument || !file.acknowledgeOpenDocument || !file.onOpenDocumentAvailable) return;
    let disposed = false;
    let draining = false;
    let requested = false;
    const drain = async () => {
      if (disposed) return;
      requested = true;
      if (draining) return;
      draining = true;
      try {
        do {
          requested = false;
          while (!disposed) {
            const pending = await file.getPendingOpenDocument!();
            if (!pending || disposed) break;
            // A failed save requires another user open request; never busy-retry it.
            if (!(await open(pending))) return;
            await file.acknowledgeOpenDocument!(pending.id);
          }
        } while (requested && !disposed);
      } catch (error) {
        reportError(error);
      } finally {
        draining = false;
      }
    };
    const unsubscribe = file.onOpenDocumentAvailable(() => { void drain(); });
    void drain();
    return () => { disposed = true; unsubscribe(); };
  }, [ready, open, reportError]);
}
