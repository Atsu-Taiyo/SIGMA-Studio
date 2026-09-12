import type { SigmaDocument } from "@/features/document";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import { createBlankDocument } from "@/lib/blank-document";
import { isDocumentTitleExplicit } from "@/lib/document-title";

// The editor drops zero-length text nodes on mount. That normalization is not an edit.
function normalizeEmptyText(document: SigmaDocument): SigmaDocument {
  return {
    ...document,
    content: document.content.map((block) => block.type === "paragraph"
      ? { ...block, children: block.children.filter((node) => node.type !== "text" || node.text !== "") }
      : block),
  };
}

export function isUntouchedNewDocument(initial: SigmaDocument, current: SigmaDocument): boolean {
  // Only a freshly created blank material is eligible, never a template or imported document.
  if (initial.content.some((block) => block.type !== "paragraph"
    || block.children.some((node) => node.type !== "text" || node.text.length > 0))) return false;
  if (initial.comments?.length) return false;
  if (initial.pageLayout?.overlay?.overlaySnapshot?.shapes.length) return false;
  return areSigmaDocumentsEquivalent(normalizeEmptyText(initial), normalizeEmptyText(current));
}

/** Recognize a blank created on the workspace screen before this editor mounted. */
export function isPristineUntitledDocument(document: SigmaDocument, revision: number): boolean {
  if (revision !== 1 || document.content.length !== 1) return false;
  const baseTitle = document.metadata.title.replace(/ [1-9]\d*$/, "");
  if (isDocumentTitleExplicit(baseTitle)) return false;
  const blank = createBlankDocument(document.metadata.title);
  return isUntouchedNewDocument({
    ...blank,
    docId: document.docId,
    content: [{ ...blank.content[0], id: document.content[0].id }],
  }, document);
}
