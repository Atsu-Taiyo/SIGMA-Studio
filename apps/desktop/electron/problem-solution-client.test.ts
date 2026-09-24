import { describe, expect, it, vi } from "vitest";
import { fetchProblemSolution } from "./problem-solution-client";

const key = "synthetic-test-key-do-not-use";
const connection = { config: { apiUrl: "https://worker.example" }, authorization: async () => `Bearer ${key}` };

describe("private problem solution client", () => {
  it("requires a login and rejects insecure Worker configuration before transmitting a token", async () => {
    const request = vi.fn<typeof fetch>();
    expect((await fetchProblemSolution({ problemId: "123" }, { ...connection, authorization: async () => { throw new Error("AUTH_REQUIRED"); } }, request)).ok).toBe(false);
    expect((await fetchProblemSolution({ problemId: "123" }, { ...connection, config: { apiUrl: "http://worker.example" } }, request)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("uses the fixed GET endpoint without caching or following redirects", async () => {
    const solution = { solutions: [{ type: "official", content: "Synthetic answer" }] };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(solution));
    expect(await fetchProblemSolution({ problemId: "p-123" }, connection, request)).toEqual({ ok: true, solution });
    expect(request).toHaveBeenCalledWith("https://worker.example/integrations/juken/problems/p-123/solution", {
      method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
    });
  });

  it.each(["../secret", "p/x", "p?x=1", "", "p#x", "%2e%2e", "x".repeat(129)])("rejects unsafe IDs before sending a request: %s", async (problemId) => {
    const request = vi.fn<typeof fetch>();
    expect((await fetchProblemSolution({ problemId }, connection, request)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed without a configured key", async () => {
    const request = vi.fn<typeof fetch>();
    expect((await fetchProblemSolution({ problemId: "123" }, undefined, request)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([301, 401, 403, 404, 429, 500])("never returns the upstream error body (%s)", async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${key}: private upstream details`, { status }));
    const result = await fetchProblemSolution({ problemId: "123" }, connection, request);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-test-key|private upstream details/);
  });

  it("sanitizes transport failures", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Authorization: Bearer ${key}`));
    const result = await fetchProblemSolution({ problemId: "123" }, connection, request);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each([null, [], "answer", 123])("rejects invalid top-level JSON %s", async (value) => {
    expect((await fetchProblemSolution({ problemId: "123" }, connection,
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(value)))).ok).toBe(false);
  });

  it("rejects credential echoes, non-JSON, broken JSON and oversized responses", async () => {
    for (const response of [Response.json({ secret: key }), new Response("<html>error</html>"),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
      Response.json({ content: "x".repeat(2 * 1024 * 1024) })]) {
      expect((await fetchProblemSolution({ problemId: "123" }, connection,
        vi.fn<typeof fetch>().mockResolvedValue(response))).ok).toBe(false);
    }
  });
});
