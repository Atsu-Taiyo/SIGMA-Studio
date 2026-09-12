/** Resolve horizontal ownership before searching for a caret vertically. */
export function localColumnAtPoint(grid: HTMLElement, x: number): HTMLElement | null {
  const columns = [...grid.querySelectorAll<HTMLElement>(":scope > .layout-section-independent-column")];
  let nearest: HTMLElement | null = null;
  let distance = Infinity;
  for (const column of columns) {
    const rect = column.getBoundingClientRect();
    if (rect.width <= 0) continue;
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    if (dx < distance) {
      distance = dx;
      nearest = column;
    }
  }
  return nearest;
}

export function localColumnForCaret(root: HTMLElement, x: number, y: number): HTMLElement | null {
  let owner = root.closest<HTMLElement>(".layout-section-independent-column");
  for (const grid of root.querySelectorAll<HTMLElement>(".layout-section-independent-columns")) {
    const rect = grid.getBoundingClientRect();
    if (y < rect.top || y > rect.bottom || x < rect.left || x > rect.right) continue;
    // Resolve an outer lane first, then descend only into that lane.
    if (owner && !owner.contains(grid)) continue;
    owner = localColumnAtPoint(grid, x) ?? owner;
  }
  return owner;
}
