import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { fromBase64, toBase64 } from "@/features/collaboration/model/protocol";
import type { CollaborationBridge } from "@/features/collaboration/model/bridge";
import { RendererDocumentSession } from "@/features/collaboration/renderer/session";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { CollaborationSessions } from "./sessions";
import { CollaborationHttpError } from "./transport";

vi.mock("electron", () => ({ safeStorage: {} }));
const cleanups: (() => Promise<void>)[] = [];
const source = "data:image/png;base64,iVBORw0KGgo=";
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Synthetic protocol fixture: validate each operation, including intermediate images, before commit. */
async function fixture() {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-asset-sync-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const remote = new SharedDocument();
  remote.initialize(JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  cleanups.push(async () => remote.destroy());
  const assets = new Set<string>();
  const receipts = new Map<string, number>();
  const batches: { operationId: string; update: string }[][] = [];
  const uploads: string[] = [];
  let beforeSync: (() => Promise<void>) | undefined;
  let rejection: CollaborationHttpError | undefined;
  let uploadFailure: Error | undefined;
  const request = async (route: string, body?: unknown): Promise<unknown> => {
    if (route.endsWith("/snapshot")) return { state: toBase64(remote.snapshot()), role: "editor", epoch: 1 };
    const input = body as { vector: string; operations: { operationId: string; update: string }[] };
    if (route.endsWith("/sync")) {
      await beforeSync?.();
      return { update: toBase64(remote.difference(fromBase64(input.vector))), role: "editor", epoch: 1, protocol: 1 };
    }
    if (route.endsWith("/updates")) {
      batches.push(structuredClone(input.operations));
      if (rejection) throw rejection;
      return { acks: input.operations.map(operation => {
        let seq = receipts.get(operation.operationId);
        if (seq === undefined) {
          const candidate = remote.prepareUpdate(fromBase64(operation.update), value => {
            parseSigmaDocument(value);
            const visit = (node: unknown): void => {
              if (!node || typeof node !== "object") return;
              const src = (node as { src?: unknown }).src;
              if (typeof src === "string") {
                const match = /^sigma-doc-storage:\/\/([A-Za-z0-9_-]{1,180})$/.exec(src);
                if (!match || !assets.has(match[1])) throw new CollaborationHttpError("MISSING_ASSET", 400);
              }
              Object.values(node).forEach(visit);
            };
            visit(value);
          });
          candidate.destroy();
          remote.applyUpdate(fromBase64(operation.update));
          seq = receipts.size + 1;
          receipts.set(operation.operationId, seq);
        }
        return { operationId: operation.operationId, seq };
      }) };
    }
    throw new Error("UNEXPECTED_ROUTE");
  };
  const connect = async () => {
    const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), () => {});
    Object.defineProperty(sessions, "auth", { value: {
      initialize: async () => {}, cancelSignIn: () => {}, user: () => ({ id: "actor" }),
      config: { apiUrl: "https://sync.example.test" }, authorization: async () => "Bearer fixture",
    } });
    vi.spyOn(sessions, "request").mockImplementation((route, body) => request(route, body) as never);
    vi.spyOn(sessions as unknown as { requestRaw(route: string, options?: RequestInit): Promise<Response> }, "requestRaw")
      .mockImplementation(async (route, options) => {
        expect(options?.method).toBe("PUT");
        const id = route.split("/").at(-1)!;
        uploads.push(id);
        if (uploadFailure) throw uploadFailure;
        assets.add(id);
        return new Response(null, { status: 204 });
      });
    vi.spyOn(sessions as unknown as { backgroundFlush(): Promise<void> }, "backgroundFlush").mockResolvedValue();
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await sessions.close(); } };
    cleanups.push(close);
    await sessions.initialize();
    await sessions.openCatalogDocument("file", "shared");
    const bridge = {
      update: (...args: Parameters<CollaborationBridge["update"]>) => sessions.update(...args),
      asset: (...args: Parameters<CollaborationBridge["asset"]>) => sessions.asset(...args),
      flush: (...args: Parameters<CollaborationBridge["flush"]>) => sessions.flush(...args),
      presence: async () => {},
    } as unknown as CollaborationBridge;
    const renderer = new RendererDocumentSession(sessions.describe("file"), bridge);
    cleanups.push(async () => renderer.destroy());
    return { sessions, renderer, close };
  };
  return {
    directory, remote, assets, receipts, batches, uploads, connect,
    onSync: (run: () => Promise<void>) => { beforeSync = run; },
    reject: (error: CollaborationHttpError) => { rejection = error; },
    failUpload: (error: Error | undefined) => { uploadFailure = error; },
  };
}

function addImage(renderer: RendererDocumentSession) {
  const before = renderer.project();
  const after = structuredClone(before);
  after.pageLayout!.overlay = { overlaySnapshot: {
    version: 1,
    shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "image_asset", w: 64, h: 48 } }],
    assets: { image_asset: { id: "image_asset", type: "image", props: {
      w: 64, h: 48, name: "fixture.png", isAnimated: false, mimeType: "image/png", src: source, fileSize: 8,
    } } },
  } };
  renderer.change(before, after);
}

