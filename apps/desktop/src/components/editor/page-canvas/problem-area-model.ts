import {
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type ProblemNode,
  type RichBlock,
  type SigmaBlock,
  roundHalfMm,
} from "@/features/document";

import { shouldShowProblemArea } from "./block-ops";

export const OPTIONAL_PROBLEM_AREAS: readonly ProblemAreaKind[] = [
  "hints",
  "solution",
];

export type ProblemAreaTransitionRequest =
  | {
      type: "showOptionalArea";
      area: ProblemAreaKind;
      emptyBlockId: string;
    }
  | {
      type: "clearOptionalArea";
      area: ProblemAreaKind;
    }
  | {
      type: "setMinHeight";
      area: ProblemAreaKind;
      minHeightMm: number;
    };

export interface ProblemAreaTransition {
  targetId: string;
  reduce: (
    target: SigmaBlock | ProblemAreaBlock,
  ) => SigmaBlock | ProblemAreaBlock;
}

export function getHiddenOptionalProblemAreas(
  problem: ProblemNode,
): ProblemAreaKind[] {
  return OPTIONAL_PROBLEM_AREAS.filter(
    (area) => !shouldShowProblemArea(problem, area),
  );
}

export function getOptionalProblemAreaBlockIdPrefix(
  area: ProblemAreaKind,
): "comment" | "answer" {
  return area === "hints" ? "comment" : "answer";
}

export function resolveProblemAreaTransition(
  problemId: string,
  request: ProblemAreaTransitionRequest,
): ProblemAreaTransition {
  return {
    targetId: problemId,
    reduce: (target) => {
      if (target.type !== "problem") {
        return target;
      }

      if (request.type === "showOptionalArea") {
        return ensureOptionalProblemArea(
          target,
          request.area,
          request.emptyBlockId,
        );
      }
      if (request.type === "clearOptionalArea") {
        return clearOptionalProblemArea(target, request.area);
      }
      return setProblemAreaMinHeight(
        target,
        request.area,
        request.minHeightMm,
      );
    },
  };
}

function ensureOptionalProblemArea(
  problem: ProblemNode,
  area: ProblemAreaKind,
  emptyBlockId: string,
): ProblemNode {
  if (
    !OPTIONAL_PROBLEM_AREAS.includes(area)
    || shouldShowProblemArea(problem, area)
  ) {
    return problem;
  }

  return {
    ...problem,
    [area]: [createEmptyProblemAreaBlock(emptyBlockId)],
  };
}

function clearOptionalProblemArea(
  problem: ProblemNode,
  area: ProblemAreaKind,
): ProblemNode {
  if (!OPTIONAL_PROBLEM_AREAS.includes(area)) {
    return problem;
  }

  const areaLayout = { ...(problem.areaLayout ?? {}) };
  delete areaLayout[area];

  return {
    ...problem,
    [area]: [],
    areaLayout: Object.keys(areaLayout).length > 0 ? areaLayout : undefined,
  };
}

function createEmptyProblemAreaBlock(id: string): RichBlock {
  return {
    type: "paragraph",
    id,
    children: [],
  };
}

function setProblemAreaMinHeight(
  problem: ProblemNode,
  area: ProblemAreaKind,
  minHeightMm: number,
): ProblemNode {
  const rounded = Math.max(0, roundHalfMm(minHeightMm));
  const areaLayout = { ...(problem.areaLayout ?? {}) };
  const nextAreaLayout = { ...(areaLayout[area] ?? {}) };

  if (rounded > 0) {
    nextAreaLayout.minHeightMm = rounded;
    areaLayout[area] = nextAreaLayout;
  } else {
    delete nextAreaLayout.minHeightMm;
    if (Object.keys(nextAreaLayout).length > 0) {
      areaLayout[area] = nextAreaLayout;
    } else {
      delete areaLayout[area];
    }
  }

  return {
    ...problem,
    areaLayout: Object.keys(areaLayout).length > 0 ? areaLayout : undefined,
  };
}

/**
 * 導入文 (番号の右隣の1行) を出すか。出す (既定) ときは印を外し、空になった `areaLayout` も残さない。
 * 出さないときは導入文の文字と予約した高さを捨てて、行ごと畳む (`isProblemLeadFolded`)。
 * 捨てた中身は、ここを通した変更の取り消し (Ctrl+Z) で戻る。
 */
export function setProblemLeadShown(problem: ProblemNode, shown: boolean): ProblemNode {
  const areaLayout = { ...(problem.areaLayout ?? {}) };
  const lead = { ...(areaLayout.lead ?? {}) };
  if (shown) {
    delete lead.hidden;
  } else {
    lead.hidden = true;
    delete lead.minHeightMm;
  }
  if (Object.keys(lead).length > 0) {
    areaLayout.lead = lead;
  } else {
    delete areaLayout.lead;
  }
  return {
    ...problem,
    ...(shown || problem.lead.length === 0 ? {} : { lead: [] }),
    areaLayout: Object.keys(areaLayout).length > 0 ? areaLayout : undefined,
  };
}
