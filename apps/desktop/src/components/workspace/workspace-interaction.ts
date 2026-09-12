import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

export function isInteractiveContextTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest("a, button, input, select, textarea, [role='button']"));
}

export function isInteractiveTargetWithin(target: EventTarget, container: EventTarget): boolean {
  if (!(target instanceof Element) || !(container instanceof Element)) {
    return false;
  }
  const interactive = target.closest("a, button, input, select, textarea, [role='button']");
  return Boolean(interactive && interactive !== container);
}

const SELECTABLE_ITEM_SELECTOR = ".workspace-file-card, .workspace-folder-card, .workspace-list-row";

/**
 * True when `target` is inside (or is) a selectable item -- a file/folder
 * card or list row. Used to detect a click on empty space within the
 * workspace content area (background, group gaps, the section chrome
 * itself) so it can clear the current multi-selection without also
 * swallowing clicks that land on an actual item.
 */
export function isSelectableItemTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest(SELECTABLE_ITEM_SELECTOR));
}

export function openClickableRow(
  event: ReactMouseEvent | ReactKeyboardEvent,
  action: () => void,
): void {
  // The card itself is a div[role="button"], so it must not count as an
  // interactive target here — only nested controls (delete, cloud, …) do.
  if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
    return;
  }

  if ("key" in event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
  }

  action();
}
