import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import { toBase64 } from "../../src/features/collaboration/model/protocol";
import type { CollaborationEvent } from "../../src/features/collaboration/model/bridge";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { SharedDocumentJournal } from "./journal";
import { CollaborationSessions } from "./sessions";

// 起動時に共有教材の journal を全部復号していた (415件で約2.5秒、画面側でも全件を復号)。
// 送信待ちの無い教材は初めて使うときに開く。送信待ちがあり得る教材だけは起動時に開いて再送する。
vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
const instances: CollaborationSessions[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) await instance.close();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

interface Fixture {
  name: string;
  actorId?: string;
  initialized?: boolean;
  /** An edit written locally and not yet acknowledged by the server. */
  pending?: boolean;
  unuploadedAsset?: boolean;
}

async function setup(fixtures: Fixture[]) {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-lazy-"));
  directories.push(directory);
  const root = path.join(directory, "collaboration-v1");
  const files: Record<string, unknown> = {};
  const operations = new Map<string, string>();
  for (const fixture of fixtures) {
    const document = createBlankDocument(`title-${fixture.name}`);
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: `shared-${fixture.name}`, epoch: 1 });
    const journal = await SharedDocumentJournal.create(path.join(root, "documents", `shared-${fixture.name}`), {
      sharedDocumentId: `shared-${fixture.name}`, epoch: 1, protocol: 1, localFileId: `file-${fixture.name}`, docId: document.docId,
    }, shared);
    if (fixture.pending) {
      const renderer = new SharedDocument(shared.snapshot());
      const before = renderer.project();
      renderer.change(before, { ...before, metadata: { ...(before.metadata as ObjectValue), title: `offline-${fixture.name}` } });
      const operationId = crypto.randomUUID();
      operations.set(fixture.name, operationId);
      await journal.append(renderer.difference(shared.vector()), { operationId, actorId: fixture.actorId ?? "actor", kind: "manual" }, true);
      renderer.destroy();
    }
    journal.document.destroy();
    if (fixture.unuploadedAsset) {
      await fs.mkdir(path.join(root, "assets", `shared-${fixture.name}`), { recursive: true });
      await fs.writeFile(path.join(root, "assets", `shared-${fixture.name}`, "image.json"), JSON.stringify({ source: "data:image/png;base64,iVBORw0KGgo=", uploaded: false }));
    }
    files[`file-${fixture.name}`] = {
      sharedDocumentId: `shared-${fixture.name}`, actorId: fixture.actorId ?? "actor", role: "editor",
      operationId: crypto.randomUUID(), initialized: fixture.initialized ?? true,
    };
  }
  await fs.writeFile(path.join(root, "registry.json"), JSON.stringify({ version: 1, files }));
  const events: CollaborationEvent[] = [];
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), (event) => { events.push(event); });
  Object.defineProperty(sessions, "auth", { value: { initialize: async () => {}, user: () => ({ id: "actor" }), cancelSignIn: () => {} } });
  instances.push(sessions);
  const open = vi.spyOn(SharedDocumentJournal, "open");
  const internal = sessions as unknown as { sessions: Map<string, { journal: SharedDocumentJournal; status: string; role: string; viewing?: boolean }> };
  return { sessions, events, open, internal, operations, root };
}

it("keeps clean journals closed at startup and opens each once, announced, on first use", async () => {
  const { sessions, events, open, internal } = await setup([{ name: "a" }, { name: "b" }]);
  await sessions.initialize();
  expect(open).not.toHaveBeenCalled();
  const info = await sessions.info();
  expect(info.sessions).toEqual([]);
  // Still shared: the renderer must not edit these as plain JSON before their sessions arrive.
  expect(info.restrictedFileIds.sort()).toEqual(["file-a", "file-b"]);
  expect(sessions.bindings().map((binding) => binding.docId)).toEqual([expect.any(String), expect.any(String)]);
  expect(() => sessions.project("file-a")).toThrow("SHARED_SESSION_UNAVAILABLE");

  const [first, second] = await Promise.all([sessions.read("file-a"), sessions.read("file-a"), sessions.flush("file-a")]);
  expect(first?.metadata.title).toBe("title-a");
  expect(second?.metadata.title).toBe("title-a");
  expect(open).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type === "reset")).toEqual([{ type: "reset", fileId: "file-a" }]);
  expect((await sessions.info()).sessions.map((session) => session.binding.localFileId)).toEqual(["file-a"]);
  expect(internal.sessions.has("file-b")).toBe(false);
});

