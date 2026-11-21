import type { Editor } from "@tiptap/core";

export interface EditorInputTarget {
  editor: Editor;
  position: number;
}

interface EditorInputRouting {
  resolve: (position: number) => EditorInputTarget | null;
  focus: (position: number) => boolean | undefined;
}

// The page's caret router owns surface placement. Node views only ask for the
// current target; they never broadcast input to other copies of a document.
const routes = new WeakMap<Editor, EditorInputRouting>();

export function registerEditorInputRouting(editor: Editor, routing: EditorInputRouting): () => void {
  routes.set(editor, routing);
  return () => { if (routes.get(editor) === routing) routes.delete(editor); };
}

export function resolveEditorInputTarget(editor: Editor, position: number): EditorInputTarget | null {
  if (editor.isDestroyed) return null;
  const routing = routes.get(editor);
  return routing ? routing.resolve(position) : { editor, position };
}

export function focusRoutedEditorInput(editor: Editor, position: number): boolean | undefined {
  if (editor.isDestroyed) return false;
  return routes.get(editor)?.focus(position);
}
