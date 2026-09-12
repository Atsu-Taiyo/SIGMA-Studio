"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { IconButton } from "@/components/ui/Button";
import { ToolbarPopover } from "./ToolbarPopover";
import {
  CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE,
  closeGraphItemActionsMenu,
  openGraphItemActionsMenuByHover,
  toggleGraphItemActionsMenuByClick,
} from "@/components/editor/graph-item-actions-menu-state";

/**
 * グラフ設定パネル内のポップオーバーの重なり順。
 * `ToolbarPopover` は backdrop が無いと `document.body` へ portal する。既定の 200 のままだと
 * `--z-modal` に載る非モーダルパネルの下に隠れてクリックできなくなる。
 */
export const GRAPH_SETTINGS_POPOVER_Z_INDEX = "var(--z-modal-nested)";

export function GraphItemActionsMenu({
  label,
  testId,
  className,
  hoverAnchorRef,
  onCloseNestedMenus,
  children,
}: {
  label: string;
  testId?: string;
  className?: string;
  /** Optional larger hover target; the trigger remains the explicit keyboard/click control. */
  hoverAnchorRef?: RefObject<HTMLElement | null>;
  onCloseNestedMenus: () => void;
  children: ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCloseRef = useRef<() => void>(() => undefined);
  const onCloseNestedMenusRef = useRef(onCloseNestedMenus);
  const [menuState, setMenuState] = useState(CLOSED_GRAPH_ITEM_ACTIONS_MENU_STATE);
  const open = menuState.open;

  useEffect(() => {
    onCloseNestedMenusRef.current = onCloseNestedMenus;
  }, [onCloseNestedMenus]);
  const cancelScheduledClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const closeMenu = () => {
    cancelScheduledClose();
    setMenuState(closeGraphItemActionsMenu());
    onCloseNestedMenus();
  };
  const isHoverRegionActive = () => {
    const anchor = hoverAnchorRef?.current ?? buttonRef.current;
    const popover = contentRef.current?.closest<HTMLElement>("[data-toolbar-popover]");
    return anchor?.matches(":hover") === true || popover?.matches(":hover") === true;
  };
  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      // カードと portal された詳細面を1つの Hover 領域として扱う。カードを離れてから
      // 詳細面へ到達するまでの隙間でタイマーが勝っても、操作先に着いていれば閉じない。
      if (isHoverRegionActive()) return;
      setMenuState(closeGraphItemActionsMenu());
      onCloseNestedMenus();
    }, 320);
  };
  useEffect(() => {
    scheduleCloseRef.current = scheduleClose;
  });

  useEffect(() => () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const anchor = hoverAnchorRef?.current;
    if (!anchor) return;
    const openFromHover = () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
      setMenuState(openGraphItemActionsMenuByHover);
    };
    const closeFromHover = () => scheduleCloseRef.current();
    anchor.addEventListener("mouseenter", openFromHover);
    anchor.addEventListener("mouseleave", closeFromHover);
    return () => {
      anchor.removeEventListener("mouseenter", openFromHover);
      anchor.removeEventListener("mouseleave", closeFromHover);
    };
  }, [hoverAnchorRef]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // hover で開いた時はフォーカスが移っていないので、ToolbarPopover 側の
    // 「Escape の発生元がポップオーバー内か」判定に掛からず素通りし、代わりに
    // パネルごと閉じてしまう。内側 (入れ子ポップオーバーを含む) は
    // ToolbarPopover に任せ、それ以外の発生元をここで引き取る。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-toolbar-popover]")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancelScheduledClose();
      setMenuState(closeGraphItemActionsMenu());
      onCloseNestedMenusRef.current();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <IconButton
        ref={buttonRef}
        label={label}
        tone="ghost"
        size="sm"
        className="graph-item-actions-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open ? "true" : undefined}
        data-testid={testId}
        onMouseEnter={() => {
          cancelScheduledClose();
          setMenuState(openGraphItemActionsMenuByHover);
        }}
        onMouseLeave={scheduleClose}
        onClick={() => {
          cancelScheduledClose();
          const next = toggleGraphItemActionsMenuByClick(menuState);
          setMenuState(next);
          if (!next.open) {
            onCloseNestedMenus();
          }
        }}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </IconButton>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={closeMenu}
        className={`shape-menu graph-item-actions-menu ${className ?? ""}`}
        // 中身は色・線種・太さのドロップダウンや濃さのスライダー。role="menu" の直下に
        // フォーム部品を置くと AT のメニューモードで正しく露出しないので dialog にする。
        role="dialog"
        ariaLabel={label}
        placement="right"
        gap={4}
        zIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
        onMouseEnter={cancelScheduledClose}
        onMouseLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Element && nextTarget.closest("[data-toolbar-popover]")) {
            return;
          }
          scheduleClose();
        }}
      >
        <div
          ref={contentRef}
          className="graph-item-actions-menu-content"
          data-non-modal-surface=""
          onPointerDown={(event) => {
            // 色・線種・太さなどの子ポップオーバーは portal される。React ツリー上は
            // このメニューを通るので、外側クリック扱いで親まで閉じないようにする。
            if (!contentRef.current?.contains(event.target as Node)) {
              event.stopPropagation();
            }
          }}
        >
          {children}
        </div>
      </ToolbarPopover>
    </>
  );
}
