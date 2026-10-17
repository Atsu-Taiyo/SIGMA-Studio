import { expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import type { CollaborationBridge, CollaborationInfo, SessionInfo } from "../model/bridge";
import { SharedDocument } from "../model/shared-document";
import { toBase64 } from "../model/protocol";
import type { ObjectValue } from "../model/value";
import { readCollaborationInfo, reconcileRendererSessions } from "./DesktopEditor";
import type { RendererDocumentSession } from "./session";

function snapshot(fileId: string): SessionInfo {
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const result: SessionInfo = {
    binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: fileId },
    state: toBase64(shared.snapshot()), role: "editor", status: "saved", actorId: "actor", assets: {},
  };
  shared.destroy();
  return result;
}

it("activates a newly created session for an already-visible file and removes sessions absent after logout", () => {
  const sessions = new Map<string, RendererDocumentSession>();
  const presence = vi.fn(async () => {});
  const bridge = { presence } as unknown as CollaborationBridge;
  reconcileRendererSessions(sessions, [snapshot("file")], bridge, "file", (notify) => notify());
  expect(sessions.get("file")?.roster()).toEqual([]);
  expect(presence).toHaveBeenCalledWith("file", null);
  reconcileRendererSessions(sessions, [], bridge, "file", (notify) => notify());
  expect(sessions.size).toBe(0);
});

it("reasserts the visible file after the same account signs in again", async () => {
  const session = snapshot("file");
  const info = vi.fn()
    .mockResolvedValueOnce({ configured: true, user: { actorId: "actor" }, sessions: [session], restrictedFileIds: ["file"] })
    .mockResolvedValueOnce({ configured: true, user: { actorId: "actor" }, sessions: [session], restrictedFileIds: ["file"] });
  const view = vi.fn(async () => {});
  const bridge = { info, view } as unknown as CollaborationBridge;

  await expect(readCollaborationInfo(bridge, "file")).resolves.toMatchObject({ sessions: [session] });
  expect(view).toHaveBeenCalledExactlyOnceWith("file");
  expect(info).toHaveBeenCalledTimes(1);
});

it("does not reactivate a restricted file for a different account", async () => {
  const infoValue = { configured: true, user: { actorId: "other" }, sessions: [], restrictedFileIds: ["file"] };
  const info = vi.fn(async () => infoValue);
  const view = vi.fn(async () => {});

  await expect(readCollaborationInfo({ info, view } as unknown as CollaborationBridge, "file")).resolves.toBe(infoValue);
  expect(view).not.toHaveBeenCalled();
});

it("announces a newly opened session while another file's view is still waiting", async () => {
  const a = snapshot("file-a");
  const b = snapshot("file-b");
  const first = { configured: true, user: null, sessions: [a], restrictedFileIds: ["file-a"] };
  const second = { ...first, sessions: [a, b], restrictedFileIds: ["file-a", "file-b"] };
  const info = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  let finishView!: () => void;
  const view = vi.fn(() => new Promise<void>((resolve) => { finishView = resolve; }));
  const afterView = vi.fn();
  const bridge = { info, view } as unknown as CollaborationBridge;
  const sessions = new Map<string, RendererDocumentSession>();
  const apply = (value: CollaborationInfo) => reconcileRendererSessions(sessions, value.sessions, bridge, null, (notify) => notify());
  // These reads are serialized exactly like reset events in DesktopEditor. The second
  // read must attach B before the outstanding sync for A completes.
  const firstRead = readCollaborationInfo(bridge, "file-a", afterView).then(apply);
  const nextRead = firstRead.then(() => readCollaborationInfo(bridge, null)).then(apply);
  await nextRead;
  expect(sessions.has("file-b")).toBe(true);
  expect(afterView).not.toHaveBeenCalled();
  finishView();
  await Promise.resolve();
  expect(afterView).toHaveBeenCalledOnce();
  reconcileRendererSessions(sessions, [], bridge, null);
});

it("keeps the session available if reasserting its view fails", async () => {
  const value = { configured: true, user: null, sessions: [snapshot("file")], restrictedFileIds: ["file"] };
  const afterView = vi.fn();
  const bridge = { info: vi.fn(async () => value), view: vi.fn(async () => { throw new Error("OFFLINE"); }) } as unknown as CollaborationBridge;
  await expect(readCollaborationInfo(bridge, "file", afterView)).resolves.toBe(value);
  await Promise.resolve();
  expect(afterView).not.toHaveBeenCalled();
});
