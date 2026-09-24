import { z } from "zod";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

export const ProblemSolutionRequestSchema = z.object({
  problemId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
}).strict();

export const PROBLEM_SOLUTION_BRIDGE_PATH = "/problem-solution";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
  if (!connection) return { ok: false, error: ta("problemSolution.unconfigured") };
  try {
    const base = new URL(connection.config.apiUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      return { ok: false, error: ta("problemSolution.unconfigured") };
    }
    let authorization: string;
    try { authorization = await connection.authorization(); }
    catch { return { ok: false, error: ta("problemSolution.loginRequired") }; }
    const key = authorization.replace(/^Bearer /u, "");
    const response = await fetchImpl(
      `${base.origin}/integrations/juken/problems/${encodeURIComponent(parsed.data.problemId)}/solution`,
      {
        method: "GET",
        headers: { Authorization: authorization, Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      const error = response.status === 401 || response.status === 403
        ? ta("problemSolution.denied")
        : response.status === 404
          ? ta("problemSolution.notFound")
          : response.status === 429
            ? ta("problemSolution.rateLimited")
            : ta("problemSolution.upstreamError");
      return { ok: false, error };
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      return { ok: false, error: ta("problemSolution.invalidResponse") };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, error: ta("problemSolution.emptyResponse") };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return { ok: false, error: ta("problemSolution.tooLarge") };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    // Defend against a misconfigured upstream echoing the bearer token even on success.
    if (body.includes(key)) return { ok: false, error: ta("problemSolution.unsafeResponse") };
    const solution: unknown = JSON.parse(body);
    if (JSON.stringify(solution).includes(key)) return { ok: false, error: ta("problemSolution.unsafeResponse") };
    if (!solution || typeof solution !== "object" || Array.isArray(solution)) {
      return { ok: false, error: ta("problemSolution.invalidResponse") };
    }
    return { ok: true, solution: solution as Record<string, unknown> };
  } catch {
    return { ok: false, error: ta("problemSolution.connectionFailed") };
  }
}
