// Pure arrow-key navigation maths for the workspace list. Kept
// dependency-free (no DOM, no React) so it can be covered directly by
// vitest; use-workspace-item-keyboard.ts is the only caller.

export type NavigationKey = "up" | "down" | "home" | "end";

/**
 * Resolves the next row index for a navigation key press, clamped to
 * [0, rowCount - 1]. The list is one column, so only Up/Down/Home/End move.
 */
export function computeNextIndex(
  currentIndex: number,
  rowCount: number,
  key: NavigationKey,
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
  if (key === "up") {
    return clamp(currentIndex - 1);
  }
  return clamp(currentIndex + 1);
}
