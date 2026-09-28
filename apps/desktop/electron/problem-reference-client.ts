import type { ProblemSolutionConnection } from "./problem-solution-client";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type Failure = "unconfigured" | "loginRequired" | "denied" | "notFound" | "rateLimited" | "upstreamError" | "invalidResponse" | "emptyResponse" | "tooLarge" | "unsafeResponse" | "connectionFailed";

/** Internal fixed-route transport. Credentials stay in Electron main; responses are not persisted. */
export async function fetchProblemReference(
  route: string,
  connection: ProblemSolutionConnection | null | undefined,
  message: (key: Failure) => string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  if (!connection) return { ok: false, error: message("unconfigured") };
  try {
    const base = new URL(connection.config.apiUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      return { ok: false, error: message("unconfigured") };
    }
    let authorization: string;
    try { authorization = await connection.authorization(); }
    catch { return { ok: false, error: message("loginRequired") }; }
    const key = authorization.replace(/^Bearer /u, "");
    const response = await fetchImpl(
      `${base.origin}/integrations/juken/${route}`,
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
        ? message("denied")
        : response.status === 404
          ? message("notFound")
          : response.status === 429
            ? message("rateLimited")
            : message("upstreamError");
      return { ok: false, error };
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      return { ok: false, error: message("invalidResponse") };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, error: message("emptyResponse") };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return { ok: false, error: message("tooLarge") };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    // Defend against a misconfigured upstream echoing the bearer token even on success.
    if (body.includes(key)) return { ok: false, error: message("unsafeResponse") };
    const data: unknown = JSON.parse(body);
    if (JSON.stringify(data).includes(key)) return { ok: false, error: message("unsafeResponse") };
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: message("invalidResponse") };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return { ok: false, error: message("connectionFailed") };
  }
}
