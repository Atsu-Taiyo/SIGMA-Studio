import { expect, it, vi } from "vitest";
import { fetchProblemSearch } from "./problem-search-client";
const connection = { config: { apiUrl: "https://worker.example" }, authorization: async () => "Bearer synthetic-user-token" };
it("encodes search conditions, defaults limit, and authenticates without caching", async () => {
  const search = { ok: true, count: 1, results: [{ id: 31, has_solution: true }] };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(search));
  expect(await fetchProblemSearch({ q: "a&b", category: "整数", sort: "likes" }, connection, fetcher)).toEqual({ ok: true, search });
  const [url, init] = fetcher.mock.calls[0];
  const parsed = new URL(String(url));
  expect(parsed.origin + parsed.pathname).toBe("https://worker.example/integrations/juken/search");
  expect(Object.fromEntries(parsed.searchParams)).toEqual({ q: "a&b", category: "整数", sort: "likes", limit: "5" });
  expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer synthetic-user-token" }, redirect: "error", cache: "no-store" });
});
it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: "5" }, { q: "\n" }, { category: "x".repeat(101) }, { q: "x".repeat(501) }, { sort: "bad" }, { url: "https://evil.example" }])("rejects invalid input before network: %j", async (input) => {
  const fetcher = vi.fn<typeof fetch>();
  expect((await fetchProblemSearch(input, connection, fetcher)).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it("requires login before sending search terms", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect((await fetchProblemSearch({}, { ...connection, authorization: async () => { throw new Error("private"); } }, fetcher)).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it("accepts zero results but rejects malformed success data and credential echoes", async () => {
  for (const [data, ok] of [[{ ok: true, results: [] }, true], [{ ok: true }, false], [{ ok: false, results: [] }, false], [{ ok: true, results: ["synthetic-user-token"] }, false]] as const) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
    expect((await fetchProblemSearch({}, connection, fetcher)).ok).toBe(ok);
  }
});
it.each([302, 401, 403, 429, 500])("sanitizes upstream failures %s", async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private response body", { status }));
  const result = await fetchProblemSearch({}, connection, fetcher);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private response body");
});

it("omits explicitly undefined filters passed through the desktop bridge", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, results: [] }));
  await fetchProblemSearch({ q: "漸化式", category: undefined, sort: "likes", limit: 20 }, connection, fetcher);
  expect(Object.fromEntries(new URL(String(fetcher.mock.calls[0][0])).searchParams)).toEqual({ q: "漸化式", sort: "likes", limit: "20" });
});
