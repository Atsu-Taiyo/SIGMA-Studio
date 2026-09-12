import type { Graph3DSpec } from "@/features/document";

/** Stable-enough derived-preview key; canonical data remains the Graph3DSpec. */
export function getGraph3DPreviewSourceHash(spec: Graph3DSpec): string {
  const source = JSON.stringify(spec);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // v2 stores only the WebGL scene. TeX labels stay as a live DOM overlay in every view.
  return `v2:fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
