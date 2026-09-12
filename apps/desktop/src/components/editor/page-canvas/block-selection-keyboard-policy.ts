const OVERLAY_KEYBOARD_SURFACE_SELECTOR = ".overlay-canvas-bleed-surface";

export interface BlockSelectionDeleteContext {
  defaultPrevented: boolean;
  activeElement: Element | null;
  hasOverlayDestructiveSelection: boolean;
}

/**
 * Body-block selection may remain visible while an overlay selection owns the keyboard.
 * In that state, destructive keys belong exclusively to the overlay canvas. Overlay focus by
 * itself is not ownership: after its last shape is deleted, the next Delete (including key
 * repeat) belongs to the still-visible block selection.
 */
export function shouldHandleBlockSelectionDelete({
  defaultPrevented,
  activeElement,
  hasOverlayDestructiveSelection,
}: BlockSelectionDeleteContext): boolean {
  if (defaultPrevented) {
    return false;
  }

  return !(
    hasOverlayDestructiveSelection
    && activeElement?.closest(OVERLAY_KEYBOARD_SURFACE_SELECTOR)
  );
}
