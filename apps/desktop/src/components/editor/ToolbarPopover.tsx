"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEventHandler,
  ReactNode,
  RefObject,
} from "react";
import { createPortal } from "react-dom";

/** Layout effects must not run during SSR; fall back to a no-op effect on the server. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const POPOVER_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");
const MODEL_SUBMENU_WIDTH_PX = 280;

interface ToolbarPopoverProps {
  /** Whether the popover is visible. */
  open: boolean;
  /** The trigger button the popover is positioned against. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Called when a click lands outside both the popover and its anchor. */
  onClose: () => void;
  /** Horizontal alignment of the popover relative to the anchor. */
  align?: "left" | "right";
  /** Vertical gap between the anchor and the popover, in px. */
  gap?: number;
  /** Preferred side of the anchor. Top popovers flip below when space is insufficient. */
  placement?: "bottom" | "top" | "left" | "right";
  /** Allows portalled menus to participate in the app's overlay layer order. */
  zIndex?: CSSProperties["zIndex"];
  className?: string;
  role?: "dialog" | "menu";
  ariaLabel?: string;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}

/**
 * Renders a toolbar popover into the nearest modal backdrop, or `document.body`,
 * so it cannot be clipped by a toolbar or dialog surface. Position is fixed to
 * the viewport and recomputed from the anchor on scroll/resize.
 */
export function ToolbarPopover({
  open,
  anchorRef,
  onClose,
  align = "left",
  gap = 7,
  placement = "bottom",
  zIndex = 200,
  className,
  role = "dialog",
  ariaLabel,
  onMouseEnter,
  onMouseLeave,
  children,
}: ToolbarPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusOnCleanupRef = useRef(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useIsomorphicLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPortalHost(null);
      return;
    }
    const nextPortalHost = anchorRef.current?.closest<HTMLElement>("[data-modal-backdrop]")
      ?? document.body;
    setPortalHost(nextPortalHost);
  }, [open, anchorRef]);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const popoverWidth = popoverRef.current?.offsetWidth ?? 0;
      const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
      const margin = 8;
      const horizontalPlacement = placement === "left" || placement === "right";
      let top: number;
      let left: number;
      if (horizontalPlacement) {
        const preferredLeft = placement === "right" ? rect.right + gap : rect.left - gap - popoverWidth;
        const fallbackLeft = placement === "right" ? rect.left - gap - popoverWidth : rect.right + gap;
        const preferredFits = preferredLeft >= margin && preferredLeft + popoverWidth <= window.innerWidth - margin;
        left = preferredFits ? preferredLeft : fallbackLeft;
        left = Math.max(margin, Math.min(left, Math.max(margin, window.innerWidth - margin - popoverWidth)));
        top = Math.max(margin, Math.min(rect.top, window.innerHeight - margin - popoverHeight));
      } else {
        const preferredTop = placement === "top" ? rect.top - gap - popoverHeight : rect.bottom + gap;
        const fallbackTop = placement === "top" ? rect.bottom + gap : rect.top - gap - popoverHeight;
        top = preferredTop >= margin && preferredTop + popoverHeight <= window.innerHeight - margin
          ? preferredTop
          : Math.max(margin, Math.min(fallbackTop, window.innerHeight - margin - popoverHeight));
        left = align === "right" ? rect.right - popoverWidth : rect.left;
        const maxLeft = window.innerWidth - margin - popoverWidth;
        left = Math.max(margin, Math.min(left, Math.max(margin, maxLeft)));
      }
      const submenuWidth = Math.max(0, Math.min(MODEL_SUBMENU_WIDTH_PX, window.innerWidth - margin * 2));
      const submenuLeftCandidate = left - submenuWidth;
      const submenuRightCandidate = left + popoverWidth;
      const submenuLeft = submenuLeftCandidate >= margin
        ? submenuLeftCandidate
        : submenuRightCandidate + submenuWidth <= window.innerWidth - margin
          ? submenuRightCandidate
          : Math.max(margin, Math.min(left, window.innerWidth - margin - submenuWidth));
      const popoverBottom = Math.min(window.innerHeight - margin, top + popoverHeight);
      setStyle({
        position: "fixed",
        top,
        left,
        zIndex,
        "--toolbar-popover-submenu-left": `${submenuLeft}px`,
        "--toolbar-popover-submenu-bottom": `${Math.max(margin, window.innerHeight - popoverBottom)}px`,
        "--toolbar-popover-submenu-width": `${submenuWidth}px`,
        "--toolbar-popover-submenu-max-height": `${Math.max(0, Math.min(340, popoverBottom - margin))}px`,
      } as CSSProperties);
    };

    update();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    if (popoverRef.current) {
      resizeObserver?.observe(popoverRef.current);
    }
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, align, gap, placement, zIndex, anchorRef, portalHost]);

  useIsomorphicLayoutEffect(() => {
    if (!open || anchorRef.current !== document.activeElement) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const popover = popoverRef.current;
      const initialFocus = popover?.querySelector<HTMLElement>("[data-popover-initial-focus]")
        ?? popover?.querySelector<HTMLElement>(POPOVER_FOCUSABLE_SELECTOR);
      initialFocus?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, anchorRef, portalHost]);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    anchor?.setAttribute("data-toolbar-popover-anchor-open", "");
    restoreFocusOnCleanupRef.current = Boolean(popoverRef.current?.contains(document.activeElement));
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      restoreFocusOnCleanupRef.current = Boolean(target && popoverRef.current?.contains(target));
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Node | null;
      if (event.key !== "Escape" || !target) return;
      if (!popoverRef.current?.contains(target) && !anchorRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      const restoreFocus = restoreFocusOnCleanupRef.current;
      restoreFocusOnCleanupRef.current = false;
      anchor?.removeAttribute("data-toolbar-popover-anchor-open");
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreFocus) {
        anchor?.focus({ preventScroll: true });
      }
    };
  }, [open, anchorRef]);

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const nestedScope = target?.closest<HTMLElement>("[role='menu'], [role='dialog']");
    const scope = nestedScope && popoverRef.current?.contains(nestedScope) ? nestedScope : popoverRef.current;
    const focusable = scope ? Array.from(scope.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE_SELECTOR)) : [];
    if (focusable.length === 0) {
      return;
    }
    event.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex >= 0
      ? (currentIndex + offset + focusable.length) % focusable.length
      : event.key === "ArrowDown" ? 0 : focusable.length - 1;
    focusable[nextIndex]?.focus({ preventScroll: true });
  };

  if (!open || typeof document === "undefined" || !portalHost) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      data-toolbar-popover=""
      data-placement={placement}
      onKeyDown={handlePopoverKeyDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Rendered off-screen for the first layout pass so it can be measured without flashing.
      style={style ?? { position: "fixed", top: -9999, left: -9999, zIndex }}
    >
      {children}
    </div>,
    portalHost,
  );
}
