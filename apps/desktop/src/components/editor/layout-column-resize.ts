/** Shared pointer session for body and nested independent column dividers. */
export function beginLayoutColumnResize(
  event: PointerEvent | { button: number; clientX: number; pointerId: number; preventDefault(): void; stopPropagation(): void },
  handle: HTMLElement,
  dividerIndex: number,
  onCommit: (leftWidth: number, rightWidth: number) => void,
): () => void {
  if (event.button !== 0) return () => {};
  event.preventDefault();
  event.stopPropagation();
  const grid = handle.closest<HTMLElement>(".layout-section-independent-columns");
  const columns = grid ? [...grid.querySelectorAll<HTMLElement>(":scope > .layout-section-independent-column")] : [];
  const left = columns[dividerIndex]?.getBoundingClientRect();
  const right = columns[dividerIndex + 1]?.getBoundingClientRect();
  if (!grid || !left || !right) return () => {};
  const startX = event.clientX;
  const gridRect = grid.getBoundingClientRect();
  const scale = grid.offsetWidth > 0 && gridRect.width > 0 ? gridRect.width / grid.offsetWidth : 1;
  const initialWidths = columns.map((column) => column.getBoundingClientRect().width / scale);
  const leftWidth = left.width / scale;
  const rightWidth = right.width / scale;
  const originalGridTemplateColumns = grid.style.gridTemplateColumns;
  const ownerWindow = handle.ownerDocument.defaultView ?? window;
  let delta = 0;
  let finished = false;
  handle.dataset.dragging = "true";
  handle.setPointerCapture(event.pointerId);
  const onMove = (moveEvent: PointerEvent) => {
    delta = Math.max(-leftWidth, Math.min(rightWidth, (moveEvent.clientX - startX) / scale));
    const preview = [...initialWidths];
    preview[dividerIndex] = leftWidth + delta;
    preview[dividerIndex + 1] = rightWidth - delta;
    grid.style.gridTemplateColumns = preview.map((width) => `${Math.max(0, width)}px`).join(" ");
    handle.style.setProperty("--layout-column-resize-preview-x", `${delta}px`);
  };
  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    handle.removeEventListener("lostpointercapture", onCancel);
    ownerWindow.removeEventListener("keydown", onKeyDown, true);
    grid.style.gridTemplateColumns = originalGridTemplateColumns;
    handle.style.removeProperty("--layout-column-resize-preview-x");
    delete handle.dataset.dragging;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (commit) onCommit(leftWidth + delta, rightWidth - delta);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(false);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  handle.addEventListener("lostpointercapture", onCancel);
  ownerWindow.addEventListener("keydown", onKeyDown, true);
  return onCancel;
}
