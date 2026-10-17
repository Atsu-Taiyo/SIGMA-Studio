import type { BoxedRoundness } from "./model";

/** The full rounding the `oval` boxed variant draws when no roundness is given (percent). */
export const DEFAULT_BOXED_ROUNDNESS = 100;

/**
 * A stored `boxedRoundness` as a whole percentage in 0–100; anything else is ignored. The schema
 * only bounds it below, so an out-of-range value is clamped here rather than rejecting the file.
 */
export function normalizeBoxedRoundness(value: unknown): BoxedRoundness | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(DEFAULT_BOXED_ROUNDNESS, Math.round(value));
}
