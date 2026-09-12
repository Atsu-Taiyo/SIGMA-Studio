import { pxToPt, roundFontSize } from "@/features/document/overlay-text-font";

/**
 * Facade over the canonical pt/px conversion in `@/features/document/overlay-text-font`, following
 * the same pattern as `lib/line-height.ts` / `lib/page-layout.ts`. Only the UI-formatting helpers
 * below are owned here — the arithmetic must stay shared with the overlay text renderers.
 */
export {
  CSS_PX_PER_PT,
  ptToPx,
  pxToPt,
  roundFontSize,
} from "@/features/document/overlay-text-font";

export const FONT_SIZE_UNIT_PT = "pt" as const;

export function formatFontSizePt(value: number): string {
  return Number.isInteger(value) ? `${value}pt` : `${value.toFixed(1)}pt`;
}

export function parseCssFontSizeToPt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  if (/px$/iu.test(trimmed)) {
    return pxToPt(numeric);
  }
  return roundFontSize(numeric);
}
