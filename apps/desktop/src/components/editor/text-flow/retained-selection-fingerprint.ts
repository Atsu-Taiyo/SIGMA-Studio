import type { Node } from "@tiptap/pm/model";
import type { CaretAddress } from "@/features/text-editing";

interface BlockEntry {
  id: string | null;
  node: Node;
}

// PM nodes are immutable. Reuse the block index and unchanged block contents;
// neither indexing nor comparing a range serializes the rest of the document.
const blockIndexes = new WeakMap<Node, readonly BlockEntry[]>();
const contentIdentities = new WeakMap<Node, unknown>();

function blocksIn(doc: Node): readonly BlockEntry[] {
  const cached = blockIndexes.get(doc);
  if (cached) return cached;
  const blocks: BlockEntry[] = [];
  const visit = (node: Node) => {
    const id: unknown = node.attrs.sigmaDocId;
    if (node.isBlock && typeof id === "string" && id) blocks.push({ id, node });
    else if (node.isTextblock) blocks.push({ id: null, node });
    if (!node.inlineContent) node.forEach(visit);
  };
  doc.forEach(visit);
  blockIndexes.set(doc, blocks);
  return blocks;
}

function stableAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableAttributes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, attribute]) => [key, stableAttributes(attribute)]));
  }
  return value;
}

function contentIdentity(node: Node): unknown {
  const cached = contentIdentities.get(node);
  if (cached !== undefined) return cached;
  const children: unknown[] = [];
  node.forEach(child => {
    if (child.isText) {
      const last = children.length - 1;
      // Mark boundaries may split the same text into arbitrarily many PM nodes.
      if (typeof children[last] === "string") children[last] += child.text!;
      else children.push(child.text!);
    } else if (child.isInline || child.isAtom) {
      // Inline math IDs identify node views; only TeX is its textual content.
      const attrs = child.type.name === "mathInline" ? { tex: child.attrs.tex } : child.attrs;
      children.push([child.type.name, stableAttributes(attrs), contentIdentity(child)]);
    } else {
      children.push([child.type.name, child.attrs.sigmaDocId ?? null, contentIdentity(child)]);
    }
  });
  contentIdentities.set(node, children);
  return children;
}

/**
 * Exact, mark-independent identity of every block between the endpoint blocks.
 * Documents must be supplied once each in canonical document order (no replicas).
 * Offsets remain fixed; missing/ambiguous IDs invalidate the retained selection.
 */
export function retainedSelectionFingerprint(
  documents: readonly Node[],
  anchor: CaretAddress,
  head: CaretAddress,
): string | null {
  const blocks = documents.flatMap(blocksIn);
  const anchorIndex = blocks.findIndex(block => block.id === anchor.blockId);
  const headIndex = blocks.findIndex(block => block.id === head.blockId);
  if (anchorIndex < 0 || headIndex < 0) return null;
  const selected = blocks.slice(Math.min(anchorIndex, headIndex), Math.max(anchorIndex, headIndex) + 1);
  const identified = selected.filter(block => block.id !== null);
  const ids = new Set(identified.map(block => block.id));
  if (blocks.filter(block => block.id !== null && ids.has(block.id)).length !== identified.length || ids.size !== identified.length) return null;
  return JSON.stringify(selected.map(({ id, node }) => [id, contentIdentity(node)]));
}
