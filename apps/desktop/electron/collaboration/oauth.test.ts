import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { googleAuthorization } from "./oauth";

afterEach(() => vi.useRealTimers());
it("binds a one-use callback to its random path and exchanges only the PKCE code", async () => {
  let callback = "";
  let challenge = "";
  const result = await googleAuthorization("https://auth.example.test", async (address) => {
    const url = new URL(address);
    expect(url.origin).toBe("https://auth.example.test");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    callback = url.searchParams.get("redirect_to")!;
    challenge = url.searchParams.get("code_challenge")!;
    expect(new URL(callback).hostname).toBe("127.0.0.1");
    expect(new URL(callback).pathname).toMatch(/^\/auth\/callback\/[\w-]{43}$/);
    expect((await fetch(`${new URL(callback).origin}/auth/callback/wrong?code=bad`)).status).toBe(404);
    expect((await fetch(`${callback}?code=first&code=second`)).status).toBe(400);
    expect((await fetch(`${callback}?code=test-code`, { method: "POST" })).status).toBe(404);
    const response = await fetch(`${callback}?code=test-code`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("test-code");
  }, new AbortController().signal);
  expect(result.code).toBe("test-code");
  expect(createHash("sha256").update(result.verifier).digest("base64url")).toBe(challenge);
  await expect(fetch(callback)).rejects.toThrow();
});
it("closes its listener on cancellation and allows a fresh attempt", async () => {
  const abort = new AbortController();
  let callback = "";
  await expect(googleAuthorization("https://auth.example.test", async (address) => {
    callback = new URL(address).searchParams.get("redirect_to")!;
    abort.abort();
  }, abort.signal)).rejects.toThrow("AUTH_CANCELLED");
  await expect(fetch(callback)).rejects.toThrow();
});
it("does not reflect provider errors or browser launch failures into callback content", async () => {
  await expect(googleAuthorization("https://auth.example.test", async (address) => {
    const callback = new URL(address).searchParams.get("redirect_to")!;
    const response = await fetch(`${callback}?error=access_denied&error_description=secret`);
    expect(await response.text()).not.toContain("secret");
  }, new AbortController().signal)).rejects.toThrow("AUTH_FAILED");
  await expect(googleAuthorization("https://auth.example.test", async () => { throw new Error("BROWSER_UNAVAILABLE"); }, new AbortController().signal)).rejects.toThrow("BROWSER_UNAVAILABLE");
});
it("expires an abandoned browser login", async () => {
  const opened = Promise.withResolvers<void>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = googleAuthorization("https://auth.example.test", async () => { opened.resolve(); }, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow("AUTH_TIMEOUT");
  await opened.promise;
  await vi.advanceTimersByTimeAsync(180_000);
  await rejected;
});
