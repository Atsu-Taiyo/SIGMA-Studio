import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { toBase64 } from "@/features/collaboration/model/protocol";
import type { CollaborationBridge, CollaborationEvent } from "@/features/collaboration/model/bridge";
import { RendererDocumentSession } from "@/features/collaboration/renderer/session";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CollaborationSessions } from "./sessions";

vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function withAuth(sessions: CollaborationSessions): CollaborationSessions {
  Object.defineProperty(sessions, "auth", { value: {
    initialize: async () => {}, cancelSignIn: () => {}, user: () => ({ id: "actor" }),
    config: { apiUrl: "https://sync.example.test" }, authorization: async () => "Bearer fixture",
  } });
  let closed = false;
  closers.push(async () => { if (!closed) await sessions.close(); });
  const close = sessions.close.bind(sessions);
  sessions.close = async () => { closed = true; await close(); };
  return sessions;
}

const text = (document: SigmaDocument): string => document.content
  .map((block) => ("children" in block ? (block.children as { text?: string }[]).map((child) => child.text ?? "").join("") : ""))
  .join("\n");

// A document in a passive pane of a split workspace is registered as visible before it is
// opened, so its first sync also opens the live connection. When that fails (the pane's
// visibility is re-registered, the socket is refused...), the session already owns the file.
it("announces a shared session whose first sync failed in a split pane, so edits save through it", async () => {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-split-session-"));
  directories.push(directory);
  const original = { ...createBlankDocument("共有教材"), content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "共有の本文" }] }] } as SigmaDocument;
  const remote = new SharedDocument();
  remote.initialize(JSON.parse(JSON.stringify(original)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const state = toBase64(remote.snapshot());
  remote.destroy();

  const events: CollaborationEvent[] = [];
  const sessions = withAuth(new CollaborationSessions(directory, new LocalSigmaDocStore(directory), (event) => { events.push(event); }));
  vi.spyOn(sessions, "request").mockResolvedValue({ state, role: "editor", epoch: 1 });
  const connect = vi.spyOn(sessions as unknown as { connect(fileId: string): Promise<void> }, "connect")
    .mockRejectedValue(new Error("WebSocket was closed before the connection was established"));

  await sessions.visibleFiles(["file"]);
  await expect(sessions.openCatalogDocument("file", "shared")).rejects.toThrow("WebSocket was closed");
  expect(connect).toHaveBeenCalledWith("file");
  // The renderer rereads its sessions on this event; without it, it kept a JSON copy.
  expect(events).toContainEqual({ type: "reset", fileId: "file" });
  const info = await sessions.info();
  expect(info.restrictedFileIds).toContain("file");
  const snapshot = info.sessions.find((item) => item.binding.localFileId === "file")!;
  expect(snapshot.role).toBe("editor");
  // Reopening returns the same session without another announcement.
  events.length = 0;
  expect(text(await sessions.openCatalogDocument("file", "shared"))).toBe(text(original));
  expect(events).toEqual([]);

  const edited = { ...original, content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "共有の本文を追記" }] }] } as SigmaDocument;
  // A whole-document JSON save is still refused: write access is not widened.
  await expect(sessions.boundarySave("file", edited)).resolves.toEqual({ ok: false, error: "SHARED_SESSION_WRITE_REQUIRED" });

  const bridge = {
    update: (...args: Parameters<CollaborationBridge["update"]>) => sessions.update(...args),
    flush: (fileId: string, online?: boolean) => sessions.flush(fileId, online),
    asset: async () => { throw new Error("NO_ASSETS"); },
    presence: async () => {},
  } as unknown as CollaborationBridge;
  const renderer = new RendererDocumentSession(snapshot, bridge);
  expect(renderer.writable).toBe(true);
  renderer.change(renderer.project(), edited);
  await renderer.flush();
  expect(text(sessions.project("file")!)).toBe(text(edited));
  await expect(sessions.boundarySave("file", sessions.project("file")!)).resolves.toEqual({ ok: true, revision: 1 });

  // The edit is durable and still queued for upload after a restart.
  renderer.destroy();
  await sessions.close();
  const restarted = withAuth(new CollaborationSessions(directory, new LocalSigmaDocStore(directory), () => {}));
  vi.spyOn(restarted as unknown as { needsRetry(): boolean }, "needsRetry").mockReturnValue(false);
  await restarted.initialize();
  expect(text(restarted.project("file")!)).toBe(text(edited));
  const internal = restarted as unknown as { sessions: Map<string, { journal: { outbox(): unknown[] } }> };
  expect(internal.sessions.get("file")!.journal.outbox().length).toBeGreaterThan(0);
});
