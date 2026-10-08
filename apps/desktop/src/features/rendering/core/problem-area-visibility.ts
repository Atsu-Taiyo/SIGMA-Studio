import type { ProblemAreaKind, ProblemNode } from "@/features/document";

import { isProblemAreaDisplayed, type ProblemDisplayFilter } from "./problem-display-filter";

/**
 * Which of a problem's areas the editor and the print renderer materialize.
 *
 * `lead`/`prompt` always render so a problem is never a blank hole; the optional
 * areas render once they hold content or the author has reserved height for them.
 *
 * `display` is the reader's own narrowing (問題だけ / 解答だけ …). It only ever removes areas:
 * an area it hides is never materialized, even `lead`/`prompt`, which the rule above would
 * otherwise force.
 */
export function shouldShowProblemArea(
  problem: ProblemNode,
  area: ProblemAreaKind,
  display?: ProblemDisplayFilter,
): boolean {
  if (display && !isProblemAreaDisplayed(display, area)) {
    return false;
  }
  return (
    area === "lead" ||
    area === "prompt" ||
    problem[area].length > 0 ||
    Boolean(problem.areaLayout?.[area]?.minHeightMm)
  );
}

/**
 * A visible-but-empty area still needs one editable paragraph. Its id is derived
 * rather than stored, so it is stable across renders but absent from the SigmaDoc.
 */
export function emptyProblemAreaEditorBlockId(problemId: string, area: ProblemAreaKind): string {
  return `${problemId}_${area}_empty`;
}
