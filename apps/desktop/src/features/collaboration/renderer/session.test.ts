import { afterEach, expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../model/shared-document";
import type { ObjectValue } from "../model/value";
import { toBase64 } from "../model/protocol";
import type { CollaborationBridge } from "../model/bridge";
import { fitPresenceStateToWireBudget, RendererDocumentSession } from "./session";
import { MAX_PRESENCE_MESSAGE_BYTES } from "../model/presence";

const sessions: RendererDocumentSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((session) => session.destroy());
  vi.useRealTimers();
});
const imageSource = "data:image/png;base64,iVBORw0KGgo=";
function addImage(document: ReturnType<typeof createBlankDocument>) {
  document.pageLayout!.overlay = {
    overlaySnapshot: {
      version: 1,
      shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "asset_local", w: 64, h: 48 } }],
      assets: {
        asset_local: {
          id: "asset_local",
          type: "image",
          props: { w: 64, h: 48, name: "paste.png", isAnimated: false, mimeType: "image/png", src: imageSource, fileSize: 8 },
        },
      },
    },
  };
}
function overlaySource(document: ReturnType<RendererDocumentSession["project"]>): string {
  return document.pageLayout?.overlay?.overlaySnapshot?.assets.asset_local?.props.src ?? "";
}

it("keeps pasted pixels visible until the durable asset and journal reference are ready", async () => {
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  let finishAsset!: () => void;
  let finishUpdate!: () => void;
  const assetReady = new Promise<void>((resolve) => { finishAsset = resolve; });
  const updateReady = new Promise<void>((resolve) => { finishUpdate = resolve; });
  const asset = vi.fn(() => assetReady.then(() => imageSource));
  const update = vi.fn(() => updateReady);
  const changed = vi.fn();
  const assetChanged = vi.fn();
  const session = new RendererDocumentSession(
    { binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(shared.snapshot()), role: "editor", status: "saved", actorId: "self", assets: {} },
    { update, asset, flush: vi.fn(async () => {}), presence: vi.fn(async () => {}) } as unknown as CollaborationBridge,
  );
  sessions.push(session);
  session.subscribe(changed);
  session.subscribeAssets(assetChanged);

  const after = structuredClone(session.project());
  addImage(after);
  const visible = session.change(session.project(), after);
  const staleVisible = structuredClone(visible);
  expect(overlaySource(visible)).toMatch(/^sigma-doc-storage:\/\//);
  expect(session.resolveAssetSource(overlaySource(visible))).toBe(imageSource);
  expect(JSON.stringify(session.shared.project())).toMatch(/sigma-doc-storage:\/\//);
  expect(JSON.stringify(session.shared.project())).not.toContain(imageSource);
  expect(asset).toHaveBeenCalledOnce();
  expect(update).not.toHaveBeenCalled();

  finishAsset();
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(session.resolveAssetSource(overlaySource(session.project()))).toBe(imageSource);
  expect(changed).not.toHaveBeenCalled();

  finishUpdate();
  await vi.waitFor(() => expect(assetChanged).toHaveBeenCalledOnce());
  expect(changed).not.toHaveBeenCalled();
  expect(overlaySource(session.project())).toMatch(/^sigma-doc-storage:\/\//);
  expect(session.resolveAssetSource(overlaySource(session.project()))).toBe(overlaySource(session.project()));

  staleVisible.pageLayout!.overlay!.overlaySnapshot!.shapes[0]!.x = 50;
  session.change(session.project(), staleVisible);
  expect(asset).toHaveBeenCalledOnce();
  expect(JSON.stringify(session.shared.project())).not.toContain(imageSource);
  expect(session.restore("undo")).not.toBeNull();
  expect(session.restore("redo")).not.toBeNull();
  const exported = await session.exportDocument();
  expect(overlaySource(exported)).toBe(imageSource);
  expect(asset).toHaveBeenCalledTimes(2);
  shared.destroy();
});

it("does not publish asset readiness after the session is destroyed", async () => {
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  let finishAsset!: () => void;
  const assetReady = new Promise<void>((resolve) => { finishAsset = resolve; });
  const changed = vi.fn();
  const assetChanged = vi.fn();
  const session = new RendererDocumentSession(
    { binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(shared.snapshot()), role: "editor", status: "saved", actorId: "self", assets: {} },
    { update: vi.fn(async () => {}), asset: vi.fn(() => assetReady.then(() => imageSource)), presence: vi.fn(async () => {}) } as unknown as CollaborationBridge,
  );
  session.subscribe(changed);
  session.subscribeAssets(assetChanged);
  const after = structuredClone(session.project());
  addImage(after);
  session.change(session.project(), after);
  session.destroy();
  finishAsset();
  await assetReady;
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
  expect(assetChanged).not.toHaveBeenCalled();
  shared.destroy();
});

it("retries a remotely cached asset without putting its readiness revision in the shared document", async () => {
  const document = createBlankDocument();
  addImage(document);
  document.pageLayout!.overlay!.overlaySnapshot!.assets.asset_local!.props.src = "sigma-doc-storage://asset_remote";
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const asset = vi.fn(async () => imageSource);
  const session = new RendererDocumentSession(
    { binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(shared.snapshot()), role: "editor", status: "offline", actorId: "self", assets: {} },
    { update: vi.fn(async () => {}), asset, flush: vi.fn(async () => {}), presence: vi.fn(async () => {}) } as unknown as CollaborationBridge,
  );
  sessions.push(session);
  const changed = vi.fn();
  const assetChanged = vi.fn();
  session.subscribe(changed);
  session.subscribeAssets(assetChanged);
  expect(overlaySource(session.project())).toBe("sigma-doc-storage://asset_remote");

  session.receive({ type: "asset-ready", fileId: "file", assetId: "asset_remote" });
  expect(changed).not.toHaveBeenCalled();
  expect(assetChanged).toHaveBeenCalledOnce();
  expect(overlaySource(session.project())).toBe("sigma-doc-storage://asset_remote");
  expect(session.resolveAssetSource(overlaySource(session.project()))).toBe("sigma-doc-storage://asset_remote?ready=1");
  expect(JSON.stringify(session.shared.project())).not.toContain("?ready=");

  const moved = structuredClone(session.project());
  moved.pageLayout!.overlay!.overlaySnapshot!.shapes[0]!.x = 80;
  session.change(session.project(), moved);
  expect(JSON.stringify(session.shared.project())).not.toContain("?ready=");
  expect(overlaySource(await session.exportDocument())).toBe(imageSource);
  expect(asset).toHaveBeenCalledWith("file", "asset_remote");
  shared.destroy();
});

it("shows local edits before persistence completes, retains layout references and ignores echoed updates", async () => {
  const document = createBlankDocument();
  document.content = ["p1", "p2"].map(id => ({ id, type: "paragraph", children: [{ type: "text", text: id }] }));
  const peer = new SharedDocument();
  peer.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  let finishSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
  const update = vi.fn(() => pendingSave);
  const commitView = vi.fn((notify: () => void) => notify());
  const session = new RendererDocumentSession({ binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(peer.snapshot()), role: "editor", status: "saved", actorId: "self", assets: {} }, { update, flush: vi.fn(async () => {}), presence: vi.fn(async () => {}) } as unknown as CollaborationBridge, commitView);
  sessions.push(session);
  try {
    const before = session.project();
    const after = structuredClone(before);
    after.content[0] = { id: "p1", type: "paragraph", children: [{ type: "text", text: "Immediate local input" }] };
    const vector = session.shared.vector();
    const visible = session.change(before, after);
    expect(visible.content[0]).toEqual(after.content[0]);
    expect(visible.content[1]).toBe(before.content[1]);
    expect(visible.pageLayout).toBe(before.pageLayout);
    expect(visible.metadata).toBe(before.metadata);
    expect(session.project()).toBe(visible);
    expect(session.status).toBe("local-saving");
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    const changed = vi.fn();
    session.subscribe(changed);
    const echo = { type: "update" as const, fileId: "file", epoch: 1, update: toBase64(session.shared.difference(vector)), identity: { actorId: "self", operationId: "local-operation", kind: "manual" as const } };
    session.receive(echo);
    session.receive(echo);
    for (const status of ["local-saved", "syncing", "saved"] as const)
      session.receive({ type: "status", fileId: "file", status, role: "editor" });
    session.receive({ type: "roster", fileId: "file", ownClientId: "client-self", participants: [] });
    expect(changed).not.toHaveBeenCalled();
    expect(commitView).not.toHaveBeenCalled();
    expect(session.project()).toBe(visible);
    const peerBefore = peer.project();
    const peerAfter = structuredClone(peerBefore);
    (peerAfter.content as ObjectValue[])[1].children = [{ type: "text", text: "Peer input" }];
    const peerVector = peer.vector();
    peer.change(peerBefore, peerAfter);
    session.receive({ ...echo, update: toBase64(peer.difference(peerVector)), identity: { ...echo.identity, actorId: "peer" } });
    expect(changed).toHaveBeenCalledOnce();
    expect(commitView).toHaveBeenCalledOnce();
    expect(session.project().content[0]).toBe(visible.content[0]);
    expect(JSON.stringify(session.project().content[1])).toContain("Peer input");
    expect(session.project().pageLayout).toBe(before.pageLayout);
    finishSave();
    const exported = await session.exportDocument();
    exported.metadata.title = "Export copy";
    expect(session.project().metadata.title).toBe(before.metadata.title);
    session.receive({ type: "status", fileId: "file", status: "saved", role: "viewer" });
    expect(session.writable).toBe(false);
    expect(commitView).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    finishSave();
    peer.destroy();
  }
});
it("selectively reverts a named AI transaction while retaining newer local and peer changes", async () => {
  const document = createBlankDocument();
  document.content = ["p1", "p2", "p3"].map((id) => ({ id, type: "paragraph", children: [{ type: "text", text: id }] }));
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const update = vi.fn(async () => {});
  const session = new RendererDocumentSession({ binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(shared.snapshot()), role: "editor", status: "saved", actorId: "self", assets: {} }, { update, presence: vi.fn(async () => {}) } as unknown as CollaborationBridge);
  sessions.push(session);
  session.receive({ type: "update", fileId: "file", epoch: 2, update: "invalid", identity: { actorId: "peer", operationId: "new-epoch", kind: "manual" } });
  expect(session.shared.identity().epoch).toBe(1);
  const before = shared.project();
  const after = structuredClone(before);
  (after.content as ObjectValue[])[0].children = [{ type: "text", text: "AI" }];
  const vector = shared.vector();
  shared.change(before, after);
  session.receive({ type: "update", fileId: "file", epoch: 1, update: toBase64(shared.difference(vector)), identity: { actorId: "self", operationId: "approval", kind: "ai" }, approvalIds: ["proposal"] });
  const localBefore = session.project();
  const localAfter = structuredClone(localBefore);
  localAfter.metadata.title = "Later manual title";
  session.change(localBefore, localAfter);
  const peerBefore = shared.project();
  const peerAfter = structuredClone(peerBefore);
  (peerAfter.content as ObjectValue[])[1].children = [{ type: "text", text: "Peer" }];
  const peerVector = shared.vector();
  shared.change(peerBefore, peerAfter);
  // Same account, different window: no private ownership metadata means remote.
  session.receive({ type: "update", fileId: "file", epoch: 1, update: toBase64(shared.difference(peerVector)), identity: { actorId: "self", operationId: "other-window-edit", kind: "ai" } });
  expect(await session.restoreOperations(["proposal"])).toBe(true);
  expect(session.project().content[0]).toEqual(document.content[0]);
  expect(JSON.stringify(session.project().content[1])).toContain("Peer");
  expect(session.project().metadata.title).toBe("Later manual title");
  expect(session.restore("undo")?.metadata.title).toBe(document.metadata.title);
  expect(JSON.stringify(session.project().content[1])).toContain("Peer");
  expect(await session.restoreOperations(["proposal"])).toBe(false);
  expect(update).toHaveBeenCalled();
  shared.destroy();
});
it("keeps per-client roster identity separate from actor identity and publishes only while active", async () => {
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const presence = vi.fn(async () => {});
  const session = new RendererDocumentSession(
    { binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(shared.snapshot()), role: "editor", status: "saved", actorId: "actor-self", assets: {} },
    { presence } as unknown as CollaborationBridge,
  );
  sessions.push(session);
  session.setActive(true);
  expect(presence).toHaveBeenCalledWith("file", null);
  session.receive({
    type: "roster",
    fileId: "file",
    ownClientId: "client-a",
    participants: [
      { clientId: "client-a", actorId: "actor-self", role: "editor", profile: { actorId: "actor-self", displayName: "Same Person" }, state: null },
      { clientId: "client-b", actorId: "actor-self", role: "editor", profile: { actorId: "actor-self", displayName: "Same Person" }, state: null },
      { clientId: "client-c", actorId: "actor-viewer", role: "viewer", profile: { actorId: "actor-viewer" }, state: null },
    ],
  });
  expect(session.roster().map((item) => item.clientId)).toEqual(["client-b", "client-c"]);
  session.setActive(false);
  expect(session.roster()).toEqual([]);
  expect(presence).toHaveBeenLastCalledWith("file", null);
  session.receive({
    type: "roster", fileId: "file", ownClientId: "client-a",
    participants: [{ clientId: "late-client", actorId: "late-actor", role: "viewer", profile: { actorId: "late-actor" }, state: null }],
  });
  expect(session.roster()).toEqual([]);
  shared.destroy();
});

it("coalesces overlay previews but sends preview end immediately while preserving selection", async () => {
  vi.useFakeTimers();
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const presence = vi.fn(async () => {});
  const session = new RendererDocumentSession(
    { binding: { protocol: 1, epoch: 1, sharedDocumentId: "shared", docId: document.docId, localFileId: "file" }, state: toBase64(shared.snapshot()), role: "editor", status: "saved", actorId: "same-actor", assets: {} },
    { presence } as unknown as CollaborationBridge,
  );
  sessions.push(session);
  session.setActive(true);
  await Promise.resolve();
  session.setOverlayPresence({
    selectedShapeIds: ["shape-a", "shape-b"],
    preview: {
      kind: "move",
      shapes: [{ id: "shape-a", x: 10, y: 20, w: 30, h: 40 }],
    },
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(presence).toHaveBeenLastCalledWith("file", expect.objectContaining({
    overlay: expect.objectContaining({ preview: expect.objectContaining({ kind: "move" }) }),
  }));

  session.setOverlayPresence({ selectedShapeIds: ["shape-a", "shape-b"] });
  await Promise.resolve();
  expect(presence).toHaveBeenLastCalledWith("file", {
    overlay: { selectedShapeIds: ["shape-a", "shape-b"] },
  });

  session.receive({
    type: "roster",
    fileId: "file",
    ownClientId: "client-self",
    participants: [{
      clientId: "client-other-window",
      actorId: "same-actor",
      role: "editor",
      profile: { actorId: "same-actor", displayName: "同じ利用者", avatarUrl: "https://lh3.googleusercontent.com/a/photo" },
      state: { overlay: { selectedShapeIds: ["shape-a"] } },
    }],
  });
  expect(session.remoteOverlayPresence()).toEqual([expect.objectContaining({
    clientId: "client-other-window",
    actorId: "same-actor",
    displayName: "同じ利用者",
    selectedShapeIds: ["shape-a"],
    avatarSource: expect.stringMatching(/^sigma-collaboration-profile:/),
  })]);
  shared.destroy();
});

it("fits large overlay presence inside the shared wire budget", () => {
  const id = (index: number) => `shape-${index}-${"x".repeat(180)}`;
  const state = fitPresenceStateToWireBudget({
    selection: {
      anchor: "a".repeat(2048),
      head: "b".repeat(2048),
      anchorBlockId: "p1",
      headBlockId: "p1",
    },
    overlay: {
      selectedShapeIds: Array.from({ length: 100 }, (_, index) => id(index)),
      preview: {
        kind: "rotate",
        shapes: Array.from({ length: 100 }, (_, index) => ({
          id: id(index), x: index, y: index, w: 100, h: 80, rotation: 0.5,
          pivot: { x: index + 20, y: index + 30 },
        })),
      },
    },
  });
  expect(new TextEncoder().encode(JSON.stringify({ type: "awareness", state })).byteLength).toBeLessThanOrEqual(MAX_PRESENCE_MESSAGE_BYTES);
  expect(state.selection).toBeDefined();
  expect(state.overlay?.selectedShapeIds.length ?? 0).toBeGreaterThan(0);
});
