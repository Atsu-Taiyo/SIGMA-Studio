import { PROBLEM_AREA_ORDER, type ProblemNode, type SigmaBlock } from "../model/blocks";

export type ProblemStyle = Pick<ProblemNode, "numbering" | "frame" | "areaLayout">;

/** New content keeps its identity and answer; only the preceding problem's presentation is reused. */
export function inheritProblemStyle(problem: ProblemNode, previous: ProblemStyle): ProblemNode {
  const numbering = previous.numbering ? structuredClone(previous.numbering) : undefined;
  if (numbering) {
    delete numbering.value;
    if (problem.numbering?.value !== undefined) numbering.value = problem.numbering.value;
  }
  return {
    ...problem,
    ...(numbering ? { numbering } : {}),
    ...(previous.frame ? { frame: structuredClone(previous.frame) } : {}),
    ...(previous.areaLayout ? { areaLayout: structuredClone(previous.areaLayout) } : {}),
  };
}

/** Resolve the predecessor at the actual insertion position, including problems inside boxes. */
function* walkBlocks(blocks: readonly SigmaBlock[]): Generator<SigmaBlock> {
    for (const block of blocks) {
      yield block;
      if (block.type === "problem") {
        for (const area of PROBLEM_AREA_ORDER) yield* walkBlocks(block[area]);
      } else if (block.type === "boxBlock" || block.type === "quote") {
        yield* walkBlocks(block.blocks);
      } else if (block.type === "layoutSection") {
        yield* walkBlocks(block.children);
      }
    }
}

/** A text surface may start inside a box; its predecessor can belong to another surface. */
export function findPreviousProblem(content: readonly SigmaBlock[], beforeBlockId: string): ProblemNode | null {
  let previous: ProblemNode | null = null;
  for (const block of walkBlocks(content)) {
    if (block.id === beforeBlockId) return previous;
    if (block.type === "problem") previous = block;
  }
  return null;
}

export function inheritPreviousProblemStyle(content: readonly SigmaBlock[], problemId: string): ProblemNode | null {
  const problem = [...walkBlocks(content)].find(block => block.id === problemId);
  if (problem?.type !== "problem") return null;
  const previous = findPreviousProblem(content, problemId);
  return previous ? inheritProblemStyle(problem, previous) : problem;
}
