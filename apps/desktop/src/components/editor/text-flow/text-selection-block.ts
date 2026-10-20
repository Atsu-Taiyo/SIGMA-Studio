import type { Node } from "@tiptap/pm/model";

/** Resolve a text selection's first block, including AllSelection and container boundaries. */
export function resolveTextSelectionBlockId(doc: Node, position: number, to = position): string | null {
  const from = Math.max(0, Math.min(position, doc.content.size));
  const end = Math.max(from, Math.min(to, doc.content.size));
  const $from = doc.resolve(from);
  if (end === from) {
    for (let depth = $from.depth; depth >= 0; depth -= 1) {
      const id = $from.node(depth).attrs.sigmaDocId;
      if (typeof id === "string" && id) return id;
    }
    for (const node of [$from.nodeAfter, $from.nodeBefore]) {
      const id = node?.attrs.sigmaDocId;
      if (typeof id === "string" && id) return id;
    }
    return null;
  }
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    // List paragraphs and box titles may carry their canonical id on their parent.
    if (node.isTextblock) {
      for (let owner = depth; owner > 0; owner -= 1) {
        const id = $from.node(owner).attrs.sigmaDocId;
        if (typeof id === "string" && id) return id;
      }
    }
  }
  let first: string | null = null;
  doc.nodesBetween(from, end, (node, pos) => {
    if (first) return false;
    if (!node.isTextblock) return true;
    const id = node.attrs.sigmaDocId;
    if (typeof id === "string" && id) first = id;
    else {
      const $inside = doc.resolve(pos + 1);
      for (let depth = $inside.depth; depth > 0; depth -= 1) {
        const ownerId = $inside.node(depth).attrs.sigmaDocId;
        if (typeof ownerId === "string" && ownerId) { first = ownerId; break; }
      }
    }
    return false;
  });
  return first;
}
