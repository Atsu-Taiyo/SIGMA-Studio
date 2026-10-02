import { afterEach, expect, it, vi } from "vitest";
import type { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CollaborationSessions } from "./sessions";
import { CollaborationHttpError } from "./transport";

vi.mock("electron", () => ({ safeStorage: {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const account = new AbortController();
  let actor = "account-before";
  const sessions = new CollaborationSessions("/unused-transport-fixture", {} as LocalSigmaDocStore, () => {});
  Object.defineProperty(sessions, "auth", { value: {
    config: { apiUrl: "https://sync.example.test" }, user: () => ({ id: actor }),
    accountSignal: () => account.signal, authorization: async () => "Bearer fixture",
  } });
  return { sessions, account, switchActor: () => { actor = "account-after"; } };
}
it("cancels active requests with the account lifetime and never follows redirects", async () => {
  const { sessions, account } = fixture();
  const started = Promise.withResolvers<void>();
  const request = vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    started.resolve();
  }));
  vi.stubGlobal("fetch", request);
  const pending = sessions.request("/catalog/capabilities");
  const rejected = expect(pending).rejects.toThrow("ACCOUNT_CHANGED");
  await started.promise;
  account.abort();
  await rejected;
  expect(request.mock.calls[0][1].redirect).toBe("error");
});
it("rejects an old account response even if the transport completes after cancellation", async () => {
  const { sessions, account, switchActor } = fixture();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn(() => { started.resolve(); return response.promise; }));
  const pending = sessions.request("/catalog/capabilities");
  const rejected = expect(pending).rejects.toThrow("ACCOUNT_CHANGED");
  await started.promise;
  account.abort(); switchActor();
  response.resolve(Response.json({ privateOldAccount: true }));
  await rejected;
});
it("retains the HTTP status and Retry-After on a server error", async () => {
  const { sessions } = fixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "RATE_LIMIT" }, { status: 429, headers: { "Retry-After": "90" } })));
  await expect(sessions.request("/catalog/delta", {})).rejects.toMatchObject({ status: 429, retryAfterMs: 90_000 });
  await expect(sessions.request("/catalog/delta", {})).rejects.toBeInstanceOf(CollaborationHttpError);
});
