import { describe, expect, it } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../model/shared-document";
import { fromBase64, toBase64 } from "../model/protocol";
import type { ObjectValue } from "../model/value";
import { RendererDocumentSession } from "../renderer/session";
import { BrowserSharedClient } from "./client";
import type { BrowserSharedRecord, SharedBrowserStore } from "./journal";

const id = "00000000-0000-4000-8000-000000000001";
function store() {
  const records = new Map<string, BrowserSharedRecord>();
  return { records, get: async (actor: string, id: string) => structuredClone(records.get(`${actor}/${id}`)),
    put: async (record: BrowserSharedRecord) => { records.set(`${record.actorId}/${record.sharedDocumentId}`, structuredClone(record)); } } satisfies SharedBrowserStore & { records: typeof records };
}
function fixture() {
  const original = createBlankDocument("Shared fixture");
  original.content = [{ id: "paragraph", type: "paragraph", children: [{ type: "text", text: "Original" }] }];
  const server = new SharedDocument();
  server.initialize(JSON.parse(JSON.stringify(original)) as ObjectValue, { sharedDocumentId: id, epoch: 1 });
  let offline = false, role = "editor", seq = 0;
  const acknowledged = new Map<string, number>();
  const request = async <T>(route: string, body?: unknown): Promise<T> => {
    if (offline) throw new Error("offline");
    const input = body as { epoch: number; vector: string; operations: { update: string; operationId: string }[] };
    if (route.endsWith("/snapshot")) return { state: toBase64(server.snapshot()), epoch: server.identity().epoch, role } as T;
    if (route.endsWith("/sync")) return { update: toBase64(server.difference(fromBase64(input.vector))), role, epoch: server.identity().epoch } as T;
    if (route.endsWith("/updates")) {
      if (role === "viewer") throw new Error("READ_ONLY");
      return { acks: input.operations.map(operation => {
        if (!acknowledged.has(operation.operationId)) { server.applyUpdate(fromBase64(operation.update)); acknowledged.set(operation.operationId, ++seq); }
        return { operationId: operation.operationId, seq: acknowledged.get(operation.operationId) };
      }) } as T;
    }
    throw new Error("Unexpected route");
  };
  return { original, server, request, setOffline: (value: boolean) => { offline = value; }, setRole: (value: string) => { role = value; } };
}
function edit(session: RendererDocumentSession, text: string) {
  const before = session.project(), next = structuredClone(before);
  next.content = [{ id: "paragraph", type: "paragraph", children: [{ type: "text", text }] }];
  session.change(before, next);
}

describe("Web connection to the existing shared-document protocol", () => {
  it("sends granular Yjs edits to the same document while preserving an Electron-side change", async () => {
    const remote = fixture(), journal = store();
    const client = new BrowserSharedClient({ actorId: "alice" }, journal, remote.request);
    const info = await client.open(id), renderer = new RendererDocumentSession(info, client.bridge);
    const unsubscribe = client.bridge.onEvent(event => renderer.receive(event));
    const before = remote.server.project(), changed = structuredClone(before);
    (changed.metadata as ObjectValue).title = "Edited by Electron";
    remote.server.change(before, changed);
    edit(renderer, "Edited by Web");
    await renderer.flush(); await client.flush(info.binding.localFileId, true);
    expect(remote.server.project()).toMatchObject({ metadata: { title: "Edited by Electron" }, content: [{ children: [{ text: "Edited by Web" }] }] });
    expect(renderer.project().metadata.title).toBe("Edited by Electron");
    expect(journal.records.get(`alice/${id}`)?.outbox).toEqual([]);
    unsubscribe(); renderer.destroy(); await client.close(); remote.server.destroy();
  });
  it("persists unsent edits across a new browser client and retries with the same operation identity", async () => {
    const remote = fixture(), journal = store();
    let client = new BrowserSharedClient({ actorId: "alice" }, journal, remote.request);
    let info = await client.open(id), renderer = new RendererDocumentSession(info, client.bridge);
    remote.setOffline(true); edit(renderer, "Offline edit"); await renderer.flush();
    const operation = journal.records.get(`alice/${id}`)!.outbox[0].identity.operationId;
    renderer.destroy(); await client.close(); remote.setOffline(false);
    client = new BrowserSharedClient({ actorId: "alice" }, journal, remote.request);
    info = await client.open(id); renderer = new RendererDocumentSession(info, client.bridge);
    expect(renderer.project()).toMatchObject({ content: [{ children: [{ text: "Offline edit" }] }] });
    expect(journal.records.get(`alice/${id}`)!.outbox[0].identity.operationId).toBe(operation);
    await client.flush(info.binding.localFileId, true);
    expect(remote.server.project()).toMatchObject({ content: [{ children: [{ text: "Offline edit" }] }] });
    renderer.destroy(); await client.close(); remote.server.destroy();
  });
  it("keeps viewer sessions read-only and refuses a direct write as well", async () => {
    const remote = fixture(); remote.setRole("viewer");
    const client = new BrowserSharedClient({ actorId: "viewer" }, store(), remote.request);
    const info = await client.open(id), renderer = new RendererDocumentSession(info, client.bridge);
    expect(renderer.writable).toBe(false);
    expect(() => edit(renderer, "Forbidden")).toThrow("READ_ONLY");
    await expect(client.bridge.update(info.binding.localFileId, toBase64(new Uint8Array([0, 0])), crypto.randomUUID(), "manual", 1)).rejects.toThrow("READ_ONLY");
    renderer.destroy(); await client.close(); remote.server.destroy();
  });
  it("never loads another account's local journal", async () => {
    const remote = fixture(), journal = store();
    const alice = new BrowserSharedClient({ actorId: "alice" }, journal, remote.request);
    const info = await alice.open(id), renderer = new RendererDocumentSession(info, alice.bridge);
    remote.setOffline(true); edit(renderer, "Alice private pending edit"); await renderer.flush(); renderer.destroy(); await alice.close();
    remote.setOffline(false);
    const bob = new BrowserSharedClient({ actorId: "bob" }, journal, remote.request);
    const bobInfo = await bob.open(id);
    expect(bob.document(bobInfo)).toMatchObject({ content: [{ children: [{ text: "Original" }] }] });
    expect(journal.records.get(`alice/${id}`)!.outbox).toHaveLength(1);
    await bob.close(); remote.server.destroy();
  });
  it("finishes persisting an accepted edit when the client closes immediately", async () => {
    const remote = fixture(), journal = store();
    const client = new BrowserSharedClient({ actorId: "alice" }, journal, remote.request);
    const info = await client.open(id), draft = new SharedDocument(fromBase64(info.state));
    const before = draft.project(), after = structuredClone(before);
    (after.metadata as ObjectValue).title = "Pending when closing";
    draft.change(before, after);
    remote.setOffline(true);
    const accepted = client.bridge.update(info.binding.localFileId, toBase64(draft.snapshot()), crypto.randomUUID(), "manual", 1);
    const closing = client.close();
    await accepted; await closing;
    const saved = journal.records.get(`alice/${id}`)!;
    expect(saved.outbox).toHaveLength(1);
    const recovered = new SharedDocument(fromBase64(saved.state));
    expect(recovered.project()).toMatchObject({ metadata: { title: "Pending when closing" } });
    recovered.destroy(); draft.destroy(); remote.server.destroy();
  });
});
