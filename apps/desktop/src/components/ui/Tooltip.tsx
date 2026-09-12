"use client";

import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, ReactElement } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/lib/i18n/react";

import styles from "./Tooltip.module.css";

const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 8;

export interface TooltipContent {
  /** 操作後に何が起きるかを一行で示す短い説明。 */
  label: string;
  /** 現在有効なショートカット。未割り当てなら表示しない。 */
  shortcut?: string | null;
}

interface TooltipTriggerProps {
  "aria-describedby"?: string;
  title?: string;
}

interface TooltipProps extends TooltipContent {
  children: ReactElement<TooltipTriggerProps>;
  delay?: number;
  placement?: "top" | "bottom";
}

interface TooltipPosition {
  left: number;
  side: "top" | "bottom";
  top: number;
}

/**
 * 曖昧なアイコン操作へ、短い結果説明と現在のキー割り当てだけを補う共通Tooltip。
 * 操作の選定やショートカット解決は呼び出し側に残し、すべてのボタンへ自動適用しない。
 */
export function Tooltip({
  children,
  label,
  shortcut,
  delay = 420,
  placement = "bottom",
}: TooltipProps) {
  const t = useT("common");
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const suppressFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const closeImmediately = () => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(false);
    setPortalHost(null);
    setPosition(null);
  };
  const openImmediately = () => {
    const anchor = anchorRef.current;
    setPortalHost(anchor?.closest<HTMLElement>("[data-modal-backdrop]") ?? document.body);
    setOpen(true);
  };
  const scheduleOpen = () => {
    clearCloseTimer();
    if (open || openTimerRef.current !== null) {
      return;
    }
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      openImmediately();
    }, delay);
  };
  const scheduleClose = () => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setPortalHost(null);
      setPosition(null);
    }, 60);
  };

  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const tooltip = tooltipRef.current;
      if (!anchor || !tooltip) {
        return;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const availableAbove = anchorRect.top - VIEWPORT_MARGIN;
      const availableBelow = window.innerHeight - anchorRect.bottom - VIEWPORT_MARGIN;
      const preferredFits = placement === "bottom"
        ? availableBelow >= tooltipRect.height + TOOLTIP_GAP
        : availableAbove >= tooltipRect.height + TOOLTIP_GAP;
      const fallbackFits = placement === "bottom"
        ? availableAbove >= tooltipRect.height + TOOLTIP_GAP
        : availableBelow >= tooltipRect.height + TOOLTIP_GAP;
      const side = preferredFits || !fallbackFits
        ? placement
        : placement === "bottom" ? "top" : "bottom";
      const unclampedLeft = anchorRect.left + (anchorRect.width - tooltipRect.width) / 2;
      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN);
      const left = Math.min(Math.max(unclampedLeft, VIEWPORT_MARGIN), maxLeft);
      const unclampedTop = side === "bottom"
        ? anchorRect.bottom + TOOLTIP_GAP
        : anchorRect.top - tooltipRect.height - TOOLTIP_GAP;
      const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - tooltipRect.height - VIEWPORT_MARGIN);
      const top = Math.min(Math.max(unclampedTop, VIEWPORT_MARGIN), maxTop);

      setPosition({ left, side, top });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [label, open, placement, portalHost, shortcut]);

  const handlePointerEnter = () => {
    hoveredRef.current = true;
    scheduleOpen();
  };
  const handlePointerLeave = () => {
    hoveredRef.current = false;
    if (!focusedRef.current) {
      scheduleClose();
    }
  };
  const handleFocus = () => {
    focusedRef.current = true;
    clearCloseTimer();
    if (!suppressFocusRef.current) {
      clearOpenTimer();
      openImmediately();
    }
  };
  const handleBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    focusedRef.current = false;
    if (!hoveredRef.current) {
      scheduleClose();
    }
  };
  const handlePointerDown = () => {
    suppressFocusRef.current = true;
    closeImmediately();
    window.setTimeout(() => {
      suppressFocusRef.current = false;
    }, 0);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") {
      closeImmediately();
    }
  };

  const describedBy = open
    ? [children.props["aria-describedby"], tooltipId].filter(Boolean).join(" ")
    : children.props["aria-describedby"];
  const trigger = cloneElement(children, {
    "aria-describedby": describedBy || undefined,
    // A custom tooltip replaces the browser's delayed native title bubble.
    title: undefined,
  });
  return (
    <span
      ref={anchorRef}
      className={styles.trigger}
      data-tooltip-trigger=""
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      {trigger}
      {open && portalHost ? createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          className={styles.tooltip}
          role="tooltip"
          data-side={position?.side ?? placement}
          style={(position
            ? { left: position.left, top: position.top }
            : { left: -9999, top: -9999 }) as CSSProperties}
        >
          <span className={styles.label}>{label}</span>
          {shortcut ? <kbd className={styles.shortcut} aria-label={t("shortcutAria", { shortcut })}>{shortcut}</kbd> : null}
        </div>,
        portalHost,
      ) : null}
    </span>
  );
}
