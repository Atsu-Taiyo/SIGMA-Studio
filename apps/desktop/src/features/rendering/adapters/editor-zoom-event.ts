/**
 * Zoom paints the document through a CSS transform on an ancestor, which leaves every descendant's
 * layout size untouched. `ResizeObserver` never fires for it — `device-pixel-content-box` included —
 * so canvases that size their drawing buffer to the painted scale have no way to learn that the
 * scale moved. The page canvas publishes this event on `window` whenever the editor zoom changes,
 * and resolution-sensitive canvases re-measure themselves from it.
 */
export const EDITOR_ZOOM_CHANGE_EVENT = "sigma-studio:editor-zoom-change";
