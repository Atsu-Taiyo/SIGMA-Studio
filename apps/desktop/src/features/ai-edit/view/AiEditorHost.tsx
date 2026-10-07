"use client";

import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode, RefObject } from "react";

import {
  AI_INLINE_DEFAULT_LEFT_PX,
  AI_INLINE_DEFAULT_TOP_PX,
  AI_INLINE_DRAG_BOTTOM_MARGIN_PX,
  AI_INLINE_HOST_BOTTOM_CLEARANCE_PX,
  AI_INLINE_VIEWPORT_MARGIN_PX,
  getAiInlineDragPosition,
  getAiInlineHostPosition,
  getAiInlineTopBoundary,
  type AiInlineAnchor,
} from "@/components/editor/ai-inline-placement";
import type { AiDisplayMode, AiSurfaceResolution } from "@/lib/ai/ai-surface";
import { useAiInlineDrag } from "./use-ai-inline-drag";
import { useAiInlineViewport } from "./use-ai-inline-viewport";

export interface AiEditorHostProps {
  enabled: boolean;
  displayMode: AiDisplayMode;
  surface: AiSurfaceResolution;
  inlineOpen: boolean;
  inlineClosing: boolean;
  inlineAnchor: AiInlineAnchor | null;
  inlineRunAnchor: AiInlineAnchor | null;
  inlineSessionId: number;
  editorCanvasRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}

/**
 * インラインAI入力の配置と操作面 (本文の上に重ねる浮動パネル)。提案・参照・文書の state は
 * children の composition が所有する。サイドチャットは右のサイドバー (features/right-dock) が
 * 載せるので、ここでは描かない。
 */
export function AiEditorHost({
  enabled,
  displayMode,
  surface,
  inlineOpen,
  inlineClosing,
  inlineAnchor,
  inlineRunAnchor,
  inlineSessionId,
  editorCanvasRef,
  onClose,
  children,
}: AiEditorHostProps) {
  const isInlineHost = displayMode === "inline";
  const hostVisible = surface.hostVisible || inlineClosing
    || (isInlineHost && inlineRunAnchor !== null && !inlineOpen);
  const hostAnchor = inlineOpen ? inlineAnchor : inlineRunAnchor;
  const { hostRef, position: dragPosition, handlers } = useAiInlineDrag({
    enabled: enabled && isInlineHost,
    sessionId: inlineSessionId,
  });
  const bounds = useAiInlineViewport(hostRef, enabled && isInlineHost && hostVisible);
  if (!enabled || !isInlineHost) return null;

  const inlineViewport = isInlineHost && hostVisible && typeof window !== "undefined"
    ? { width: bounds.width || window.innerWidth, height: bounds.height || window.innerHeight }
    : null;
  const inlineTopBoundary = inlineViewport ? getAiInlineTopBoundary() : null;
  const autoPosition = inlineViewport && inlineTopBoundary !== null
    ? hostAnchor
      ? getAiInlineHostPosition(hostAnchor, inlineViewport, {
          topBoundary: inlineTopBoundary,
          bottomClearance: Math.max(AI_INLINE_HOST_BOTTOM_CLEARANCE_PX, bounds.hostHeight + AI_INLINE_VIEWPORT_MARGIN_PX),
        })
      : getAiInlineDragPosition(
          { left: AI_INLINE_DEFAULT_LEFT_PX, top: AI_INLINE_DEFAULT_TOP_PX },
          inlineViewport,
          { topBoundary: inlineTopBoundary, bottomMargin: Math.max(AI_INLINE_DRAG_BOTTOM_MARGIN_PX, bounds.hostHeight + AI_INLINE_VIEWPORT_MARGIN_PX) },
        )
    : null;
  const renderPosition = dragPosition && inlineViewport && inlineTopBoundary !== null
    ? getAiInlineDragPosition(dragPosition, inlineViewport, {
        topBoundary: inlineTopBoundary,
        bottomMargin: Math.max(AI_INLINE_DRAG_BOTTOM_MARGIN_PX, bounds.hostHeight + AI_INLINE_VIEWPORT_MARGIN_PX),
      })
    : autoPosition;
  const host = (
    <>
      {(surface.catcherVisible || inlineClosing) && (
        <div
          className={`ai-inline-catcher${inlineClosing ? " ai-inline-catcher--closing" : ""}`.trim()}
          role="presentation"
          // 透明な幕。開いたまま、下の紙面から範囲スクリーンショットを始められるようにする。
          data-region-capture-passthrough="true"
          onMouseDown={onClose}
          onWheel={(event) => {
            const scroller = editorCanvasRef.current;
            if (!scroller) return;
            const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
            scroller.scrollBy({ top: event.deltaY * factor, left: event.deltaX * factor });
          }}
        />
      )}
      <aside
        ref={hostRef}
        className={[
          "ai-sidebar-panel",
          surface.hostClassName,
          hostVisible ? "" : "is-hidden",
          inlineClosing ? "ai-chat-host--closing" : "",
        ].filter(Boolean).join(" ")}
        aria-label="AI"
        aria-hidden={!hostVisible}
        {...handlers}
        style={renderPosition && inlineViewport && inlineTopBoundary !== null ? {
          left: `${renderPosition.left}px`, top: `${renderPosition.top}px`,
          "--ai-inline-max-height": `${Math.max(0, inlineViewport.height - inlineTopBoundary - AI_INLINE_VIEWPORT_MARGIN_PX)}px`,
        } as CSSProperties : undefined}
      >
        {children}
      </aside>
    </>
  );
  // workspace の stacking context を抜けて、画面全体の上に載せる。
  return typeof window !== "undefined" ? createPortal(host, window.document.body) : host;
}
