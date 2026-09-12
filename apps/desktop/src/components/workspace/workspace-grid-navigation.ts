// Pure arrow-key navigation maths for the workspace grid/list. Kept
// dependency-free (no DOM, no React) so it can be covered directly by
// vitest; use-workspace-item-keyboard.ts is the only caller, and it is the
// one that measures real offsetTop values from the DOM to feed
// countGridColumns.

export type NavigationLayout = "grid" | "list";
export type NavigationKey = "up" | "down" | "left" | "right" | "home" | "end";

/**
 * Counts how many leading items share the first item's offsetTop, i.e. the
 * number of columns in the currently rendered grid. Deliberately does not
 * read CSS (grid-template-columns can be `auto-fill`/`minmax`, which isn't
 * reliably parseable) and does not use ResizeObserver -- a plain offsetTop
 * comparison over already-measured values is suffient and trivial to test.
 */
export function countGridColumns(itemTops: readonly number[]): number {
  if (itemTops.length === 0) {
    return 0;
  }
  const firstTop = itemTops[0];
  let count = 0;
  for (const top of itemTops) {
    if (top !== firstTop) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Resolves the next row index for a navigation key press, clamped to
 * [0, rowCount - 1]. In list layout, Left/Right are a no-op (returns
 * currentIndex unchanged) -- callers should skip calling this for
 * Left/Right in list layout entirely, but a defensive no-op keeps this
 * function safe to call unconditionally.
 */
export function computeNextIndex(
  currentIndex: number,
  rowCount: number,
  key: NavigationKey,
  layout: NavigationLayout,
  columnCount: number,
): number {
  if (rowCount === 0) {
    return -1;
  }
  const clamp = (index: number) => Math.min(Math.max(index, 0), rowCount - 1);

  if (key === "home") {
    return 0;
  }
  if (key === "end") {
    return rowCount - 1;
  }

  if (layout === "list") {
    if (key === "up") {
      return clamp(currentIndex - 1);
    }
    if (key === "down") {
      return clamp(currentIndex + 1);
    }
    return clamp(currentIndex);
  }

  const columns = Math.max(columnCount, 1);
  if (key === "left") {
    return clamp(currentIndex - 1);
  }
  if (key === "right") {
    return clamp(currentIndex + 1);
  }
  if (key === "up") {
    return clamp(currentIndex - columns);
  }
  if (key === "down") {
    return clamp(currentIndex + columns);
  }
  return clamp(currentIndex);
}
