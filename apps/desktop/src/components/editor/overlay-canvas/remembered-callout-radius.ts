import { DEFAULT_CALLOUT_CORNER_RADIUS } from "./shapes/callout";

export const CALLOUT_CORNER_RADIUS_STORAGE_KEY = "sigma-studio:overlay-callout-corner-radius";

let rememberedCalloutCornerRadius = DEFAULT_CALLOUT_CORNER_RADIUS;

export function readRememberedCalloutCornerRadius(): number {
  if (typeof window === "undefined") {
    return rememberedCalloutCornerRadius;
  }
  try {
    const raw = window.localStorage.getItem(CALLOUT_CORNER_RADIUS_STORAGE_KEY);
    const stored = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(stored) && stored >= 0) {
      rememberedCalloutCornerRadius = stored;
    }
  } catch {
    // 保存領域を利用できない環境ではメモリ上の値を使う。
  }
  return rememberedCalloutCornerRadius;
}

export function rememberCalloutCornerRadius(radius: number): void {
  rememberedCalloutCornerRadius = radius;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CALLOUT_CORNER_RADIUS_STORAGE_KEY, String(radius));
  } catch {
    // 保存領域を利用できなくても、現在の編集セッションでは上の値を引き継げる。
  }
}