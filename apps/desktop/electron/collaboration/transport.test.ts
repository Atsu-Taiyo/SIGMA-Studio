import { afterEach, expect, it, vi } from "vitest";
import { CollaborationHttpError, readResponseBytes, readResponseJson, responseError, retryAfterMilliseconds, retryDelay } from "./transport";

afterEach(() => vi.restoreAllMocks());

it("cancels an unbounded chunked body immediately on overflow", async () => {
  const cancel = vi.fn();
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024)); }, cancel,
  }, { highWaterMark: 0 });
  await expect(readResponseBytes(new Response(stream), 2048)).rejects.toThrow("RESPONSE_LIMIT");
  expect(reads).toBe(3);
  expect(cancel).toHaveBeenCalledOnce();
});

it("counts UTF-8 bytes and rejects non-JSON responses without reading them", async () => {
  await expect(readResponseJson(Response.json({ text: "あいう" }), 12)).rejects.toThrow("RESPONSE_LIMIT");
  const cancel = vi.fn();
  await expect(readResponseJson(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html" } }), 1024)).rejects.toThrow("INVALID_RESPONSE_TYPE");
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves HTTP status and retry deadlines without exposing arbitrary server text", async () => {
  const error = await responseError(Response.json({ error: "RATE_LIMIT" }, { status: 429, headers: { "Retry-After": "120" } }));
  expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000, message: "RATE_LIMIT" });
  expect((await responseError(Response.json({ error: "private request content" }, { status: 502 }))).message).toBe("HTTP_502");
  expect(retryAfterMilliseconds("Thu, 01 Oct 2026 10:00:02 GMT", Date.parse("2026-10-01T10:00:00Z"))).toBe(2000);
  expect(retryAfterMilliseconds("invalid")).toBe(0);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  expect([1, 2, 3, 10].map(n => retryDelay(n))).toEqual([7500, 15000, 30000, 45000]);
  expect(retryDelay(1, new CollaborationHttpError("RATE_LIMIT", 429, 120_000))).toBe(120_000);
});
