import { getCaretSurfaces } from "../text-flow/caret-router";

/** A toolbar input owns native selection; the body range continues to live in ProseMirror. */
export function hasHeldCanvasTextSelection(canvas: HTMLElement | null, activeElement: Element | null, includeSpan = true): boolean {
  if (!canvas) return false;
  const chromeFocused = !!activeElement?.closest(
    ".selection-action-popover, [data-toolbar-popover], [data-editor-toolbar], .ribbon-editing-surface, .color-picker-dialog",
  );
  return getCaretSurfaces().some(({ editor }) => (
    canvas.contains(editor.view.dom)
    && !editor.state.selection.empty
    && (chromeFocused || (includeSpan && (editor.view.dom.hasAttribute("data-text-run-span") || editor.view.dom.hasAttribute("data-box-fragment-span"))))
  ));
}
