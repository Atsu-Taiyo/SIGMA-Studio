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
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture(remoteImage = false) {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-recovery-")); directories.push(directory);
  const document = createBlankDocument("recover me");
  if (remoteImage) document.pageLayout!.overlay = { overlaySnapshot: { version: 1,
    shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "asset1", w: 64, h: 48 } }],
    assets: { asset1: { id: "asset1", type: "image", props: { w: 64, h: 48, name: "image.png", isAnimated: false, mimeType: "image/png", src: "sigma-doc-storage://asset1", fileSize: 8 } } },
  } };
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const state = toBase64(shared.snapshot()); shared.destroy();
  const local = new LocalSigmaDocStore(directory);
  const server = { locked: true, failDelete: false };
  const recovered = async () => (await local.listFiles()).filter(f => f.docId.startsWith("doc_recovered_"));
  const connect = () => {
    const sessions = new CollaborationSessions(directory, local, vi.fn());
    const actor = vi.spyOn(sessions, "actorId").mockReturnValue("actor");
    const request = vi.spyOn(sessions, "request").mockImplementation(async <T>(route: string): Promise<T> => {
      if (route === "/billing/locked") return (server.locked ? [{ id: "shared", title: "recover me" }] : []) as T;
      if (route === "/documents/shared/recovery") return { state } as T;
      if (route === "/documents/shared/delete") {
        const files = await recovered(); expect(files).toHaveLength(1);
        expect((await local.loadDocument(files[0].fileId))?.metadata.title).toBe("recover me");
        if (server.failDelete) throw new Error("NETWORK_ERROR");
        server.locked = false; return {} as T;
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    return { sessions, actor, request };
  };
  return { ...connect(), connect, local, server, recovered };
}
it("deletes online only after local readback, and repeated recovery creates no extra files", async () => {
  const f = await fixture();
  expect(await f.sessions.recoverLocked()).toEqual({ saved: 1, failed: 0 });
  expect(f.server.locked).toBe(false);
  expect(await f.sessions.recoverLocked()).toEqual({ saved: 0, failed: 0 });
  expect(await f.recovered()).toHaveLength(1);
});
it("reuses the verified copy when retrying a failed deletion after recreating the session", async () => {
  const f = await fixture(); f.server.failDelete = true;
  expect(await f.sessions.recoverLocked()).toEqual({ saved: 0, failed: 1 });
  expect(f.server.locked).toBe(true); expect(await f.recovered()).toHaveLength(1);
  f.server.failDelete = false;
  expect(await f.connect().sessions.recoverLocked()).toEqual({ saved: 1, failed: 0 });
  expect(await f.recovered()).toHaveLength(1);
});
it.each(["save", "readback"])("keeps online documents when local %s fails", async failure => {
  const f = await fixture();
  if (failure === "save") vi.spyOn(f.local, "createFileFromDocument").mockRejectedValue(new Error("DISK_FULL"));
  else vi.spyOn(f.local, "loadDocument").mockResolvedValue(null);
  expect(await f.sessions.recoverLocked()).toEqual({ saved: 0, failed: 1 });
  expect(f.server.locked).toBe(true);
  expect(f.request).not.toHaveBeenCalledWith("/documents/shared/delete", {});
});
it("does not delete under a different account after saving", async () => {
  const f = await fixture(); const original = f.local.createFileFromDocument.bind(f.local);
  vi.spyOn(f.local, "createFileFromDocument").mockImplementation(async input => { const result = await original(input); f.actor.mockReturnValue("other"); return result; });
  await expect(f.sessions.recoverLocked()).rejects.toThrow("ACCOUNT_CHANGED");
  expect(f.server.locked).toBe(true);
  expect(f.request).not.toHaveBeenCalledWith("/documents/shared/delete", {});
});

it("keeps online documents when an image cannot be downloaded", async () => {
  const f = await fixture(true);
  vi.spyOn(f.sessions as unknown as { requestRaw(route: string): Promise<Response> }, "requestRaw").mockRejectedValue(new Error("ASSET_UNAVAILABLE"));
  expect(await f.sessions.recoverLocked()).toEqual({ saved: 0, failed: 1 });
  expect(await f.recovered()).toHaveLength(0);
  expect(f.request).not.toHaveBeenCalledWith("/documents/shared/delete", {});
});
it("serializes simultaneous recovery requests", async () => {
  const f = await fixture();
  expect(await Promise.all([f.sessions.recoverLocked(), f.sessions.recoverLocked()])).toEqual([{ saved: 1, failed: 0 }, { saved: 0, failed: 0 }]);
  expect(await f.recovered()).toHaveLength(1);
});
