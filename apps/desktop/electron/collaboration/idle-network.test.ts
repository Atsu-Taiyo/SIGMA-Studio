import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { SharedDocumentJournal } from "./journal";
import { CollaborationSessions } from "./sessions";

vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
const instances: CollaborationSessions[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const instance of instances.splice(0)) await instance.close();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function setup(pendingAsset = false) {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-idle-"));
  directories.push(directory);
  const root = path.join(directory, "collaboration-v1");
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  await SharedDocumentJournal.create(path.join(root, "documents", "shared"), {
    sharedDocumentId: "shared", epoch: 1, protocol: 1, localFileId: "file", docId: document.docId,
  }, shared);
  shared.destroy();
  await fs.writeFile(path.join(root, "registry.json"), JSON.stringify({ version: 1, files: {
    file: { sharedDocumentId: "shared", actorId: "actor", role: "editor", operationId: "init", initialized: true },
  } }));
  if (pendingAsset) {
    await fs.mkdir(path.join(root, "assets", "shared"), { recursive: true });
    await fs.writeFile(path.join(root, "assets", "shared", "image.json"), JSON.stringify({ source: "data:image/png;base64,iVBORw0KGgo=", uploaded: false }));
  }
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), () => {});
  Object.defineProperty(sessions, "auth", { value: { initialize: async () => {}, user: () => ({ id: "actor" }), cancelSignIn: () => {} } });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  await sessions.initialize();
  instances.push(sessions);
  const internal = sessions as unknown as { sessions: Map<string, {
    journal: SharedDocumentJournal; viewing: boolean; lastSynchronizedAt: number;
    socket: WebSocket; pendingAssetRevision: number; uploadedAssetRevision: number;
  }> };
  const session = internal.sessions.get("file")!;
  const socket = { readyState: WebSocket.OPEN, send: vi.fn(), ping: vi.fn(), close: vi.fn() };
  session.socket = socket as unknown as WebSocket;
  session.lastSynchronizedAt = Date.now();
  return { sessions, session, socket };
}
it("does not poll healthy idle sockets every five seconds, reconciles once a minute, and synchronizes previously opened sessions in the background", async () => {
  const { sessions, session } = await setup();
  session.viewing = true;
  const flush = vi.spyOn(sessions, "flush").mockImplementation(async () => { session.lastSynchronizedAt = Date.now(); });
  await vi.advanceTimersByTimeAsync(55_000);
  expect(flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(flush).toHaveBeenCalledTimes(1);
  session.viewing = false;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(flush).toHaveBeenCalledTimes(3);
});
it("uses protocol ping for unchanged presence but sends transitions and resends on a new socket", async () => {
  const { sessions, session, socket } = await setup();
  session.viewing = true;
  await sessions.presence("file", null);
  await sessions.presence("file", null);
  expect(socket.send).toHaveBeenCalledTimes(1);
  expect(socket.ping).toHaveBeenCalledTimes(1);
  await sessions.presence("file", { pageId: "next-page" });
  expect(socket.send).toHaveBeenCalledTimes(2);
  const replacement = { ...socket, send: vi.fn(), ping: vi.fn() };
  session.socket = replacement as unknown as WebSocket;
  await sessions.presence("file", { pageId: "next-page" });
  expect(replacement.send).toHaveBeenCalledTimes(1);
  expect(replacement.ping).not.toHaveBeenCalled();
});
it("retries a disconnected visible session and durable uploads even when the document is hidden", async () => {
  const { sessions, session } = await setup(true);
  session.viewing = false;
  const flush = vi.spyOn(sessions, "flush").mockImplementation(async () => {
    session.uploadedAssetRevision = session.pendingAssetRevision;
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(flush).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(flush).toHaveBeenCalledTimes(1);
  session.viewing = true;
  session.socket = { readyState: WebSocket.CLOSED, close: vi.fn() } as unknown as WebSocket;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(flush).toHaveBeenCalledTimes(2);
});
it("retries hidden durable outbox operations until acknowledged", async () => {
  const { sessions, session } = await setup();
  const before = session.journal.document.project();
  const after = structuredClone(before);
  (after.metadata as ObjectValue).title = "offline edit";
  const remote = new SharedDocument(session.journal.document.snapshot());
  const vector = remote.vector();
  remote.change(before, after);
  const identity = { operationId: crypto.randomUUID(), actorId: "actor", kind: "manual" as const };
  await session.journal.append(remote.difference(vector), identity, true);
  remote.destroy();
  const request = vi.spyOn(sessions, "request").mockRejectedValueOnce(new Error("OFFLINE")).mockImplementation(async (route) => {
    if (route.endsWith("/sync")) return { update: "AAA=", role: "editor" };
    return { acks: [{ operationId: identity.operationId, seq: 1 }] };
  });
  const flush = vi.spyOn(sessions, "flush");
  await vi.advanceTimersByTimeAsync(5_000);
  await flush.mock.results.at(-1)?.value.catch(() => {});
  expect(session.journal.outbox()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  await flush.mock.results.at(-1)?.value;
  expect(session.journal.outbox()).toHaveLength(0);
  expect(request.mock.calls.map(([route]) => route)).toEqual(["/documents/shared/sync", "/documents/shared/sync", "/documents/shared/updates"]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(flush).toHaveBeenCalledTimes(2);
});
it("retains only mounted detached previews and closes their socket on release", async () => {
  const { sessions, session, socket } = await setup();
  const flush = vi.spyOn(sessions, "flush").mockImplementation(async () => { session.lastSynchronizedAt = Date.now(); });
  await sessions.visibleFiles(["file"]);
  expect(session.viewing).toBe(true);
  expect(flush).toHaveBeenCalledWith("file", true);
  await sessions.view(null);
  expect(session.viewing).toBe(true);
  expect(socket.close).not.toHaveBeenCalled();
  await sessions.visibleFiles([]);
  expect(session.viewing).toBe(false);
  expect(socket.close).toHaveBeenCalledWith(1000, "VIEW_CHANGED");
  flush.mockClear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(flush).toHaveBeenCalledTimes(2);
});
