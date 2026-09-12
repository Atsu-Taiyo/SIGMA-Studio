"use client";

import { useCallback, useState } from "react";

import {
  computeRangeSelection,
  pruneSelectionToExistingKeys,
  resolveClickModifier,
  toggleSelectionKey,
  type WorkspaceClickModifierEvent,
  type WorkspaceSelectionRow,
} from "./workspace-selection";

export interface UseWorkspaceSelectionResult {
  selectedKeys: ReadonlySet<string>;
  anchorKey: string | null;
  focusedKey: string | null;
  isSelected: (key: string) => boolean;
  setFocusedKey: (key: string) => void;
  clearSelection: () => void;
  selectOnly: (key: string) => void;
  replaceSelection: (keys: ReadonlySet<string>, anchorKey: string | null) => void;
  handleItemClick: (
    event: WorkspaceClickModifierEvent,
    key: string,
    rows: readonly WorkspaceSelectionRow[],
  ) => void;
  pruneToKeys: (existingKeys: ReadonlySet<string>) => void;
}

/**
 * Owns the Drive-style multi-selection state for the workspace browser:
 * which keys are selected, the Shift-click range anchor, and the roving
 * tabIndex focus target. Deliberately does NOT implement marquee/rubber-band
 * selection (see the S5b plan) -- Shift-click range selection covers the
 * same need without the pointer-capture-over-a-scrolling-drag-and-drop-
 * container hazards that come with it.
 */
export function useWorkspaceSelection(): UseWorkspaceSelectionResult {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKeyState] = useState<string | null>(null);

  const isSelected = useCallback((key: string) => selectedKeys.has(key), [selectedKeys]);

  const setFocusedKey = useCallback((key: string) => {
    setFocusedKeyState(key);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedKeys((current) => (current.size === 0 ? current : new Set()));
    setAnchorKey(null);
  }, []);

  const selectOnly = useCallback((key: string) => {
    setSelectedKeys(new Set([key]));
    setAnchorKey(key);
    setFocusedKeyState(key);
  }, []);

  const replaceSelection = useCallback((keys: ReadonlySet<string>, nextAnchorKey: string | null) => {
    setSelectedKeys(new Set(keys));
    setAnchorKey(nextAnchorKey);
  }, []);

  const handleItemClick = useCallback((
    event: WorkspaceClickModifierEvent,
    key: string,
    rows: readonly WorkspaceSelectionRow[],
  ) => {
    const modifier = resolveClickModifier(event);
    setFocusedKeyState(key);

    if (modifier === "toggle") {
      setSelectedKeys((current) => toggleSelectionKey(current, key));
      setAnchorKey(key);
      return;
    }

    if (modifier === "range" && anchorKey) {
      setSelectedKeys(computeRangeSelection(rows, anchorKey, key));
      return;
    }

    setSelectedKeys(new Set([key]));
    setAnchorKey(key);
    // anchorKey is read fresh via the closure each call; only the "range"
    // branch depends on its current value, so it must stay a dependency.
  }, [anchorKey]);

  const pruneToKeys = useCallback((existingKeys: ReadonlySet<string>) => {
    setSelectedKeys((current) => {
      const pruned = pruneSelectionToExistingKeys(current, existingKeys);
      return pruned === current ? current : new Set(pruned);
    });
    setAnchorKey((current) => (current !== null && existingKeys.has(current) ? current : null));
    setFocusedKeyState((current) => (current !== null && existingKeys.has(current) ? current : null));
  }, []);

  return {
    selectedKeys,
    anchorKey,
    focusedKey,
    isSelected,
    setFocusedKey,
    clearSelection,
    selectOnly,
    replaceSelection,
    handleItemClick,
    pruneToKeys,
  };
}
