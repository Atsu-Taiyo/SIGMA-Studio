"use client";

import { viewportToCanvasAnchor } from "@/components/editor/page-canvas/popover-anchors";
import { useCallback,useEffect,useRef,useState } from "react";

export function useAiInlineGeometry(zoom: number, AI_INLINE_ANCHOR_OFFSET_Y: number) {
  const [aiInlineRunAnchor, setAiInlineRunAnchor] = useState<{ left: number; top: number } | null>(null);
  const [aiInlineRunAnchorCanvas, setAiInlineRunAnchorCanvas] = useState<{ left: number; top: number } | null>(null);
  const [aiInlineRunPortal, setAiInlineRunPortal] = useState<HTMLElement | null>(null);
  const pageCanvasRef = useRef<HTMLElement | null>(null);
  const aiInlineRunAnchorRef = useRef<{ left: number; top: number } | null>(null);
  useEffect(() => {
    aiInlineRunAnchorRef.current = aiInlineRunAnchor;
  }, [aiInlineRunAnchor]);

  const syncInlineRunAnchorCanvas = useCallback((viewportAnchor: { left: number; top: number } | null) => {
    if (!viewportAnchor || !pageCanvasRef.current) {
      setAiInlineRunAnchorCanvas(null);
      return;
    }
    setAiInlineRunAnchorCanvas(viewportToCanvasAnchor({
      left: viewportAnchor.left,
      top: viewportAnchor.top + AI_INLINE_ANCHOR_OFFSET_Y,
    }, pageCanvasRef.current));
  }, [AI_INLINE_ANCHOR_OFFSET_Y]);

  const handleInlineRunAnchorChange = useCallback((anchor: { left: number; top: number } | null) => {
    setAiInlineRunAnchor(anchor);
    syncInlineRunAnchorCanvas(anchor);
  }, [syncInlineRunAnchorCanvas]);

  useEffect(() => {
    syncInlineRunAnchorCanvas(aiInlineRunAnchor);
  }, [aiInlineRunAnchor, syncInlineRunAnchorCanvas, zoom]);

  useEffect(() => {
    if (!aiInlineRunAnchor) {
      return;
    }
    const handleViewportChange = () => syncInlineRunAnchorCanvas(aiInlineRunAnchor);
    window.addEventListener("resize", handleViewportChange);
    return () => window.removeEventListener("resize", handleViewportChange);
  }, [aiInlineRunAnchor, syncInlineRunAnchorCanvas]);

  // Stable identity so PageCanvasEditor's portal-ready effect (which fires this
  // as a cleanup/setup pair keyed on this callback) doesn't re-run on every
  // EditorShell render — an inline arrow here previously caused an infinite
  // setState(null)/setState(portal) render loop once an inline run started.
  const handleInlineRunPortalReady = useCallback((portal: HTMLElement | null) => {
    setAiInlineRunPortal(portal);
    if (portal) {
      pageCanvasRef.current = portal.closest<HTMLElement>(".page-canvas");
    } else {
      pageCanvasRef.current = null;
    }
    syncInlineRunAnchorCanvas(aiInlineRunAnchorRef.current);
  }, [syncInlineRunAnchorCanvas]);
  return { aiInlineRunAnchor, setAiInlineRunAnchor, aiInlineRunAnchorCanvas, setAiInlineRunAnchorCanvas, aiInlineRunPortal, aiInlineRunAnchorRef, handleInlineRunAnchorChange, handleInlineRunPortalReady };
}
