import { z } from "zod";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

import { importTexProblem } from "./tex-import";
import { parseSigmaDocument } from "./sigma-doc-schema";
import type { SigmaDocument } from "@/features/document";

// These are upstream API identifiers, not UI copy.
// eslint-disable-next-line no-restricted-syntax -- The API accepts Japanese category identifiers in every locale.
export const PROBLEM_LIBRARY_CATEGORIES = [{ key: "integers", value: "整数" }, { key: "algebra", value: "数と式" }, { key: "geometry", value: "図形" }, { key: "complex", value: "複素数平面" }, { key: "calculus", value: "微積分" }, { key: "probability", value: "確率" }, { key: "sequences", value: "数列" }] as const;

export interface ProblemLibraryQuery {
  q?: string;
  category?: string;
  sort?: "newest" | "likes" | "difficulty";
  limit?: number;
}
export type ProblemLibrarySearchResult =
  | { ok: true; search: Record<string, unknown> }
  | { ok: false; error: string };
export interface ProblemLibraryBridge {
  search(query: ProblemLibraryQuery): Promise<ProblemLibrarySearchResult>;
  getSolution(request: { problemId: string }): Promise<
    { ok: true; solution: Record<string, unknown> } | { ok: false; error: string }
  >;
}

// Validate the upstream payload before it reaches either the preview or the importer.
const problemSchema = z.object({
  id: z.union([z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.number().int().nonnegative().safe()]).transform(String),
  title: z.string().trim().min(1).max(2000),
  problem_tex: z.string().trim().min(1).max(1_000_000),
  category: z.string().max(100).nullish(),
  source_name: z.string().max(2000).nullish(),
  tags: z.array(z.string().max(200)).max(100).nullish(),
  has_solution: z.boolean().nullish(),
});
export type LibraryProblem = z.infer<typeof problemSchema>;

const solutionKinds = ["official", "author", "editorial"] as const;
const solutionContentSchema = z.object({
  format: z.literal("tex"),
  content: z.string().trim().min(1).max(1_000_000),
});
const solutionResponseSchema = z.object({
  ok: z.literal(true),
  problem: z.object({ id: problemSchema.shape.id }),
  solutions: z.object({
    official: solutionContentSchema.nullable(),
    author: solutionContentSchema.nullable(),
    editorial: solutionContentSchema.nullable(),
  }),
});
export interface LibrarySolution {
  kind: typeof solutionKinds[number];
  content: string;
}

/** Only safe, localized failures from this boundary may be displayed by the dialog. */
export class ProblemLibraryImportError extends Error {}

/** Fetch only on import; never silently turn an answer-bearing item into a prompt-only import. */
export async function prepareLibraryProblemImport(problem: LibraryProblem, bridge: ProblemLibraryBridge | undefined): Promise<SigmaDocument> {
  const checked = problemSchema.parse(problem);
  if (checked.has_solution === false) return problemToSigmaDocument(checked);
  const t = createCurrentLocaleTranslator("editor");
  if (typeof bridge?.getSolution !== "function") {
    throw new ProblemLibraryImportError(t("problemLibrary.restartRequired"));
  }
  let result: Awaited<ReturnType<ProblemLibraryBridge["getSolution"]>>;
  try {
    result = await bridge.getSolution({ problemId: checked.id });
  } catch {
    throw new ProblemLibraryImportError(t("problemLibrary.solutionLoadFailed"));
  }
  if (!result.ok) throw new ProblemLibraryImportError(t("problemLibrary.solutionLoadFailed"));
  try {
    const response = solutionResponseSchema.parse(result.solution);
    if (response.problem.id !== checked.id) throw new Error("Mismatched problem");
    const solutions = solutionKinds.flatMap(kind => {
      const entry = response.solutions[kind];
      return entry ? [{ kind, content: entry.content }] : [];
    });
    if (checked.has_solution === true && solutions.length === 0) throw new Error("Missing solution");
    // Validate each explanation independently, so headings cannot hide empty or unsupported TeX.
    for (const solution of solutions) importTexProblem({ title: checked.title, prompt: solution.content });
    return problemToSigmaDocument(checked, solutions);
  } catch {
    throw new ProblemLibraryImportError(t("problemLibrary.solutionUnavailable"));
  }
}

export function readLibraryProblems(search: Record<string, unknown>): LibraryProblem[] {
  const parsed = z.object({ ok: z.literal(true), results: z.array(problemSchema).max(50) }).parse(search);
  return [...new Map(parsed.results.map(problem => [problem.id, problem])).values()];
}

export function problemSourceUrl(problem: LibraryProblem): string {
  return `https://jukenmath.net/problems/${encodeURIComponent(problem.id)}`;
}

export function problemToSigmaDocument(problem: LibraryProblem, solutions: readonly LibrarySolution[] = []): SigmaDocument {
  const checked = problemSchema.parse(problem);
  const t = createCurrentLocaleTranslator("editor");
  const solution = solutions.map(({ kind, content }) => `\\subsection*{${t(`problemLibrary.solutionLabels.${kind}`)}}\n${content}`).join("\n\n");
  const doc = importTexProblem({ title: checked.title, prompt: checked.problem_tex, solution, tags: [...(checked.category ? [checked.category] : []), ...(checked.tags ?? [])] });
  const block = doc.content[0];
  if (block.type === "problem") {
    // Plain text: source metadata must never be interpreted as TeX or HTML.
    block.lead.push({ type: "paragraph", id: "juken_source", children: [
      { type: "text", text: createCurrentLocaleTranslator("editor")("problemLibrary.provenance", { url: problemSourceUrl(checked) }) + (checked.source_name ? ` / ${checked.source_name}` : "") },
    ] });
  }
  return parseSigmaDocument(doc);
}
