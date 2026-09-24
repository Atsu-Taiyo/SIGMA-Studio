import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { toBase64 } from "../../src/features/collaboration/model/protocol";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import { SharedDocumentJournal } from "./journal";
import { CollaborationSessions } from "./sessions";

vi.mock("electron", () => ({ safeStorage: {} }));

const directories: string[] = [];
const imageSource = "data:image/png;base64,iVBORw0KGgo=";
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("serves a durable local asset only after its authorized journal reference is ready and after restart", async () => {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-asset-ready-"));
  directories.push(directory);
  const document = createBlankDocument();
  const local = new LocalSigmaDocStore(directory);
  const { file: { fileId } } = await local.createFileFromDocument({ document });
  const initial = new SharedDocument();
  initial.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, {
    sharedDocumentId: "shared",
    epoch: 1,
  });
  await SharedDocumentJournal.create(
    path.join(directory, "collaboration-v1", "documents", "shared"),
    { sharedDocumentId: "shared", epoch: 1, protocol: 1, localFileId: fileId, docId: document.docId },
    initial,
  );
  initial.destroy();

  const sessions = new CollaborationSessions(
    directory,
    new LocalSigmaDocStore(directory),
    () => {},
  );
  await sessions.initialize();
  vi.spyOn(sessions, "actorId").mockReturnValue("recovery");
  vi.spyOn(sessions, "flush").mockResolvedValue();
  sessions.restrictCatalog(new Map([["shared", "editor"]]));
  const localSession = (
    sessions as unknown as {
      sessions: Map<string, { role: "editor" | "viewer"; status: string }>;
    }
  ).sessions.get(fileId)!;
  localSession.role = "editor";
  localSession.status = "offline";
  await sessions.asset(fileId, "asset_ready", imageSource);

  expect((await sessions.assetResponse("sigma-doc-storage://asset_ready")).status).toBe(404);

  const renderer = new SharedDocument(sessions.describe(fileId).state
    ? Uint8Array.from(Buffer.from(sessions.describe(fileId).state, "base64"))
    : undefined);
  const before = renderer.project();
  const after = JSON.parse(JSON.stringify(before)) as ObjectValue;
  (after.metadata as ObjectValue).title = "last shared edit";
  const pageLayout = after.pageLayout as ObjectValue;
  pageLayout.overlay = {
    overlaySnapshot: {
      version: 1,
      shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "asset_local", w: 64, h: 48 } }],
      assets: {
        asset_local: {
          id: "asset_local",
          type: "image",
          props: { w: 64, h: 48, name: "paste.png", isAnimated: false, mimeType: "image/png", src: "sigma-doc-storage://asset_ready", fileSize: 8 },
        },
      },
    },
  };
  const vector = renderer.vector();
  renderer.change(before, after);
  await sessions.update(
    fileId,
    toBase64(renderer.difference(vector)),
    crypto.randomUUID(),
    "manual",
    1,
  );
  renderer.destroy();

  const response = await sessions.assetResponse("sigma-doc-storage://asset_ready");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(Buffer.from(imageSource.split(",")[1]!, "base64")),
  );
  await sessions.close();

  const restarted = new CollaborationSessions(
    directory,
    new LocalSigmaDocStore(directory),
    () => {},
  );
  await restarted.initialize();
  vi.spyOn(restarted, "actorId").mockReturnValue("recovery");
  restarted.restrictCatalog(new Map([["shared", "editor"]]));
  expect((await restarted.assetResponse("sigma-doc-storage://asset_ready")).status).toBe(200);
  const raw = new LocalSigmaDocStore(directory);
  const managedRead = vi.fn(async () => { throw new Error("must bypass managed read"); });
  const managedSave = vi.fn(async () => { throw new Error("must bypass managed save"); });
  // Install the same authority boundary main uses and prove scoped materialization bypasses it.
  const restartLocal = (restarted as unknown as { local: LocalSigmaDocStore }).local;
  restartLocal.setDocumentAuthority({ read: managedRead, save: managedSave });
  const intentPath = path.join(directory, "collaboration-v1", `initialize-${fileId}.json`);
  await fs.writeFile(intentPath, JSON.stringify({ operationId: "old-operation" }));
  await restarted.retainLocal(fileId);
  expect(managedRead).not.toHaveBeenCalled();
  expect(managedSave).not.toHaveBeenCalled();
  expect((await raw.loadDocument(fileId))?.metadata.title).toBe("last shared edit");
  expect(JSON.stringify(await raw.loadDocument(fileId))).toContain(imageSource);
  await expect(fs.access(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await fs.readFile(path.join(directory, "collaboration-v1", "documents", "shared", "retired-initialize.json"), "utf8")).operationId).toBe("old-operation");
  await restarted.close();
  // Even rebuilding a lost index must not resurrect the retired shared body.
  await fs.writeFile(path.join(directory, "collaboration-v1", "registry.json"), "{broken");
  const final = new CollaborationSessions(directory, raw, () => {});
  await final.initialize();
  expect(final.has(fileId)).toBe(false);
  expect((await raw.loadDocument(fileId))?.metadata.title).toBe("last shared edit");
  expect(JSON.stringify(await raw.loadDocument(fileId))).toContain(imageSource);
  // A subsequent share must persist a new operation before issuing its network request.
  Object.defineProperty(final, "auth", { value: { user: () => ({ id: "recovery" }), cancelSignIn: () => {} } });
  vi.spyOn(final, "request").mockRejectedValue(new Error("network paused"));
  await expect(final.start(fileId, (await raw.loadDocument(fileId))!)).rejects.toThrow("network paused");
  expect(JSON.parse(await fs.readFile(intentPath, "utf8")).operationId).not.toBe("old-operation");
  await final.close();
});

