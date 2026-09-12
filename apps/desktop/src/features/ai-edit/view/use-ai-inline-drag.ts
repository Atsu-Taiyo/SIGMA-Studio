"use client";

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { getAiInlineDragPosition, getAiInlineTopBoundary, type AiInlineAnchor } from "@/components/editor/ai-inline-placement";

interface InlineDrag {
  pointerId: number;
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
  active: boolean;
  textarea: HTMLTextAreaElement | null;
}

/** AI 入力欄の移動だけを所有する。新しい入力 session は保存済み位置を即座に無効化する。 */
export function useAiInlineDrag({ enabled, sessionId }: { enabled: boolean; sessionId: number }) {
  const hostRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<InlineDrag | null>(null);
  const [dropped, setDropped] = useState<{ sessionId: number; position: AiInlineAnchor } | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, select, [role='button'], .ai-chat-chip, [data-no-drag]")) return;
    const textarea = target.closest("textarea");
    if (textarea && textarea.value.trim().length > 0) return;
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      active: false,
      textarea,
    };
  }, [enabled]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.active = true;
      hostRef.current?.setPointerCapture(event.pointerId);
      drag.textarea?.blur();
      window.document.body.style.cursor = "grabbing";
    }
    const width = hostRef.current?.offsetWidth ?? 440;
    const position = getAiInlineDragPosition(
      { left: drag.originLeft + dx, top: drag.originTop + dy },
      { width: window.innerWidth, height: window.innerHeight },
      { hostWidth: width, topBoundary: getAiInlineTopBoundary() },
    );
    setDropped({ sessionId, position });
  }, [sessionId]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.active) {
      hostRef.current?.releasePointerCapture(event.pointerId);
      window.document.body.style.cursor = "";
      drag.textarea?.focus();
    }
  }, []);

  return {
    hostRef,
    position: dropped?.sessionId === sessionId ? dropped.position : null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
