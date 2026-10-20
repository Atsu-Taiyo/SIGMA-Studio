import type { Editor } from "@tiptap/core";

const commitListeners = new WeakMap<Editor, () => void>();
const pendingClicks = new WeakMap<Document, MouseEvent>();
const ignoredClicks = new WeakSet<Event>();

/** Reuse the owning TextFlowEditor's onSelect flow, even when the final range did not change. */
export function registerTextPointerSelectionCommit(editor: Editor, commit: () => void): () => void {
  commitListeners.set(editor, commit);
  return () => { commitListeners.delete(editor); };
}

/** Call only after a body text drag crossed its movement threshold. */
export function finishTextPointerSelection(editor: Editor, upEvent: MouseEvent): void {
  const doc = editor.view.dom.ownerDocument;
  pendingClicks.set(doc, upEvent);
  const clear = () => {
    if (pendingClicks.get(doc) === upEvent) pendingClicks.delete(doc);
    doc.removeEventListener("mousedown", clear, true);
  };
  // Chromium dispatches the synthesized click immediately after mouseup. Never retain a
  // guard into a later gesture, including when no click is dispatched outside the window.
  doc.addEventListener("mousedown", clear, { capture: true, once: true });
  doc.defaultView?.setTimeout(clear, 0);
  commitListeners.get(editor)?.();
}

/** Each ancestor sees the same native click; consuming it must not expose it to the next one. */
export function isTextPointerSelectionClick(event: MouseEvent): boolean {
  if (ignoredClicks.has(event)) return true;
  const doc = (event.currentTarget as Node | null)?.ownerDocument
    ?? (event.target as Node | null)?.ownerDocument;
  if (!doc) return false;
  const up = pendingClicks.get(doc);
  if (!up) return false;
  pendingClicks.delete(doc);
  if (event.detail === 0 || event.button !== up.button
    || event.clientX !== up.clientX || event.clientY !== up.clientY) return false;
  ignoredClicks.add(event);
  return true;
}
