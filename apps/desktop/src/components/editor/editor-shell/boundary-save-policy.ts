export type BoundarySaveSafety =
  | "safe"
  | "save-failed"
  | "dirty-skipped"
  | "dirty-unsaved";

/**
 * A boundary operation is safe only when no in-memory edits remain afterward.
 * Keeping skip classification here prevents close and document replacement from
 * silently assigning different meanings to the same successful-looking result.
 */
export function classifyBoundarySaveSafety(input: {
  saveOk: boolean;
  skipped: boolean;
  dirty: boolean;
}): BoundarySaveSafety {
  if (input.dirty) return input.skipped ? "dirty-skipped" : "dirty-unsaved";
  return input.saveOk ? "safe" : "save-failed";
}
