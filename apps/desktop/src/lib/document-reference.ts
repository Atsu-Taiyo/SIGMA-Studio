import type { DocumentReference } from "@/features/document";

export const DOCUMENT_REFERENCE_CANDIDATES_EVENT = "sigma-studio:reference-candidates";
export interface DocumentReferenceCandidate { reference: DocumentReference; label: string }
export interface ReferenceCandidatesRequest { candidates: DocumentReferenceCandidate[] }

export function readDocumentReference(value: unknown): DocumentReference | undefined {
  if (!value || typeof value !== "object") return;
  const { kind, id } = value as Record<string, unknown>;
  if ((kind === "document" || kind === "material") && typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(id)) return { kind, id };
}

export function referenceAttributes(reference: DocumentReference): Record<string, string> {
  return { "data-document-reference-kind": reference.kind, "data-document-reference-id": reference.id };
}

export function referenceAt(element: Element): DocumentReference | undefined {
  return readDocumentReference({ kind: element.getAttribute("data-document-reference-kind"), id: element.getAttribute("data-document-reference-id") });
}
