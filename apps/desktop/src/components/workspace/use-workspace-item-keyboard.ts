"use client";

import { useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { computeNextIndex, countGridColumns, type NavigationKey, type NavigationLayout } from "./workspace-grid-navigation";
import { computeRangeSelection } from "./workspace-selection";

export interface WorkspaceKeyboardRow {
  key: string;
}

const NAV_KEY_MAP: Record<string, NavigationKey | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
};

export interface UseWorkspaceItemKeyboardOptions {
  rows: readonly WorkspaceKeyboardRow[];
  layout: NavigationLayout;
  anchorKey: string | null;
  onFocusKey: (key: string) => void;
  onReplaceSelection: (keys: ReadonlySet<string>, anchorKey: string | null) => void;
  onSelectOnly: (key: string) => void;
  onClearSelection: () => void;
  onOpen: (key: string) => void;
  onStartRename: (key: string) => void;
  canRename: (key: string) => boolean;
  onDeleteSelection: () => void;
}

function cssEscapeKey(key: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(key);
  }
  // Fallback for environments without CSS.escape (jsdom/vitest do have it,
  // this only guards a genuinely missing global).
  return key.replace(/["\\]/g, "\\$&");
}

function focusItemInDom(key: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const element = document.querySelector<HTMLElement>(`[data-item-key="${cssEscapeKey(key)}"]`);
  element?.focus();
}

// No ResizeObserver, no CSS parsing (grid-template-columns is
// auto-fill/minmax, which isn't reliably parseable): the column count is
// derived by measuring which leading items share the first item's
// offsetTop. Scoped to the closest ".workspace-item-grid" ancestor of the
// key that moved focus, since the folder section and file section render as
// two separate grids with different column widths.
function measureColumnCountForKey(key: string): number {
  if (typeof document === "undefined") {
    return 1;
  }
  const current = document.querySelector<HTMLElement>(`[data-item-key="${cssEscapeKey(key)}"]`);
  const container = current?.closest(".workspace-item-grid");
  if (!container) {
    return 1;
  }
  const items = Array.from(container.querySelectorAll<HTMLElement>("[data-item-key]"));
  return countGridColumns(items.map((item) => item.offsetTop)) || 1;
}

/**
 * Keyboard navigation/selection for the workspace grid and list. The
 * returned handler must be attached per-item via onKeyDown -- never at the
 * window level -- so WorkspaceInlineRenameInput's stopPropagation() on
 * every keydown continues to fully shield an in-progress rename from ever
 * reaching this handler (see WorkspaceInlineRenameInput.tsx).
 */
export function useWorkspaceItemKeyboard(
  options: UseWorkspaceItemKeyboardOptions,
): (event: ReactKeyboardEvent, key: string) => void {
  const {
    rows,
    layout,
    anchorKey,
    onFocusKey,
    onReplaceSelection,
    onSelectOnly,
    onClearSelection,
    onOpen,
    onStartRename,
    canRename,
    onDeleteSelection,
  } = options;

  return useCallback((event: ReactKeyboardEvent, key: string) => {
    const currentIndex = rows.findIndex((row) => row.key === key);
    if (currentIndex === -1) {
      return;
    }

    const navKey = NAV_KEY_MAP[event.key];
    if (navKey) {
      if (layout === "list" && (navKey === "left" || navKey === "right")) {
        return;
      }
      event.preventDefault();
      const columnCount = layout === "grid" ? measureColumnCountForKey(key) : 1;
      const nextIndex = computeNextIndex(currentIndex, rows.length, navKey, layout, columnCount);
      const nextKey = rows[nextIndex]?.key;
      if (!nextKey) {
        return;
      }
      if (event.shiftKey) {
        const anchor = anchorKey ?? key;
        onReplaceSelection(computeRangeSelection(rows, anchor, nextKey), anchor);
      } else {
        onSelectOnly(nextKey);
      }
      onFocusKey(nextKey);
      focusItemInDom(nextKey);
      return;
    }

    // Space is included alongside Enter to preserve the previous
    // openClickableRow parity (role="button" divs don't reliably suppress
    // the browser's default Space-scrolls-the-page action on their own).
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(key);
      return;
    }

    if (event.key === "F2") {
      if (!canRename(key)) {
        return;
      }
      event.preventDefault();
      onStartRename(key);
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDeleteSelection();
      return;
    }

    if (event.key === "Escape") {
      onClearSelection();
    }
  }, [
    rows,
    layout,
    anchorKey,
    onFocusKey,
    onReplaceSelection,
    onSelectOnly,
    onClearSelection,
    onOpen,
    onStartRename,
    canRename,
    onDeleteSelection,
  ]);
}
