import { PROBLEM_AREA_ORDER, type SigmaBlock, type ProblemNode } from "@/features/document";

export function shouldShowProblemNumber(problem: ProblemNode): boolean {
  return problem.numbering?.enabled !== false;
}

export function getProblemNumberMap(content: SigmaBlock[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let nextNumber = 1;

  function visit(blocks: readonly SigmaBlock[]) {
    for (const block of blocks) {
      if (block.type === "problem") {
        if (shouldShowProblemNumber(block)) {
          const problemNumber = getSpecifiedProblemNumber(block) ?? nextNumber;
          numbers.set(block.id, problemNumber);
          nextNumber = problemNumber + 1;
        }
        for (const area of PROBLEM_AREA_ORDER) visit(block[area]);
      } else if (block.type === "boxBlock" || block.type === "quote") {
        visit(block.blocks);
      } else if (block.type === "layoutSection") {
        visit(block.children);
      }
    }
  }
  visit(content);

  return numbers;
}

function getSpecifiedProblemNumber(problem: ProblemNode): number | undefined {
  const value = problem.numbering?.value;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function formatProblemNumber(problemNumber: number): string {
  return String(problemNumber);
}