it("announces readiness when a referenced remote asset succeeds after an initial fetch failure", async () => {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-asset-retry-"));
  directories.push(directory);
  const document = createBlankDocument();
  document.pageLayout!.overlay = {
    overlaySnapshot: {
      version: 1,
      shapes: [{ id: "image1", type: "image", x: 10, y: 20, props: { assetId: "asset_local", w: 64, h: 48 } }],
      assets: {
        asset_local: {
          id: "asset_local",
          type: "image",
          props: { w: 64, h: 48, name: "remote.png", isAnimated: false, mimeType: "image/png", src: "sigma-doc-storage://asset_remote", fileSize: 8 },
        },
      },
    },
  };
  const initial = new SharedDocument();
  initial.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, {
    sharedDocumentId: "shared",
    epoch: 1,
  });
  await SharedDocumentJournal.create(
    path.join(directory, "collaboration-v1", "documents", "shared"),
    { sharedDocumentId: "shared", epoch: 1, protocol: 1, localFileId: "file", docId: document.docId },
    initial,
  );
  initial.destroy();
  const events: unknown[] = [];
  const sessions = new CollaborationSessions(
    directory,
    new LocalSigmaDocStore(directory),
    (event) => events.push(event),
  );
  await sessions.initialize();
  vi.spyOn(sessions, "actorId").mockReturnValue("recovery");
  vi.spyOn(sessions, "flush").mockResolvedValue();
  sessions.restrictCatalog(new Map([["shared", "editor"]]));

  expect((await sessions.assetResponse("sigma-doc-storage://asset_remote")).status).toBe(404);
  (
    sessions as unknown as {
      requestRaw: () => Promise<Response>;
    }
  ).requestRaw = vi.fn(async () => new Response(
    Buffer.from(imageSource.split(",")[1]!, "base64"),
    { headers: { "Content-Type": "image/png" } },
  ));
  await sessions.asset("file", "asset_remote");
  expect(events).toContainEqual({ type: "asset-ready", fileId: "file", assetId: "asset_remote" });
  expect((await sessions.assetResponse("sigma-doc-storage://asset_remote?ready=1")).status).toBe(200);
  await sessions.close();
});
