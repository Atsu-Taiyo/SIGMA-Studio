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
