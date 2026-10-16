import { expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import type { CollaborationBridge, SessionInfo } from "../model/bridge";
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
  expect(info).toHaveBeenCalledTimes(2);
});

it("does not reactivate a restricted file for a different account", async () => {
  const infoValue = { configured: true, user: { actorId: "other" }, sessions: [], restrictedFileIds: ["file"] };
  const info = vi.fn(async () => infoValue);
  const view = vi.fn(async () => {});

  await expect(readCollaborationInfo({ info, view } as unknown as CollaborationBridge, "file")).resolves.toBe(infoValue);
  expect(view).not.toHaveBeenCalled();
});

it("hands over the first read before reasserting the viewed file over the network", async () => {
  // A just-opened shared file must not wait for the viewed file's sync to get its session.
  const opened = snapshot("opened");
  const first = { configured: true, user: { actorId: "actor" }, sessions: [snapshot("file"), opened], restrictedFileIds: ["file", "opened"] };
  const info = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first);
  let finishView!: () => void;
  const view = vi.fn(() => new Promise<void>((resolve) => { finishView = resolve; }));
  const beforeView = vi.fn();
  const reading = readCollaborationInfo({ info, view } as unknown as CollaborationBridge, "file", beforeView);
  await vi.waitFor(() => expect(view).toHaveBeenCalledWith("file"));
  expect(beforeView).toHaveBeenCalledExactlyOnceWith(first);
  finishView();
  await expect(reading).resolves.toBe(first);

  const local = vi.fn();
  await readCollaborationInfo({ info: vi.fn(async () => first), view } as unknown as CollaborationBridge, "local", local);
  expect(local).not.toHaveBeenCalled();
});
