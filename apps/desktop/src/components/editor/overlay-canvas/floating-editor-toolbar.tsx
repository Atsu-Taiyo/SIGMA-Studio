"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EDITOR_ZOOM_CHANGE_EVENT } from "@/features/rendering/adapters/editor-zoom-event";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** 編集用UIは図形・用紙の座標面から分離し、画面の可視範囲だけを境界にする。 */
export function FloatingEditorToolbar({ anchorRef, position, className, children }: {
  anchorRef: RefObject<HTMLElement | null>;
  position: { x: number; y: number };
  className: string;
  children: ReactNode;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useIsomorphicLayoutEffect(() => {
    const anchor = anchorRef.current;
    setPortalHost(anchor?.closest<HTMLElement>("[data-modal-backdrop]") ?? anchor?.ownerDocument.body ?? null);
  }, [anchorRef]);
  const draggedPosition = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const anchor = anchorRef.current;
    if (!toolbar || !anchor) return;
    const ownerWindow = anchor.ownerDocument.defaultView;
    if (!ownerWindow) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const scale = anchor.offsetWidth > 0 ? rect.width / anchor.offsetWidth : 1;
      const point = draggedPosition.current ?? {
        x: rect.left + position.x * scale,
        y: rect.top + position.y * scale,
      };
      toolbar.style.left = `${Math.max(8, Math.min(point.x, ownerWindow.innerWidth - toolbar.offsetWidth - 8))}px`;
      toolbar.style.top = `${Math.max(8, Math.min(point.y, ownerWindow.innerHeight - toolbar.offsetHeight - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(toolbar);
    observer.observe(anchor);
    ownerWindow.addEventListener("scroll", place, true);
    ownerWindow.addEventListener("resize", place);
    ownerWindow.addEventListener(EDITOR_ZOOM_CHANGE_EVENT, place);
    return () => {
      observer.disconnect();
      ownerWindow.removeEventListener("scroll", place, true);
      ownerWindow.removeEventListener("resize", place);
      ownerWindow.removeEventListener(EDITOR_ZOOM_CHANGE_EVENT, place);
    };
  }, [anchorRef, portalHost, position.x, position.y]);

  if (!portalHost) return null;
  return createPortal(
    <div
      ref={toolbarRef}
      className={className}
      style={{ position: "fixed", zIndex: 190 }}
      data-overlay-editor-ui="true"
      data-non-modal-surface="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || !(event.target instanceof Element)
          || !event.target.closest(".overlay-table-toolbar-grip")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const toolbar = event.currentTarget;
        const viewport = toolbar.ownerDocument.defaultView!;
        const x = Math.max(8, Math.min(current.left + event.clientX - current.x, viewport.innerWidth - toolbar.offsetWidth - 8));
        const y = Math.max(8, Math.min(current.top + event.clientY - current.y, viewport.innerHeight - toolbar.offsetHeight - 8));
        draggedPosition.current = { x, y };
        toolbar.style.left = `${x}px`;
        toolbar.style.top = `${y}px`;
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.stopPropagation();
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >{children}</div>,
    portalHost,
  );
}
