"use client";

import { describeWindowCloseSkipReason,resolveWindowCloseOutcome,shouldUsePageVisibilityBoundaryEvents } from "@/components/editor/editor-shell/window-close-save";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createTranslator } from "@/lib/i18n";
import { useCallback,useEffect,useRef,useState } from "react";

import type { DocumentBoundarySkipReason } from "./workspace-request";

interface WindowClosePorts {
  attemptBoundarySave: (reason: "tab-switch" | "app-close") => Promise<{ ok: boolean; error?: string; skipped?: boolean; skippedReason?: DocumentBoundarySkipReason }>;
  isCurrentDocumentDirty: () => boolean;
  cleanupUntouchedDraftsBeforeClose: () => Promise<{ ok: boolean; error?: string }>;
  tE: ReturnType<typeof createTranslator<"editor">>;
}
export function useWindowCloseBoundary({ attemptBoundarySave, isCurrentDocumentDirty, cleanupUntouchedDraftsBeforeClose, tE }: WindowClosePorts) {
  const [windowCloseSaveDialog, setWindowCloseSaveDialog] = useState<{
    error: string;
    saving: boolean;
  } | null>(null);
  const disposedRef = useRef(false);
  const closeTimeoutsRef = useRef(new Set<number>());
  const windowCloseAttemptGenerationRef = useRef(0);
  const windowCloseResolvedRef = useRef(false);

  const finishWindowCloseSave = useCallback(async (action: "ready" | "cancel") => {
    if (disposedRef.current) return;
    const desktopApp = getDesktopBridge()?.app;
    const generation = ++windowCloseAttemptGenerationRef.current;
    windowCloseResolvedRef.current = action === "ready";
    const request = action === "ready"
      ? desktopApp?.notifyCloseReady?.()
      : desktopApp?.cancelCloseRequest?.();
    try {
      const succeeded = await request;
      if (disposedRef.current || generation !== windowCloseAttemptGenerationRef.current) return;
      if (succeeded) {
        setWindowCloseSaveDialog(null);
        return;
      }
    } catch (error) {
      console.warn(`Failed to report app-close ${action}.`, error);
    }
    if (disposedRef.current || generation !== windowCloseAttemptGenerationRef.current) return;
    setWindowCloseSaveDialog({
      error: tE("windowCloseSave.responseFailed"),
      saving: false,
    });
  }, [tE]);

  const attemptWindowCloseSave = useCallback(async () => {
    if (disposedRef.current) return;
    const attemptGeneration = ++windowCloseAttemptGenerationRef.current;
    setWindowCloseSaveDialog((current) => current ? { ...current, saving: true } : current);
    let timeoutId: number | undefined;
    let timedOut = false;
    let saveResult: Awaited<ReturnType<typeof attemptBoundarySave>> = { ok: false };
    try {
      saveResult = await Promise.race([
        attemptBoundarySave("app-close"),
        new Promise<Awaited<ReturnType<typeof attemptBoundarySave>>>((resolve) => {
          timeoutId = window.setTimeout(() => {
            timedOut = true;
            resolve({ ok: false, error: tE("windowCloseSave.timedOut") });
          }, 15_000);
          closeTimeoutsRef.current.add(timeoutId);
        }),
      ]);
    } catch (error) {
      saveResult = {
        ok: false,
        error: error instanceof Error ? error.message : tE("windowCloseSave.unknownError"),
      };
    } finally {
      if (timeoutId !== undefined) { window.clearTimeout(timeoutId); closeTimeoutsRef.current.delete(timeoutId); }
    }
    if (disposedRef.current || attemptGeneration !== windowCloseAttemptGenerationRef.current) return;

    const outcome = resolveWindowCloseOutcome({
      saveOk: saveResult.ok,
      saveError: saveResult.error,
      timedOut,
      dirty: isCurrentDocumentDirty(),
      skipped: saveResult.skipped === true,
      skippedReason: saveResult.skippedReason,
    });
    if (outcome === "ready") {
      const cleanup = await cleanupUntouchedDraftsBeforeClose();
      if (disposedRef.current || attemptGeneration !== windowCloseAttemptGenerationRef.current) return;
      if (!cleanup.ok) {
        setWindowCloseSaveDialog({ error: cleanup.error ?? tE("windowCloseSave.unknownError"), saving: false });
        return;
      }
      await finishWindowCloseSave("ready");
      return;
    }
    const skippedReasonKey = describeWindowCloseSkipReason(saveResult.skippedReason);
    setWindowCloseSaveDialog({
      error: saveResult.error
        ?? (skippedReasonKey ? tE(skippedReasonKey) : tE("windowCloseSave.unknownError")),
      saving: false,
    });
  }, [attemptBoundarySave, cleanupUntouchedDraftsBeforeClose, finishWindowCloseSave, isCurrentDocumentDirty, tE]);

  const attemptWindowClose = useCallback(() => {
    const desktopApp = getDesktopBridge()?.app;
    if (!desktopApp?.notifyCloseReady) return;
    const acknowledgement = desktopApp.acknowledgeCloseRequest?.();
    void acknowledgement?.catch((error) => {
      console.warn("Failed to acknowledge the app-close request.", error);
    });
    void attemptWindowCloseSave();
  }, [attemptWindowCloseSave]);

  useEffect(() => {
    const desktopApp = getDesktopBridge()?.app;
    const handleVisibilityChange = () => {
      if (windowCloseResolvedRef.current) return;
      if (window.document.visibilityState === "hidden") {
        void attemptBoundarySave("tab-switch").catch(() => undefined);
      }
    };
    const handlePageHide = () => {
      if (windowCloseResolvedRef.current) return;
      void attemptBoundarySave("app-close").catch(() => undefined);
    };
    if (shouldUsePageVisibilityBoundaryEvents(Boolean(desktopApp))) {
      window.document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pagehide", handlePageHide);
    }

    const unsubscribeClose = desktopApp?.onCloseRequested?.(() => {
      void attemptWindowClose();
    });
    return () => {
      window.document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      unsubscribeClose?.();
    };
  }, [attemptBoundarySave, attemptWindowClose]);

  useEffect(() => {
    disposedRef.current = false;
    const timers = closeTimeoutsRef.current;
    return () => {
      disposedRef.current = true;
      windowCloseAttemptGenerationRef.current += 1;
      for (const timeoutId of timers) window.clearTimeout(timeoutId);
      timers.clear();
    };
  }, []);
  return { windowCloseSaveDialog, attemptWindowCloseSave, finishWindowCloseSave };
}