it("opens journals that may hold unsent work at startup and sends the outbox once", async () => {
  const { sessions, open, internal, operations } = await setup([
    { name: "clean" }, { name: "edited", pending: true }, { name: "image", unuploadedAsset: true }, { name: "new", initialized: false },
  ]);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  await sessions.initialize();
  expect([...internal.sessions.keys()].sort()).toEqual(["file-edited", "file-image", "file-new"]);
  expect(open).toHaveBeenCalledTimes(3);
  const edited = internal.sessions.get("file-edited")!;
  expect(edited.journal.outbox()).toHaveLength(1);

  const routes: string[] = [];
  vi.spyOn(sessions, "request").mockImplementation(async (route) => {
    routes.push(route);
    if (route.endsWith("/sync")) return { update: "AAA=", role: "editor" } as never;
    if (route.endsWith("/initialize")) return {} as never;
    return { acks: [{ operationId: operations.get("edited")!, seq: 1 }] } as never;
  });
  vi.spyOn(sessions as unknown as { uploadCachedAssets(fileId: string): Promise<void> }, "uploadCachedAssets").mockResolvedValue();
  const flush = vi.spyOn(sessions, "flush");
  await vi.advanceTimersByTimeAsync(5_000);
  await Promise.all(flush.mock.results.map((result) => result.value.catch(() => {})));
  expect(edited.journal.outbox()).toHaveLength(0);
  expect(routes.filter((route) => route === "/documents/shared-edited/updates")).toHaveLength(1);
  expect(flush.mock.calls.map(([fileId]) => fileId)).not.toContain("file-clean");

  // Later use of the same file reuses that session: the outbox is never replayed from a second copy.
  await sessions.read("file-edited");
  expect(internal.sessions.get("file-edited")).toBe(edited);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(routes.filter((route) => route === "/documents/shared-edited/updates")).toHaveLength(1);
  expect(internal.sessions.has("file-clean")).toBe(false);
});

it("opens and synchronizes a closed file once it is viewed, but not another account's file", async () => {
  const { sessions, events, internal } = await setup([{ name: "a" }, { name: "b" }, { name: "other", actorId: "someone-else" }]);
  await sessions.initialize();
  const flush = vi.spyOn(sessions, "flush").mockResolvedValue();
  await sessions.view("file-a");
  expect(internal.sessions.get("file-a")?.viewing).toBe(true);
  expect(flush).toHaveBeenCalledWith("file-a", true);
  await sessions.visibleFiles(["file-b"]);
  expect(internal.sessions.get("file-b")?.viewing).toBe(true);
  expect(flush).toHaveBeenCalledWith("file-b", true);
  await sessions.view("file-other");
  expect(internal.sessions.has("file-other")).toBe(false);
  expect(events.filter((event) => event.type === "reset").map((event) => event.fileId).sort()).toEqual(["file-a", "file-b"]);
});

it("previews a closed file offline from its stored journal without attaching a session", async () => {
  const { sessions, events, open, internal } = await setup([{ name: "a" }]);
  await sessions.initialize();
  vi.spyOn(sessions, "request").mockRejectedValue(new TypeError("fetch failed"));
  const preview = await sessions.previewCatalogDocument("file-a", "shared-a", { assets: false });
  expect(preview.metadata.title).toBe("title-a");
  expect(open).toHaveBeenCalledTimes(1);
  expect(internal.sessions.has("file-a")).toBe(false);
  expect(events).toEqual([]);
  // The shared catalog no longer grants it: the stored copy is not shown either.
  sessions.restrictCatalog(new Map());
  await expect(sessions.previewCatalogDocument("file-a", "shared-a", { assets: false })).rejects.toThrow("fetch failed");
});

it("applies the latest catalog permissions to a session opened later", async () => {
  const { sessions } = await setup([{ name: "a" }, { name: "b" }]);
  await sessions.initialize();
  sessions.restrictCatalog(new Map([["shared-b", "viewer"]]));
  vi.spyOn(sessions, "flush").mockResolvedValue();
  await expect(sessions.openCatalogDocument("file-a", "shared-a")).rejects.toThrow("READ_ONLY");
  await sessions.openCatalogDocument("file-b", "shared-b");
  expect(sessions.describe("file-b")).toMatchObject({ role: "viewer", status: "offline" });
});

it("includes edits made when a dormant session opens while its preview snapshot is in flight", async () => {
  const { sessions, internal } = await setup([{ name: "a" }]);
  await sessions.initialize();
  let returnSnapshot!: (value: never) => void;
  vi.spyOn(sessions, "request").mockImplementation(() => new Promise((resolve) => { returnSnapshot = resolve; }));
  const preview = sessions.previewCatalogDocument("file-a", "shared-a", { assets: false });
  await sessions.read("file-a");
  const journal = internal.sessions.get("file-a")!.journal;
  const oldSnapshot = journal.document.snapshot();
  const edited = new SharedDocument(oldSnapshot);
  const before = edited.project();
  edited.change(before, { ...before, metadata: { ...(before.metadata as ObjectValue), title: "edited while preview waited" } });
  await journal.append(edited.difference(journal.document.vector()), { operationId: crypto.randomUUID(), actorId: "actor", kind: "manual" }, true);
  edited.destroy();
  returnSnapshot({ state: toBase64(oldSnapshot), epoch: 1 } as never);
  expect((await preview).metadata.title).toBe("edited while preview waited");
  expect(journal.outbox()).toHaveLength(1);
  expect(sessions.project("file-a")?.metadata.title).toBe("edited while preview waited");
});
