"use client";

import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopUpdateState } from "@/types/desktop";
import { useEffect,useRef,useState } from "react";
import { tEditor } from "./editor-translations";

import { useEditorOwnerLifetime } from "./use-editor-owner-lifetime";

export function useDesktopUpdateController(isDesktopApp: boolean, setStatusMessage: (message: string) => void) {
  const captureLifetime = useEditorOwnerLifetime();
  const [appUpdateState, setAppUpdateState] = useState<DesktopUpdateState | null>(null);
  const [appUpdateActionBusy, setAppUpdateActionBusy] = useState(false);
  const appUpdateAutoCheckStartedRef = useRef(false);
  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    const bridge = getDesktopBridge();
    if (!bridge?.updater) {
      return;
    }
    const { updater } = bridge;

    let cancelled = false;
    const applyUpdateState = (state: DesktopUpdateState) => {
      if (!cancelled) {
        setAppUpdateState(state);
      }
    };

    updater.getStatus().then((state) => {
      if (cancelled) return;
      applyUpdateState(state);
      if (!state.supported || state.phase !== "idle" || appUpdateAutoCheckStartedRef.current) {
        return;
      }

      appUpdateAutoCheckStartedRef.current = true;
      void updater.checkForUpdates().then(applyUpdateState).catch(() => undefined);
    }).catch(() => undefined);

    const unsubscribe = updater.onStatusChange(applyUpdateState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isDesktopApp]);

  const titleUpdatePhase = appUpdateState?.phase;
  const showTitleUpdateButton = titleUpdatePhase === "available" || titleUpdatePhase === "downloading" || titleUpdatePhase === "downloaded";
  const titleUpdateButtonDisabled = appUpdateActionBusy || titleUpdatePhase === "downloading";
  const handleTitleUpdateAction = async () => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    const bridge = getDesktopBridge();
    if (!bridge?.updater || !appUpdateState) {
      return;
    }

    setAppUpdateActionBusy(true);
    try {
      if (appUpdateState.phase === "downloaded") {
        const result = await bridge.updater.quitAndInstall();
        if (!isCurrent()) return;
        if (!result.ok) {
          setStatusMessage(result.error);
        }
        return;
      }

      setStatusMessage(tEditor("status.updateDownloading"));
      const result = await bridge.updater.downloadUpdate();
      if (!isCurrent()) return;
      setAppUpdateState(result);
      if (result.phase === "downloaded") {
        setStatusMessage(tEditor("status.updateReady"));
      } else if (result.phase === "error") {
        setStatusMessage(result.error ?? tEditor("status.updateDownloadFailed"));
      }
    } catch (error) {
      if (!isCurrent()) return;
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.updateStartFailed"));
    } finally {
      if (isCurrent()) setAppUpdateActionBusy(false);
    }
  };
  return { appUpdateState, showTitleUpdateButton, titleUpdateButtonDisabled, handleTitleUpdateAction };
}
