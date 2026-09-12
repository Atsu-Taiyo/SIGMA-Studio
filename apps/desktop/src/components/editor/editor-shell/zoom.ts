import { MAX_ZOOM, MIN_ZOOM } from "@/components/editor/editor-shell/constants";

/** Normalizes every zoom entry path to the same finite integer range. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }

  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)));
}
