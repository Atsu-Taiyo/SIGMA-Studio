import type { SigmaDocument } from "./model";
import type { OverlaySnapshot } from "./overlay-model";

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
