import {
  DEFAULT_OVERLAY_SHAPE_STYLE,
  normalizeStyleDefaults,
  type OverlayShapeStyleDefaults,
} from "@/features/drawing";

/**
 * Where the last-used shape style lives between insertions.
 *
 * `localStorage`, following `sigma-studio:overlay-callout-corner-radius` and the palette's custom
 * swatches: it reads synchronously, so the very first insertion after a mount already has the
 * style, and it works in the browser build as well as in Electron. The in-memory copy is what keeps
 * this working when storage is unavailable (private mode, a locked-down embed) — within the session
 * at least.
 *
 * `features/drawing` owns the rules and cannot touch the DOM, so the storage lives here.
 */
const STORAGE_KEY = "sigma-studio:overlay-shape-style-defaults";

let rememberedShapeStyle: OverlayShapeStyleDefaults = DEFAULT_OVERLAY_SHAPE_STYLE;

export function readRememberedShapeStyle(): OverlayShapeStyleDefaults {
  if (typeof window === "undefined") {
    return rememberedShapeStyle;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      rememberedShapeStyle = normalizeStyleDefaults(JSON.parse(raw));
    }
  } catch {
    // 壊れた JSON でも保存領域が使えなくても、直前の値か既定値で描き始められる。
  }
  return rememberedShapeStyle;
}

export function rememberShapeStyle(style: OverlayShapeStyleDefaults): OverlayShapeStyleDefaults {
  rememberedShapeStyle = normalizeStyleDefaults(style);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rememberedShapeStyle));
    } catch {
      // 保存できなくても、この編集セッションの続きには上のメモリ値が効く。
    }
  }
  for (const listener of listeners) {
    listener(rememberedShapeStyle);
  }
  return rememberedShapeStyle;
}

/**
 * Notified whenever the style changes.
 *
 * The body canvas and a header/footer canvas can be mounted at the same time. Without this, each
 * would hold the snapshot it took when it mounted, and the second one to save would write its stale
 * copy back over the first one's change.
 */
const listeners = new Set<(style: OverlayShapeStyleDefaults) => void>();

export function subscribeRememberedShapeStyle(
  listener: (style: OverlayShapeStyleDefaults) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget both copies. */
export function resetRememberedShapeStyleForTest(): void {
  rememberedShapeStyle = DEFAULT_OVERLAY_SHAPE_STYLE;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to clean up when storage is unavailable
  }
}