it("uploads an image added while /sync is waiting before sending its operation", async () => {
  const f = await fixture();
  const { sessions, renderer } = await f.connect();
  f.onSync(async () => { addImage(renderer); await renderer.flush(); });
  await sessions.flush("file", true);
  expect(f.uploads).toHaveLength(1);
  expect(f.batches).toHaveLength(1); // No avoidable 400 on the first send.
  expect(f.receipts.size).toBe(1);
  expect(f.remote.project()).toEqual(JSON.parse(JSON.stringify(renderer.project())));
  expect(sessions.describe("file").status).toBe("saved");
});

it("repairs a stale uploaded flag for an intermediate image after restart, retaining operation ids and remote edits", async () => {
  const f = await fixture();
  const first = await f.connect();
  // The first operation commits before the second is refused: retry must be idempotent.
  const original = first.renderer.project();
  first.renderer.change(original, { ...original, metadata: { ...original.metadata, title: "local title" } });
  addImage(first.renderer);
  await first.renderer.flush();
  first.renderer.restore("undo");
  await first.renderer.flush();
  const folder = path.join(f.directory, "collaboration-v1", "assets", "shared");
  for (const name of await fs.readdir(folder)) {
    await fs.writeFile(path.join(folder, name), JSON.stringify({ source, uploaded: true }));
  }
  first.renderer.destroy();
  await first.close();
  const remoteBefore = f.remote.project();
  const remoteAfter = structuredClone(remoteBefore);
  (remoteAfter.metadata as ObjectValue).author = "remote author";
  f.remote.change(remoteBefore, remoteAfter);
  const second = await f.connect();
  await second.sessions.flush("file", true);
  expect(f.uploads).toHaveLength(1); // Even though the final projection no longer refers to it.
  expect(f.batches).toHaveLength(2);
  expect(f.batches[1]).toEqual(f.batches[0]);
  expect(f.receipts.size).toBe(f.batches[0].length);
  expect((f.remote.project().metadata as ObjectValue).author).toBe("remote author");
  expect(JSON.stringify(f.remote.project())).not.toContain("sigma-doc-storage://");
  await second.sessions.flush("file", true);
  expect(f.batches).toHaveLength(2);
  await second.close();
  const third = await f.connect();
  await third.sessions.flush("file", true);
  expect(f.batches).toHaveLength(2);
  expect(third.sessions.project("file")).toEqual(parseSigmaDocument(f.remote.project()));
});

it.each([400, 403])("keeps refused operations durable and bounds recovery (HTTP %s)", async status => {
  const f = await fixture();
  const first = await f.connect();
  addImage(first.renderer);
  await first.renderer.flush();
  f.reject(new CollaborationHttpError("MISSING_ASSET", status));
  await expect(first.sessions.flush("file", true)).rejects.toThrow("MISSING_ASSET");
  expect(f.batches).toHaveLength(status === 400 ? 2 : 1);
  expect(f.uploads).toHaveLength(status === 400 ? 2 : 1);
  expect(first.sessions.describe("file").status).toBe(status === 400 ? "needs-recovery" : "permission-error");
  await expect(first.sessions.flush("file", true)).rejects.toThrow(status === 400 ? "ASSET_RECOVERY_REQUIRED" : "MISSING_ASSET");
  expect(f.batches).toHaveLength(2);
  expect(f.uploads).toHaveLength(status === 400 ? 2 : 1); // No repeated cache upload for an unchanged refusal.
  first.renderer.destroy();
  await first.close();
  const second = await f.connect();
  await expect(second.sessions.flush("file", true)).rejects.toThrow("MISSING_ASSET");
  expect(f.batches.at(-1)).toEqual(f.batches[0]);
  expect(f.receipts.size).toBe(0);
});

it("does not retry without cached bytes or on other validation failures", async () => {
  const f = await fixture();
  const { sessions, renderer } = await f.connect();
  const before = renderer.project();
  renderer.change(before, { ...before, metadata: { ...before.metadata, title: "pending" } });
  await renderer.flush();
  f.reject(new CollaborationHttpError("MISSING_ASSET", 400));
  await expect(sessions.flush("file", true)).rejects.toThrow("MISSING_ASSET");
  expect(f.batches).toHaveLength(1);
  addImage(renderer);
  await renderer.flush();
  f.reject(new CollaborationHttpError("SCHEMA_MISMATCH", 409));
  await expect(sessions.flush("file", true)).rejects.toThrow("SCHEMA_MISMATCH");
  expect(f.uploads).toHaveLength(1);
  expect(f.batches).toHaveLength(2);
});

it("retains pending operations if the repair upload fails and retries after reconnect", async () => {
  const f = await fixture();
  const { sessions, renderer } = await f.connect();
  addImage(renderer);
  await renderer.flush();
  // Upload normally once, then simulate a server that no longer has the cached image.
  await sessions.flush("file", true);
  f.assets.clear();
  const before = renderer.project();
  renderer.change(before, { ...before, metadata: { ...before.metadata, title: "pending" } });
  await renderer.flush();
  f.failUpload(new TypeError("fetch failed"));
  await expect(sessions.flush("file", true)).rejects.toThrow("fetch failed");
  expect(sessions.describe("file").status).toBe("offline");
  f.failUpload(undefined);
  await sessions.flush("file", true);
  expect(f.batches.at(-1)).toEqual(f.batches.at(-2));
  expect((f.remote.project().metadata as ObjectValue).title).toBe("pending");
  expect(sessions.describe("file").status).toBe("saved");
});
