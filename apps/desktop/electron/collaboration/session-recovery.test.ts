import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { SharedDocumentJournal } from "./journal";
import { CollaborationSessions } from "./sessions";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
vi.mock("electron", () => ({ safeStorage: {} }));
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
it("rebuilds a corrupt index from the newest epoch and retains old offline logs", async () => {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-recovery-"));
  directories.push(directory);
  const root = path.join(directory, "collaboration-v1");
  const document = createBlankDocument();
  for (const epoch of [1, 2]) {
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify({ ...document, metadata: { ...document.metadata, title: `epoch-${epoch}` } })) as ObjectValue, { sharedDocumentId: "shared", epoch });
    await SharedDocumentJournal.create(path.join(root, "documents", epoch === 1 ? "shared" : "shared-epoch-2"), { sharedDocumentId: "shared", epoch, protocol: 1, localFileId: "file", docId: document.docId }, shared);
    shared.destroy();
  }
  await fs.writeFile(path.join(root, "registry.json"), "{broken");
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), () => {});
  try {
    await sessions.initialize();
    expect(sessions.describe("file").binding.epoch).toBe(2);
    expect(sessions.project("file")?.metadata.title).toBe("epoch-2");
    await expect(sessions.update("file", "AA==", crypto.randomUUID(), "manual", 1)).rejects.toThrow("EPOCH_CHANGED");
    expect((await fs.readdir(root)).some((file) => file.startsWith("registry-invalid-"))).toBe(true);
    expect((await SharedDocumentJournal.open(path.join(root, "documents", "shared"))).binding.epoch).toBe(1);
    const registry = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8"));
    expect(registry.files.file.journalDirectory).toBe("shared-epoch-2");
  } finally { await sessions.close(); }
});

it("decodes only the journal it has to re-register at startup and reuses it as the session", async () => {
  vi.stubEnv("SIGMA_COLLABORATION_URL", "");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-recovery-"));
  directories.push(directory);
  const root = path.join(directory, "collaboration-v1");
  const files: Record<string, unknown> = {};
  for (const name of ["a", "b"]) {
    const document = createBlankDocument();
    const shared = new SharedDocument();
    shared.initialize(JSON.parse(JSON.stringify({ ...document, metadata: { ...document.metadata, title: `title-${name}` } })) as ObjectValue, { sharedDocumentId: `shared-${name}`, epoch: 1 });
    await SharedDocumentJournal.create(path.join(root, "documents", `shared-${name}`), { sharedDocumentId: `shared-${name}`, epoch: 1, protocol: 1, localFileId: `file-${name}`, docId: document.docId }, shared);
    shared.destroy();
    files[`file-${name}`] = { sharedDocumentId: `shared-${name}`, actorId: "recovery", role: "viewer", operationId: crypto.randomUUID(), initialized: true };
  }
  // 登録に無い古い版も、復元のための走査では読まれる。
  const orphan = createBlankDocument();
  const orphanShared = new SharedDocument();
  orphanShared.initialize(JSON.parse(JSON.stringify(orphan)) as ObjectValue, { sharedDocumentId: "shared-orphan", epoch: 1 });
  await SharedDocumentJournal.create(path.join(root, "documents", "shared-orphan"), { sharedDocumentId: "shared-orphan", epoch: 1, protocol: 1, localFileId: "file-orphan", docId: orphan.docId }, orphanShared);
  orphanShared.destroy();
  await fs.writeFile(path.join(root, "registry.json"), JSON.stringify({ version: 1, files }));
  const open = vi.spyOn(SharedDocumentJournal, "open");
  const sessions = new CollaborationSessions(directory, new LocalSigmaDocStore(directory), () => {});
  try {
    await sessions.initialize();
    // The registered, clean journals stay closed; the orphan is decoded once to re-register it.
    expect(open).toHaveBeenCalledTimes(1);
    expect(sessions.describe("file-orphan").binding.sharedDocumentId).toBe("shared-orphan");
    expect((await sessions.read("file-a"))?.metadata.title).toBe("title-a");
    expect((await sessions.read("file-b"))?.metadata.title).toBe("title-b");
    expect(open).toHaveBeenCalledTimes(3);
  } finally {
    open.mockRestore();
    await sessions.close();
  }
});
