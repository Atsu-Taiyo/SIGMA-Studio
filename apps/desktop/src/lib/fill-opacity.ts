/**
 * The one conversion between how a fill opacity is stored and how it is edited.
 *
 * SigmaDoc stores `fillOpacity` as 0..1; the toolbar shows whole percents. Both directions live
 * here so a slider, a number box and the persisted value cannot disagree by a rounding step.
 *
 * `0` is a real value, not "unset": a fully transparent fill still has a colour, and is a different
 * thing from `fill: "none"`. Every check here is `undefined`-aware rather than truthiness-based.
 */

/** What an omitted `fillOpacity` means everywhere it is drawn: fully opaque. */
export const DEFAULT_FILL_OPACITY = 1;

export function fillOpacityToPercent(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) {
    return DEFAULT_FILL_OPACITY * 100;
  }
  return Math.round(clampFillOpacity(opacity) * 100);
}

export function percentToFillOpacity(percent: number): number {
  if (!Number.isFinite(percent)) {
    return DEFAULT_FILL_OPACITY;
  }
  return Math.round(Math.min(100, Math.max(0, percent))) / 100;
}

export function clampFillOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) {
    return DEFAULT_FILL_OPACITY;
  }
  return Math.min(1, Math.max(0, opacity));
}

/** An omitted opacity reads as fully opaque, so stored and unstored fills compare equal. */
export function normalizeFillOpacity(opacity: number | undefined): number {
  return opacity === undefined ? DEFAULT_FILL_OPACITY : clampFillOpacity(opacity);
}
