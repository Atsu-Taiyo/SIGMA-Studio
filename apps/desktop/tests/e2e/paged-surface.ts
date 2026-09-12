import type { Page } from "@playwright/test";

/**
 * Waits until the paged surface stops rebuilding its page windows.
 *
 * `data-paged-surface-state="ready"` only says a cut has happened. A decorating or
 * anchor-resolution pass that lands afterwards makes the surface re-cut, replacing the
 * elements a query just resolved — with the same page count and page size, so nothing
 * coarser notices. The cut revision is the signal that the windows match the settled
 * canvas.
 *
 * Revision `"0"` is the pre-cut initial value, not a cut: it is stable from the moment the
 * surface mounts, so accepting it would let this return after ~600ms with zero page windows
 * built. Only a revision the first `cut()` produced counts.
 */
export async function waitForPagedSurfaceSettled(page: Page): Promise<void> {
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 60 && stable < 4; attempt += 1) {
    const revision = await page.locator(".paged-surface")
      .getAttribute("data-paged-surface-revision") ?? "";
    if (revision && revision !== "0" && revision === previous) {
      stable += 1;
    } else {
      stable = 0;
      previous = revision;
    }
    await page.waitForTimeout(120);
  }
}
