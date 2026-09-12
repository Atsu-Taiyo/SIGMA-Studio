export function isInsertTextShapeAtCursorShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.altKey &&
    !event.shiftKey &&
    (event.code === "KeyT" || event.key.toLowerCase() === "t")
  );
}
