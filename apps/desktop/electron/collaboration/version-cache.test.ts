import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedVersionCache } from "./version-cache";
import { CollaborationSessions } from "./sessions";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CollaborationHttpError } from "./transport";
import { NetworkUnavailableError } from "../network-unavailable";
vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
const summary = { id: "aaaaaaaa-0000-4000-8000-000000000001", epoch: 1, created_at: "2026-11-13T00:00:00Z", kind: "auto" as const };
const version = { ...summary, document: createBlankDocument("取得済みの版") };
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-version-cache-")); directories.push(dir); return dir;
}
it("persists previously fetched versions, scopes them to their source and expires without sliding the deadline", async () => {
  const dir = await directory(); let now = Date.now();
  const cache = new SharedVersionCache(dir, "actor/server/document", () => now);
  await cache.saveList([summary]); await cache.saveBody(version);
  const reopened = new SharedVersionCache(dir, "actor/server/document", () => now);
  expect(await reopened.list()).toEqual([{ ...summary, offline: true }]);
  expect((await reopened.get(summary.id))?.document).toEqual(version.document);
  expect(await new SharedVersionCache(dir, "other/server/document").get(summary.id)).toBeNull();
  now += 7 * 24 * 60 * 60 * 1000;
  expect(await reopened.list()).toBeNull(); expect(await reopened.get(summary.id)).toBeNull();
  await reopened.clear(); await expect(fs.access(cache.filename)).rejects.toThrow();
});
it("rejects invalid data and prunes bodies removed from the latest remote list", async () => {
  const cache = new SharedVersionCache(await directory(), "scope");
  await cache.saveList([summary]); await cache.saveBody(version);
  await expect(cache.saveBody({ ...version, document: null })).rejects.toThrow();
  await expect(cache.saveList([{ ...summary, id: "../../bad" }])).rejects.toThrow();
  await cache.saveList([]); expect(await cache.get(summary.id)).toBeNull();
  await fs.writeFile(cache.filename, "corrupt"); expect(await cache.list()).toBeNull();
});
it("bounds downloaded bodies and keeps the most recently downloaded twenty", async () => {
  const cache = new SharedVersionCache(await directory(), "scope");
  const summaries = Array.from({ length: 21 }, (_, index) => ({ ...summary, id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  await cache.saveList(summaries);
  for (const row of summaries) await cache.saveBody({ ...row, document: version.document });
  expect(await cache.get(summaries[0].id)).toBeNull();
  expect(await cache.get(summaries[20].id)).not.toBeNull();
});

async function sessionsFixture() {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const dir = await directory();
  const sessions = new CollaborationSessions(dir, new LocalSigmaDocStore(dir), vi.fn());
  let actor: string | null = "actor";
  Object.defineProperty(sessions, "auth", { value: { user: () => actor ? { id: actor } : null,
    config: { apiUrl: "https://sync.example.test" }, signOut: async () => { actor = null; },
    accountSignal: () => new AbortController().signal, authorization: async () => "Bearer fixture" } });
  const internal = sessions as unknown as { registry: { files: Record<string, unknown> }; sessions: Map<string, unknown> };
  internal.registry.files.file = { actorId: "actor", sharedDocumentId: "shared" };
  internal.sessions.set("file", { status: "offline", journal: { binding: { sharedDocumentId: "shared" }, pendingCount: () => 0 } });
  return { dir, sessions, setActor: (value: string) => { actor = value; } };
}
it("falls back after real fetch failure, previews without a request and resynchronizes after reconnect", async () => {
  const { sessions } = await sessionsFixture();
  const request = vi.fn(async (url: URL | string) => Response.json(String(url).endsWith("/backups") ? [summary] : version));
  vi.stubGlobal("fetch", request);
  expect(await sessions.backups("file")).toEqual([summary]);
  await sessions.version("file", summary.id);
  request.mockRejectedValue(new TypeError("fetch failed"));
  expect(await sessions.backups("file")).toEqual([{ ...summary, offline: true }]);
  request.mockClear();
  expect(await sessions.version("file", summary.id)).toMatchObject({ document: version.document });
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(Response.json([]));
  expect(await sessions.backups("file")).toEqual([]);
  expect(await sessions.cachedBackups("file")).toEqual([]);
});
it.each([401, 403])("never uses cached history after an explicit %s or account change", async code => {
  const { sessions, setActor } = await sessionsFixture();
  const request = vi.spyOn(sessions, "request").mockResolvedValue([summary]);
  await sessions.backups("file"); request.mockResolvedValue(version); await sessions.version("file", summary.id);
  request.mockRejectedValue(new CollaborationHttpError("FORBIDDEN", code));
  await expect(sessions.backups("file")).rejects.toThrow("FORBIDDEN");
  await expect(sessions.version("file", summary.id)).rejects.toThrow("FORBIDDEN");
  setActor("other"); await expect(sessions.cachedBackups("file")).rejects.toThrow("ACCOUNT_CHANGED");
});
it("rejects a late response after account change and removes history on logout", async () => {
  const { sessions, setActor, dir } = await sessionsFixture();
  const request = vi.spyOn(sessions, "request").mockResolvedValue([summary]);
  await sessions.backups("file");
  request.mockImplementationOnce(async () => { setActor("other"); return [summary]; });
  await expect(sessions.backups("file")).rejects.toThrow("ACCOUNT_CHANGED");
  setActor("actor"); request.mockRejectedValue(new NetworkUnavailableError("offline"));
  await sessions.signOut();
  await expect(fs.access(path.join(dir, "collaboration-v1", "version-cache"))).rejects.toThrow();
  await expect(sessions.cachedBackups("file")).rejects.toThrow("ACCOUNT_CHANGED");
});
