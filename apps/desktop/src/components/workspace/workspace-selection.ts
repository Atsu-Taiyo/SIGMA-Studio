// Pure selection maths for the Google Drive-style workspace browser.
// Kept dependency-free (no React) so it can be covered directly by vitest --
// see the S5b plan note that components/hooks cannot be unit tested here
// (environment: "node", no @testing-library/react).

export interface WorkspaceSelectionRow {
  key: string;
}

export type WorkspaceClickModifier = "plain" | "toggle" | "range";

export interface WorkspaceClickModifierEvent {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Resolves which selection gesture a click represents. Shift takes priority
 * over Cmd/Ctrl when both are somehow held, matching Drive/Finder/Explorer.
 */
export function resolveClickModifier(event: WorkspaceClickModifierEvent): WorkspaceClickModifier {
  if (event.shiftKey) {
    return "range";
  }
  if (event.metaKey || event.ctrlKey) {
    return "toggle";
  }
  return "plain";
}

/** Toggles a single key in/out of the selection, returning a new Set. */
export function toggleSelectionKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * Returns the set of keys spanning the contiguous range between anchorKey
 * and targetKey (inclusive), in `rows`'s current order. A missing anchor or
 * target (e.g. the anchor was deleted out from under a stale selection)
 * degrades to selecting whichever key IS still present, rather than
 * throwing or silently selecting nothing useful.
 */
export function computeRangeSelection(
  rows: readonly WorkspaceSelectionRow[],
  anchorKey: string,
  targetKey: string,
): Set<string> {
  const anchorIndex = rows.findIndex((row) => row.key === anchorKey);
  const targetIndex = rows.findIndex((row) => row.key === targetKey);

  if (anchorIndex === -1 && targetIndex === -1) {
    return new Set();
  }
  if (anchorIndex === -1) {
    return new Set([targetKey]);
  }
  if (targetIndex === -1) {
    return new Set([anchorKey]);
  }

  const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  const next = new Set<string>();
  for (let index = start; index <= end; index += 1) {
    next.add(rows[index].key);
  }
  return next;
}

/**
 * Prunes a selection down to keys still present in `existingKeys`. Returns
 * the SAME Set reference when nothing was removed, so callers (the
 * overview-changed effect in WorkspaceManager) can skip a setState -- and
 * the re-render it would trigger -- when the refresh didn't actually
 * invalidate anything the user had selected.
 */
export function pruneSelectionToExistingKeys(
  selected: ReadonlySet<string>,
  existingKeys: ReadonlySet<string>,
): Set<string> | ReadonlySet<string> {
  let changed = false;
  for (const key of selected) {
    if (!existingKeys.has(key)) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    return selected;
  }

  const next = new Set<string>();
  for (const key of selected) {
    if (existingKeys.has(key)) {
      next.add(key);
    }
  }
  return next;
}
