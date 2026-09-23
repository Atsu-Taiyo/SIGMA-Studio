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
