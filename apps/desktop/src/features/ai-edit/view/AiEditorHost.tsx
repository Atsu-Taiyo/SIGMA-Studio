"use client";

import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";

import {
  AI_INLINE_DEFAULT_LEFT_PX,
  AI_INLINE_DEFAULT_TOP_PX,
  getAiInlineDragPosition,
  getAiInlineHostPosition,
  getAiInlineTopBoundary,
  type AiInlineAnchor,
} from "@/components/editor/ai-inline-placement";
import type { AiDisplayMode, AiSurfaceResolution } from "@/lib/ai/ai-surface";
import { useAiInlineDrag } from "./use-ai-inline-drag";

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
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/** AI panel の配置と操作面。提案・参照・文書の state は children の composition が所有する。 */
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
  closeLabel,
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
  if (!enabled) return null;

  const inlineViewport = isInlineHost && hostVisible && typeof window !== "undefined"
    ? { width: window.innerWidth, height: window.innerHeight }
    : null;
  const inlineTopBoundary = inlineViewport ? getAiInlineTopBoundary() : null;
  const autoPosition = inlineViewport && inlineTopBoundary !== null
    ? hostAnchor
      ? getAiInlineHostPosition(hostAnchor, inlineViewport, { topBoundary: inlineTopBoundary })
      : getAiInlineDragPosition(
          { left: AI_INLINE_DEFAULT_LEFT_PX, top: AI_INLINE_DEFAULT_TOP_PX },
          inlineViewport,
          { topBoundary: inlineTopBoundary },
        )
    : null;
  const renderPosition = dragPosition ?? autoPosition;
  const host = (
    <>
      {(surface.catcherVisible || inlineClosing) && (
        <div
          className={`ai-inline-catcher${inlineClosing ? " ai-inline-catcher--closing" : ""}`.trim()}
          role="presentation"
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
        {...(isInlineHost ? handlers : {})}
        style={isInlineHost && renderPosition
          ? { left: `${renderPosition.left}px`, top: `${renderPosition.top}px` }
          : undefined}
      >
        {displayMode === "sidebar" && (
          <div className="sidebar-panel-header">
            <span>AI</span>
            <button
              type="button"
              className="panel-icon-button sidebar-close-button"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {children}
      </aside>
    </>
  );
  // inline は workspace の stacking context を抜け、sidebar は grid に残る。
  return isInlineHost && typeof window !== "undefined"
    ? createPortal(host, window.document.body)
    : host;
}
