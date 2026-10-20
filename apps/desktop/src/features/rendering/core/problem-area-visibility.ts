import type { ProblemAreaKind, ProblemNode } from "@/features/document";

import { isProblemAreaDisplayed, type ProblemDisplayFilter } from "./problem-display-filter";

/**
 * 導入文に文字が無い (空の段落だけ、または何も無い)。数式・図・区切りなど段落以外が1つでもあれば
 * 空ではない。「導入文の行を出さない」設定が効くかどうかの判定で、見えない中身を作らないために
 * 保守的に倒している。
 */
export function isProblemLeadBlank(problem: Pick<ProblemNode, "lead">): boolean {
  return problem.lead.every((block) => block.type === "paragraph" && block.children.length === 0);
}

/** 導入文の行を出さない設定で、実際に畳まれる状態か。文字があるときは設定があっても畳まない。 */
export function isProblemLeadFolded(problem: Pick<ProblemNode, "lead" | "areaLayout">): boolean {
  const layout = problem.areaLayout?.lead;
  return layout?.hidden === true && !layout.minHeightMm && isProblemLeadBlank(problem);
}

/**
 * Which of a problem's areas the editor and the print renderer materialize.
 *
 * `prompt` always renders so a problem is never a blank hole, and so does `lead` unless the author turned
 * the line off (`areaLayout.lead.hidden`, honored only while it is empty); the optional
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
  if (area === "lead") {
    return !isProblemLeadFolded(problem);
  }
  return (
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
