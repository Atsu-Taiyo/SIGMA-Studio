import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Fragment, Node } from "@tiptap/pm/model";
import type { SessionSelection } from "@/features/document-session/contracts";
import { countPerformanceEvent } from "@/lib/performance";

/** Patch a derived editor view without replacing its history or selection. */
export function applyEditorDocumentProjection(
  editor: Editor,
  content: JSONContent,
  selection?: SessionSelection | null,
): void {
  const next = editor.schema.nodeFromJSON(content);
  const current = editor.state.doc;
  if (current.eq(next)) return;
  countPerformanceEvent("DocumentSession.projectionPatch");
  const transaction = editor.state.tr;
  patchContent(transaction, current.content, next.content, 0, next);
  transaction
    .setMeta("preventUpdate", true)
    .setMeta("addToHistory", false)
    .setMeta("sigmaSharedProjection", true);
  // Selection follows the authoritative document, including disjoint peer edits
  // that a single projection replacement would otherwise map to its far edge.
  if (selection && editor.state.selection instanceof TextSelection) {
    const anchor = textPointPosition(transaction.doc, selection.anchor);
    const head = textPointPosition(transaction.doc, selection.head);
    if (anchor !== null && head !== null) {
      transaction.setSelection(TextSelection.create(transaction.doc, anchor, head));
      if (transaction.selection.empty && editor.state.storedMarks) transaction.setStoredMarks(editor.state.storedMarks);
    }
  }
  editor.view.dispatch(transaction);
}

/** Keep stable blocks and math atoms mounted, even when both sides change. */
function patchContent(transaction: Transaction, before: Fragment, after: Fragment, base: number, projected: Node): void {
  if (before.eq(after)) return;
  const oldNodes: Array<{ node: Node; offset: number }> = [];
  const byId = new Map<string, number>();
  before.forEach((node, offset, index) => {
    oldNodes.push({ node, offset });
    const key = nodeKey(node);
    if (key) byId.set(key, index);
  });
  let oldOffset = 0;
  let newOffset = 0;
  after.forEach((node, offset) => {
    const key = nodeKey(node);
    const index = key ? byId.get(key) : undefined;
    const old = index === undefined ? undefined : oldNodes[index];
    if (!old || old.offset < oldOffset) return;
    patchGap(transaction, before.cut(oldOffset, old.offset), after.cut(newOffset, offset), base + newOffset, projected);
    const position = base + offset;
    if (!old.node.sameMarkup(node)) transaction.setNodeMarkup(position, node.type, node.attrs, node.marks);
    if (!node.isLeaf) patchContent(transaction, old.node.content, node.content, position + 1, projected);
    oldOffset = old.offset + old.node.nodeSize;
    newOffset = offset + node.nodeSize;
  });
  patchGap(transaction, before.cut(oldOffset), after.cut(newOffset), base + newOffset, projected);
}

function nodeKey(node: Node): string | null {
  const id = node.attrs.sigmaDocId ?? node.attrs.id;
  return typeof id === "string" && id ? `${node.type.name}:${id}` : null;
}

function patchGap(transaction: Transaction, before: Fragment, after: Fragment, base: number, projected: Node): void {
  const start = before.findDiffStart(after);
  if (start === null) return;
  const end = before.findDiffEnd(after)!;
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  transaction.replace(base + start, base + end.a + overlap, projected.slice(base + start, base + end.b + overlap));
}

function textPointPosition(doc: Node, point: SessionSelection["anchor"]): number | null {
  let position: number | null = null;
  doc.descendants((node, offset) => {
    if (!node.isTextblock || node.attrs.sigmaDocId !== point.blockId) return true;
    position = offset + 1 + Math.min(node.content.size, Math.max(0, point.offset));
    return false;
  });
  return position;
}
