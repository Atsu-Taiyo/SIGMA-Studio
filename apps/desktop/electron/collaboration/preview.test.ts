import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { toBase64 } from "@/features/collaboration/model/protocol";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CollaborationSessions } from "./sessions";
vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture() {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-preview-")); directories.push(directory);
  const document = createBlankDocument("shared preview");
  document.pageLayout!.overlay = { overlaySnapshot: { version: 1,
    shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "asset1", w: 64, h: 48 } }],
    assets: { asset1: { id: "asset1", type: "image", props: { w: 64, h: 48, name: "image.png", isAnimated: false, mimeType: "image/png", src: "sigma-doc-storage://asset1", fileSize: 8 } } },
  } };
  const shared = new SharedDocument(); shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const state = toBase64(shared.snapshot()); shared.destroy();
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), vi.fn());
  Object.defineProperty(sessions, "auth", { value: { user: () => ({ id: "actor" }), config: { apiUrl: "https://sync.example.test" }, authorization: async () => "Bearer fixture" } });
  const actor = vi.spyOn(sessions, "actorId").mockReturnValue("actor");
  const request = vi.spyOn(sessions, "request").mockResolvedValue({ state, epoch: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("iVBORw0KGgo=", "base64"), { headers: { "Content-Type": "image/png" } })));
  return { directory, sessions, actor, request, document, state };
}
it("projects an authorized snapshot with images without persisting a body or opening a session", async () => {
  const f = await fixture();
  const open = vi.spyOn(f.sessions, "openCatalogDocument");
  const preview = await f.sessions.previewCatalogDocument("catalog_file", "shared");
  expect(preview.metadata.title).toBe("shared preview");
  expect(JSON.stringify(preview)).toContain("data:image/png;base64,iVBORw0KGgo=");
  expect(f.request).toHaveBeenCalledWith("/documents/shared/snapshot");
  expect(open).not.toHaveBeenCalled(); expect(f.sessions.has("catalog_file")).toBe(false);
  expect(await fs.readdir(f.directory)).toEqual([]);
});
it("does not return previews after permission failure or an account switch", async () => {
  const f = await fixture(); f.request.mockRejectedValueOnce(new Error("FORBIDDEN"));
  await expect(f.sessions.previewCatalogDocument("catalog_file", "shared")).rejects.toThrow("FORBIDDEN");
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockImplementation(async () => { f.actor.mockReturnValue("other"); return new Response(Buffer.from("iVBORw0KGgo=", "base64"), { headers: { "Content-Type": "image/png" } }); });
  await expect(f.sessions.previewCatalogDocument("catalog_file", "shared")).rejects.toThrow("ACCOUNT_CHANGED");
});

it("keeps offline local previews and unuploaded local images without bypassing access denial", async () => {
  const f = await fixture();
  const internal = f.sessions as unknown as { registry: { files: Record<string, unknown> }; sessions: Map<string, unknown> };
  internal.registry.files.file = { actorId: "actor", sharedDocumentId: "shared" };
  internal.sessions.set("file", { status: "saved", journal: { binding: { epoch: 1 }, outbox: () => [] } });
  vi.spyOn(f.sessions, "project").mockReturnValue(f.document);
  const asset = vi.spyOn(f.sessions, "asset").mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
  await f.sessions.previewCatalogDocument("file", "shared");
  expect(asset).toHaveBeenCalledWith("file", "asset1", undefined, false);
  expect(fetch).not.toHaveBeenCalled();
  f.request.mockRejectedValueOnce(new TypeError("fetch failed"));
  expect((await f.sessions.previewCatalogDocument("file", "shared")).metadata.title).toBe("shared preview");
  f.request.mockRejectedValueOnce(new Error("FORBIDDEN"));
  await expect(f.sessions.previewCatalogDocument("file", "shared")).rejects.toThrow("FORBIDDEN");
});

it("combines fresh remote content with pending local edits instead of returning a stale journal", async () => {
  const f = await fixture();
  const local = new SharedDocument(Uint8Array.from(Buffer.from(f.state, "base64")));
  const remote = new SharedDocument(Uint8Array.from(Buffer.from(f.state, "base64")));
  try {
    const before = local.project(); const vector = local.vector();
    const after = structuredClone(before);
    (after.content as ObjectValue[]).push({ type: "paragraph", id: "pending", children: [{ type: "text", text: "unuploaded local text" }] });
    local.change(before, after);
    const remoteBefore = remote.project(); const remoteAfter = structuredClone(remoteBefore);
    (remoteAfter.metadata as ObjectValue).title = "new remote title";
    remote.change(remoteBefore, remoteAfter);
    f.request.mockResolvedValue({ state: toBase64(remote.snapshot()), epoch: 1 });
    const internal = f.sessions as unknown as { registry: { files: Record<string, unknown> }; sessions: Map<string, unknown> };
    internal.registry.files.file = { actorId: "actor", sharedDocumentId: "shared" };
    internal.sessions.set("file", { status: "saved", journal: { binding: { epoch: 1 }, outbox: () => [{ update: toBase64(local.difference(vector)) }] } });
    vi.spyOn(f.sessions, "asset").mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
    const preview = await f.sessions.previewCatalogDocument("file", "shared");
    expect(preview.metadata.title).toBe("new remote title");
    expect(JSON.stringify(preview.content)).toContain("unuploaded local text");
    expect(local.project().metadata).not.toEqual(remote.project().metadata);
  } finally { local.destroy(); remote.destroy(); }
});
