import type { Editor, JSONContent } from "@tiptap/core";
import { countPerformanceEvent } from "@/lib/performance";

/** Patch a derived editor view without replacing its history or selection. */
export function applyEditorDocumentProjection(
  editor: Editor,
  content: JSONContent,
): void {
  const next = editor.schema.nodeFromJSON(content);
  const current = editor.state.doc;
  const start = current.content.findDiffStart(next.content);
  if (start === null) return;
  const end = current.content.findDiffEnd(next.content)!;
  let from = end.a;
  let to = end.b;
  const overlap = start - Math.min(from, to);
  if (overlap > 0) {
    from += overlap;
    to += overlap;
  }
  countPerformanceEvent("DocumentSession.projectionPatch");
  editor.view.dispatch(
    editor.state.tr
      .replace(start, from, next.slice(start, to))
      .setMeta("preventUpdate", true)
      .setMeta("addToHistory", false)
      .setMeta("sigmaSharedProjection", true),
  );
}
