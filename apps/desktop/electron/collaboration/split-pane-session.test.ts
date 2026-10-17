import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { CollaborationBridge, CollaborationEvent } from "@/features/collaboration/model/bridge";
import { RendererDocumentSession } from "@/features/collaboration/renderer/session";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CollaborationSessions } from "./sessions";

vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const text = (document: SigmaDocument): string => document.content
  .map((block) => ("children" in block ? (block.children as { text?: string }[]).map((child) => child.text ?? "").join("") : ""))
  .join("\n");

/** The sync server's side of the protocol: one shared document and the operations it received. */
function fixtureServer(original: SigmaDocument) {
  const remote = new SharedDocument();
  remote.initialize(JSON.parse(JSON.stringify(original)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const received: string[] = [];
  let sequence = 0;
  let online = false;
  const request = async (route: string, body?: unknown): Promise<unknown> => {
    if (route === "/documents/shared/snapshot") return { state: toBase64(remote.snapshot()), role: "editor", epoch: 1 };
    if (!online) throw new TypeError("fetch failed");
    const input = body as { vector?: string; operations?: { operationId: string; update: string }[] };
    if (route === "/documents/shared/sync") return { update: toBase64(remote.difference(fromBase64(input.vector!))), role: "editor", epoch: 1, protocol: 1 };
    if (route === "/documents/shared/updates") {
      return { acks: input.operations!.map((operation) => {
        received.push(operation.operationId);
        remote.applyUpdate(fromBase64(operation.update));
        return { operationId: operation.operationId, seq: ++sequence };
      }) };
    }
    throw new Error(`UNEXPECTED_ROUTE ${route}`);
  };
  cleanups.push(async () => remote.destroy());
  return { remote, received, request, goOnline: () => { online = true; } };
}

function connect(directory: string, server: ReturnType<typeof fixtureServer>, emit: (event: CollaborationEvent) => void = () => {}) {
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), emit);
  Object.defineProperty(sessions, "auth", { value: {
    initialize: async () => {}, cancelSignIn: () => {}, user: () => ({ id: "actor" }),
    config: { apiUrl: "https://sync.example.test" }, authorization: async () => "Bearer fixture",
  } });
  vi.spyOn(sessions, "request").mockImplementation((route: string, body?: unknown) => server.request(route, body) as never);
  // The live connection of a visible document; the test decides when it gets through.
  const live = vi.spyOn(sessions as unknown as { connect(fileId: string): Promise<void> }, "connect");
  // Only explicit flushes reach the server; the retry interval stays out of the way.
  vi.spyOn(sessions as unknown as { needsRetry(): boolean }, "needsRetry").mockReturnValue(false);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await sessions.close(); } };
  cleanups.push(close);
  return { sessions, live, close };
}

// A shared document shown in the other pane of a split is registered as visible before it is
// first opened, so its first sync also opens the live connection. Editing must not wait for it.
it("hands a split pane's shared session to the renderer before the first sync and sends its edits once", async () => {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-split-session-"));
  directories.push(directory);
  const original = { ...createBlankDocument("共有教材"), content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "共有の本文" }] }] } as SigmaDocument;
  const edited = { ...original, content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "共有の本文を追記" }] }] } as SigmaDocument;
  const server = fixtureServer(original);
  const events: CollaborationEvent[] = [];
  const first = connect(directory, server, (event) => { events.push(event); });
  let refuse: (error: Error) => void = () => {};
  first.live.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
  cleanups.push(async () => refuse(new Error("TEST_ENDED")));

  await first.sessions.visibleFiles(["file"]);
  // The open returns while the live connection is still pending.
  expect(text(await first.sessions.openCatalogDocument("file", "shared"))).toBe(text(original));
  expect(events).toContainEqual({ type: "reset", fileId: "file" });
  await vi.waitFor(() => expect(first.live).toHaveBeenCalledWith("file"));
  const snapshot = (await first.sessions.info()).sessions.find((item) => item.binding.localFileId === "file")!;
  expect(snapshot.role).toBe("editor");
  // Reopening returns the same session without another announcement.
  events.length = 0;
  expect(text(await first.sessions.openCatalogDocument("file", "shared"))).toBe(text(original));
  expect(events.filter((event) => event.type === "reset")).toEqual([]);

  // Edit through the renderer's session while the first sync waits.
  const bridge = {
    update: (...args: Parameters<CollaborationBridge["update"]>) => first.sessions.update(...args),
    flush: (fileId: string, online?: boolean) => first.sessions.flush(fileId, online),
    asset: async () => { throw new Error("NO_ASSETS"); },
    presence: async () => {},
  } as unknown as CollaborationBridge;
  const renderer = new RendererDocumentSession(snapshot, bridge);
  cleanups.push(async () => renderer.destroy());
  expect(renderer.writable).toBe(true);
  renderer.change(renderer.project(), edited);
  await renderer.flush();
  expect(text(first.sessions.project("file")!)).toBe(text(edited));
  // A whole-document JSON save that differs from the session is still refused: write access
  // is not widened, and the session's own content saves as is.
  const jsonOnly = { ...original, content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "JSONだけの変更" }] }] } as SigmaDocument;
  await expect(first.sessions.boundarySave("file", jsonOnly)).resolves.toEqual({ ok: false, error: "SHARED_SESSION_WRITE_REQUIRED" });
  await expect(first.sessions.boundarySave("file", edited)).resolves.toEqual({ ok: true, revision: 1 });

  // The connection fails for good; the edit waits in the journal across a restart.
  refuse(new Error("WebSocket was closed before the connection was established"));
  await vi.waitFor(async () => expect((await first.sessions.info()).sessions[0].status).toBe("offline"));
  expect(server.received).toEqual([]);
  renderer.destroy();
  await first.close();

  const second = connect(directory, server);
  await second.sessions.initialize();
  expect(text(second.sessions.project("file")!)).toBe(text(edited));
  server.goOnline();
  await second.sessions.flush("file", true);
  expect(text(JSON.parse(JSON.stringify({ content: server.remote.project().content })) as SigmaDocument)).toBe(text(edited));
  expect(server.received).toHaveLength(1);
  // Sent exactly once: further syncs and another restart send nothing again.
  await second.sessions.flush("file", true);
  await second.close();
  const third = connect(directory, server);
  await third.sessions.initialize();
  await third.sessions.flush("file", true);
  expect(server.received).toHaveLength(1);
  expect(text(third.sessions.project("file")!)).toBe(text(edited));
});
