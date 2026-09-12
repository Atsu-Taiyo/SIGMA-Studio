// Compatibility facade for older editor imports. Canonical SigmaDoc snapshot
// operations live in the document feature and are UI/framework independent.
export {
  createEmptyOverlaySnapshot,
  isValidOverlaySnapshot,
  normalizeOverlaySnapshot,
  patchShape,
  removeShapes,
  upsertShape,
} from "@/features/document";
