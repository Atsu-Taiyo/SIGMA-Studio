"use client";

import { useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { computeNextIndex, type NavigationKey } from "./workspace-item-navigation";
import { computeRangeSelection } from "./workspace-selection";

export interface WorkspaceKeyboardRow {
  key: string;
}

// Left/Right are deliberately absent: the list is one column, and leaving them
// unhandled keeps the browser's default behaviour for those keys.
const NAV_KEY_MAP: Record<string, NavigationKey | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
};

export interface UseWorkspaceItemKeyboardOptions {
  rows: readonly WorkspaceKeyboardRow[];
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

/**
 * Keyboard navigation/selection for the workspace list. The
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
      event.preventDefault();
      const nextIndex = computeNextIndex(currentIndex, rows.length, navKey);
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
