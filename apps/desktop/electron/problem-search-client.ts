import { z } from "zod";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { fetchProblemReference } from "./problem-reference-client";
import type { ProblemSolutionConnection } from "./problem-solution-client";

const ta = createCurrentLocaleTranslator("ai");
export const ProblemSearchRequestSchema = z.object({
  q: z.string().max(500).regex(/^[^\x00-\x1f\x7f]*$/u).optional(),
  category: z.string().max(100).regex(/^[^\x00-\x1f\x7f]*$/u).optional(),
  sort: z.enum(["newest", "likes", "difficulty"]).optional(),
  limit: z.number().int().min(1).max(50).default(5),
}).strict();
export type ProblemSearchRequest = z.input<typeof ProblemSearchRequestSchema>;
export type ProblemSearchResult = { ok: true; search: Record<string, unknown> } | { ok: false; error: string };
export const PROBLEM_SEARCH_BRIDGE_PATH = "/problem-search";

export async function fetchProblemSearch(
  input: unknown, connection: ProblemSolutionConnection | null | undefined, fetchImpl: typeof fetch = fetch,
): Promise<ProblemSearchResult> {
  const parsed = ProblemSearchRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ta("problemSearch.invalidQuery") };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) query.set(key, String(value));
  const result = await fetchProblemReference(`search?${query}`, connection, (key) => ta(`problemSearch.${key}`), fetchImpl);
  if (!result.ok) return result;
  if (result.data.ok !== true || !Array.isArray(result.data.results)) return { ok: false, error: ta("problemSearch.invalidResponse") };
  return { ok: true, search: result.data };
}
