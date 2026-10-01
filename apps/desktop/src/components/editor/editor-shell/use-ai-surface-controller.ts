"use client";

import { readRightDockPreference,saveRightDockPreference } from "@/features/right-dock/model/right-dock-preference";
import { closeRightDock,closeRightDockPage,closeRightDockToolIfShowing,INITIAL_RIGHT_DOCK_STATE,isRightDockShowing,openRightDock,openRightDockTool,RIGHT_DOCK_DEFAULT_WIDTH,type RightDockState } from "@/features/right-dock/model/right-dock-state";
import { useCallback,useEffect,useRef,useState } from "react";
import type { AiDisplayMode,AiSurfaceState,EditorAssistanceServices } from "./editor-host-contracts";

type SurfaceTransitions = Pick<EditorAssistanceServices, "openInline" | "promoteToSidebar" | "closeSurface">;
interface AiSurfacePorts {
  isDesktopApp: boolean;
  transitions: SurfaceTransitions;
  dismissVersionHistory: () => void;
  clearRunAnchor: () => void;
  hasRunAnchor: () => boolean;
  clearAiEditPinnedReferences: () => void;
  clearAiEditPreview: () => void;
}
export function useAiSurfaceController({ isDesktopApp, transitions: { openInline, promoteToSidebar, closeSurface }, dismissVersionHistory, clearRunAnchor, hasRunAnchor, clearAiEditPinnedReferences, clearAiEditPreview }: AiSurfacePorts) {
  const [rightDock, setRightDock] = useState<RightDockState>(INITIAL_RIGHT_DOCK_STATE);
  const [rightDockWidth, setRightDockWidth] = useState(RIGHT_DOCK_DEFAULT_WIDTH);
  const rightDockPreferenceLoadedRef = useRef(false);
  const aiSidebarOpen = isRightDockShowing(rightDock, "chat");
  const [aiDisplayMode, setAiDisplayMode] = useState<AiDisplayMode>("inline");
  const [aiInlineOpen, setAiInlineOpen] = useState(false);
  const [aiInlineAnchor, setAiInlineAnchor] = useState<{ left: number; top: number } | null>(null);
  const [aiInlineSessionId, setAiInlineSessionId] = useState(0);
  const [aiInlineClosing, setAiInlineClosing] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const inlineCloseTimerRef = useRef<number | null>(null);
  const cancelInlineCloseTimer = useCallback(() => {
    if (inlineCloseTimerRef.current !== null) window.clearTimeout(inlineCloseTimerRef.current);
    inlineCloseTimerRef.current = null;
  }, []);
  useEffect(() => cancelInlineCloseTimer, [cancelInlineCloseTimer]);
  const applyAiSurface = useCallback((next: AiSurfaceState) => {
    cancelInlineCloseTimer();
    setAiInlineClosing(false);
    setAiDisplayMode(next.displayMode);
    setRightDock((current) => (
      next.aiSidebarOpen ? openRightDockTool(current, "chat") : closeRightDockToolIfShowing(current, "chat")
    ));
    setAiInlineOpen(next.aiInlineOpen);
  }, [cancelInlineCloseTimer, setRightDock]);

  const openAiInline = useCallback((anchor: { left: number; top: number } | null) => {
    // Web版にAIチャット面は無い (AI面はキャンバス左上のAiTaskDock一本)。⌘Kや
    // コマンドパレットからこの経路に入っても、空のパネルを開かせない。
    if (!isDesktopApp) {
      return;
    }
    dismissVersionHistory();
    // Reset the anchor unconditionally: a null anchor (⌘K with no selection) must
    // fall back to the CSS default position rather than reuse a stale selection rect.
    setAiInlineAnchor(anchor);
    // Bump the session id so the inline editor starts on a fresh input (rather than
    // re-showing a prior turn's result) each time it is opened.
    setAiInlineSessionId((current) => current + 1);
    applyAiSurface(openInline());
  }, [applyAiSurface, isDesktopApp, openInline, dismissVersionHistory]);

  const promoteAiToSidebar = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }
    dismissVersionHistory();
    clearRunAnchor();
    // 会話があっても、本文と同じ大きさのタブにはしない。右のサイドバーに開いて、本文と並べて使う。
    applyAiSurface(promoteToSidebar());
  }, [applyAiSurface, isDesktopApp, promoteToSidebar, dismissVersionHistory, clearRunAnchor]);

  // サイドバーを開く。開いていたページに戻り、無ければ Hub を出す。版履歴と同じ列を使うので、開くときは版履歴を閉じる。
  const openRightDockSurface = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }
    dismissVersionHistory();
    setRightDock(openRightDock);
  }, [isDesktopApp, setRightDock, dismissVersionHistory]);

  const closeAiSurface = useCallback(() => {
    // Closing the inline editor discards a single-shot result, so drop the floating
    // body preview it left behind (clearAiEditPreview also dismisses the pending
    // turn) and the references pinned during that inline session. Closing the
    // docked sidebar must stay non-destructive: just hide the panel and leave any
    // unapplied proposal AND pinned references recoverable on reopen.
    if (aiDisplayMode === "inline" && aiInlineOpen) {
      setAiInlineClosing(true);
      cancelInlineCloseTimer();
      inlineCloseTimerRef.current = window.setTimeout(() => {
        inlineCloseTimerRef.current = null;
        const closingInline = aiDisplayMode === "inline";
        applyAiSurface(closeSurface());
        setAiInlineClosing(false);
        if (closingInline) {
          clearAiEditPinnedReferences();
          if (!hasRunAnchor()) {
            clearAiEditPreview();
          }
        }
      }, 140);
      return;
    }

    const closingInline = aiDisplayMode === "inline";
    applyAiSurface(closeSurface());
    if (closingInline) {
      clearAiEditPinnedReferences();
      if (!hasRunAnchor()) {
        clearAiEditPreview();
      }
    }
  }, [aiDisplayMode, aiInlineOpen, applyAiSurface, clearAiEditPinnedReferences, clearAiEditPreview, closeSurface, cancelInlineCloseTimer, hasRunAnchor]);

  // サイドバー右上の ×。開いているページは残したまま、サイドバーだけを閉じる (開き直すと同じページに戻る)。
  const collapseRightDock = useCallback(() => setRightDock(closeRightDock), [setRightDock]);

  // チャットのタブの ×。見せているときはAI面の閉じ方 (未適用の提案を残す) に揃え、見せていなければタブだけを外す。
  const closeRightDockChat = useCallback(() => {
    if (isRightDockShowing(rightDock, "chat")) {
      closeAiSurface();
      return;
    }
    setRightDock((current) => closeRightDockPage(current, "chat"));
  }, [closeAiSurface, rightDock, setRightDock]);

  // 開閉と開いていたページは引き継がず、幅だけを次回へ引き継ぐ。読む前に書かない。
  useEffect(() => {
    const preference = readRightDockPreference();
    // 保存済みの好みは hydration の後でしか読めない (SSR の初回描画と一致させるため)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRightDockWidth(preference.width);
    rightDockPreferenceLoadedRef.current = true;
  }, []);
  useEffect(() => {
    if (rightDockPreferenceLoadedRef.current) {
      saveRightDockPreference({ width: rightDockWidth });
    }
  }, [rightDockWidth]);

  return { rightDock, setRightDock, rightDockWidth, setRightDockWidth, aiSidebarOpen, aiDisplayMode, aiInlineOpen, aiInlineAnchor, setAiInlineAnchor, aiInlineSessionId, aiInlineClosing, aiSettingsOpen, setAiSettingsOpen, applyAiSurface, openAiInline, promoteAiToSidebar, openRightDockSurface, closeAiSurface, collapseRightDock, closeRightDockChat };
}
