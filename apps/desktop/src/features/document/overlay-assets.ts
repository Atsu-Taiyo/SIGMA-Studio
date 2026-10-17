import type { SigmaDocument } from "./model";
import { normalizeOverlayGroups } from "./overlay-group-normalization";
import type { OverlayAsset, OverlayShape, OverlaySnapshot } from "./overlay-model";

/** Remove unreachable image payloads, without mutating snapshots held by undo. */
export function pruneUnusedOverlayAssets(snapshot: OverlaySnapshot): OverlaySnapshot {
  const ids = new Set(Object.keys(snapshot.assets));
  if (ids.size === 0) return snapshot;
  const used = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (ids.has(value)) used.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        // Extensions may use asset IDs as keys as well as values.
        if (ids.has(key)) used.add(key);
        visit(child);
      }
    }
  };
  visit(snapshot.shapes);
  visit(snapshot.extensions);
  if (used.size === ids.size) return snapshot;
  return { ...snapshot, assets: Object.fromEntries(Object.entries(snapshot.assets).filter(([id]) => used.has(id))) };
}

/** Each body/header/footer overlay owns its own assets. Text containing JSON is ordinary text. */
export function pruneUnusedDocumentOverlayAssets(document: SigmaDocument): SigmaDocument {
  const layout = document.pageLayout;
  if (!layout) return document;
  let nextLayout = layout;
  for (const region of ["body", "header", "footer"] as const) {
    const overlay = region === "body" ? layout.overlay : layout[region]?.overlay;
    const snapshot = overlay?.overlaySnapshot;
    if (!snapshot) continue;
    const next = pruneUnusedOverlayAssets(snapshot);
    if (next === snapshot) continue;
    const nextOverlay = { ...overlay, overlaySnapshot: next };
    nextLayout = region === "body"
      ? { ...nextLayout, overlay: nextOverlay }
      : { ...nextLayout, [region]: { ...nextLayout[region], overlay: nextOverlay } };
  }
  return nextLayout === layout ? document : { ...document, pageLayout: nextLayout };
}

/**
 * Put `shapes` where the shape `shapeId` is, in its stack position, and add `assets`. The shapes are
 * the replacement's top-level shape (which takes the id) followed by its members. Assets nothing uses
 * any more (the replaced image's own picture) are dropped. "図形に変換" and the AI's proposal of the
 * same conversion both go through here, so the two cannot place the result differently.
 */
export function replaceOverlayShapeInSnapshot(
  snapshot: OverlaySnapshot,
  shapeId: string,
  shapes: readonly OverlayShape[],
  assets: Readonly<Record<string, OverlayAsset>> = {},
): OverlaySnapshot {
  const nextShapes = normalizeOverlayGroups(snapshot.shapes.flatMap((shape) => shape.id === shapeId ? [...shapes] : [shape]));
  return pruneUnusedOverlayAssets({ ...snapshot, shapes: nextShapes, assets: { ...snapshot.assets, ...assets } });
}
