import { z } from "zod";
import { fetchProblemReference } from "./problem-reference-client";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

export const ProblemSolutionRequestSchema = z.object({
  problemId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
}).strict();

export const PROBLEM_SOLUTION_BRIDGE_PATH = "/problem-solution";

export type ProblemSolutionResult =
  | { ok: true; solution: Record<string, unknown> }
  | { ok: false; error: string };

export interface ProblemSolutionConnection {
  config: { apiUrl: string };
  authorization(): Promise<string>;
}

/** Main-process only. The shared upstream key lives exclusively in the Worker. */
export async function fetchProblemSolution(
  input: unknown,
  connection: ProblemSolutionConnection | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProblemSolutionResult> {
  const parsed = ProblemSolutionRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ta("problemSolution.invalidId") };
  const result = await fetchProblemReference(
    `problems/${encodeURIComponent(parsed.data.problemId)}/solution`, connection,
    (key) => ta(`problemSolution.${key}`), fetchImpl,
  );
  return result.ok ? { ok: true, solution: result.data } : result;
}
