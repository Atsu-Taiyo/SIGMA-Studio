import { createHash } from "node:crypto";
import * as Y from "yjs";
import { isObject } from "../../src/features/collaboration/model/value";

/**
 * Helpers for repairing a shared document's edits that the server refuses for their images (#251).
 *
 * The server validates the whole document after every operation it receives: each `src` must be a
 * `sigma-doc-storage://<id>` whose image was uploaded to that document. Everything already in the
 * server's document passed that check, and the server never forgets a registered image, so the images
 * unsent edits can need are the ones those edits write themselves (an undo that brings an image back
 * re-reveals a value some earlier operation wrote: either acknowledged — registered — or still unsent).
 */

/** The only image reference the server accepts (the document schema also allows older forms). */
export const STORAGE_SOURCE = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})$/;

/** The image ids the given Yjs updates write anywhere (e.g. as an asset's `src`). */
export function updateAssetReferences(updates: Iterable<Uint8Array>): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = STORAGE_SOURCE.exec(value);
      if (match) ids.add(match[1]);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (isObject(value)) Object.values(value).forEach(visit);
  };
  for (const update of updates) {
    for (const struct of Y.decodeUpdate(update).structs) {
      // Map values (`src` included) are stored as ContentAny. Text and nested types hold no image ids.
      if (struct instanceof Y.Item && (struct.content instanceof Y.ContentAny || struct.content instanceof Y.ContentJSON))
        struct.content.getContent().forEach(visit);
    }
  }
  return ids;
}

export interface DocumentImageReference {
  /** Id of the nearest enclosing object (the overlay asset). */
  ownerId: string;
  name: string | null;
  src: string;
  /** The image id when `src` is a reference the server accepts. */
  assetId?: string;
}

/** Every `src` of the projected document, as the server reads them. */
export function documentImageReferences(document: unknown): DocumentImageReference[] {
  const references: DocumentImageReference[] = [];
  const visit = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, owner));
      return;
    }
    if (!isObject(value)) return;
    const id = typeof value.id === "string" ? value.id : owner;
    if (typeof value.src === "string") {
      const match = STORAGE_SOURCE.exec(value.src);
      references.push({
        ownerId: id,
        name: typeof value.name === "string" && value.name ? value.name : null,
        src: value.src,
        ...(match ? { assetId: match[1] } : {}),
      });
    }
    Object.values(value).forEach((child) => visit(child, id));
  };
  visit(document, "");
  return references;
}

/**
 * Unsent operations as one update. The server validates the document after every operation, so an
 * operation that wrote an image nobody has stays refused even when a later one removed or replaced the
 * image; sent together, only the resulting document is validated. Yjs applies what the server already
 * has as nothing, so including operations it committed (a lost acknowledgement) applies nothing twice.
 */
export function mergeOperationUpdates(updates: Uint8Array[]): Uint8Array {
  return Y.mergeUpdates(updates);
}

/**
 * One operation id for a set of merged operations. The same set always gets the same id (and the same
 * merged bytes), so a retry after a lost acknowledgement is answered from the server's receipt.
 */
export function mergedOperationId(operationIds: string[]): string {
  const hash = createHash("sha256").update(`sigma-merged-operations:${operationIds.join(",")}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * The stand-in for an image that neither this device nor the server has. It keeps the place, size and
 * name of the image on the page, so the user sees where one is missing and can replace it.
 */
export const MISSING_IMAGE_PLACEHOLDER = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">'
  + '<rect x="2" y="2" width="156" height="116" rx="8" fill="#f4f4f5" stroke="#a1a1aa" stroke-width="3" stroke-dasharray="8 6"/>'
  + '<rect x="56" y="38" width="48" height="40" rx="4" fill="none" stroke="#a1a1aa" stroke-width="4"/>'
  + '<path d="M44 88L116 32" stroke="#a1a1aa" stroke-width="4" stroke-linecap="round"/>'
  + "</svg>",
).toString("base64")}`;
