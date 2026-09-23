import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import { SharedDocumentJournal } from "./journal";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-shared-"));
  directories.push(directory);
  const document = new SharedDocument();
  document.initialize(
    {
      version: "2.0",
      docId: "doc",
      content: [
        {
          id: "p",
          type: "paragraph",
          children: [{ type: "text", text: "初期" }],
        },
      ],
    },
    { sharedDocumentId: "shared", epoch: 1 },
  );
  const journal = await SharedDocumentJournal.create(
    directory,
    {
      sharedDocumentId: "shared",
      epoch: 1,
      protocol: 1,
      localFileId: "file",
      docId: "doc",
    },
    document,
  );
  const renderer = new SharedDocument(document.snapshot());
  const before = renderer.project();
  renderer.change(before, { ...before, metadata: { title: "オフライン編集" } });
  const update = renderer.difference(document.vector());
  return { directory, journal, renderer, update };
}

describe("durable shared document journal", () => {
  it("restores unacknowledged edits after restart and an incomplete final write", async () => {
    const { directory, journal, renderer, update } = await fixture();
    await journal.append(
      update,
      { operationId: "op1", actorId: "a", kind: "manual" },
      true,
    );
    await fs.appendFile(path.join(directory, "updates.jsonl"), '{"sequence":2');
    const recovered = await SharedDocumentJournal.open(directory);
    expect(recovered.document.project()).toEqual(renderer.project());
    expect(recovered.outbox()).toHaveLength(1);
    await recovered.acknowledge("op1");
    expect((await SharedDocumentJournal.open(directory)).outbox()).toEqual([]);
  });
  it("compacts without changing CRDT identities or losing outbox updates", async () => {
    const { directory, journal, update } = await fixture();
    await journal.append(
      update,
      { operationId: "op1", actorId: "a", kind: "manual" },
      true,
    );
    const vector = journal.document.vector();
    await journal.compact();
    const restored = await SharedDocumentJournal.open(directory);
    expect(restored.document.vector()).toEqual(vector);
    expect(restored.outbox()).toHaveLength(1);
    await restored.acknowledge("op1");
    await restored.compact();
    expect((await SharedDocumentJournal.open(directory)).outbox()).toEqual([]);
  });
  it("rejects complete corrupted records rather than quietly dropping edits", async () => {
    const { directory, journal, update } = await fixture();
    await journal.append(
      update,
      { operationId: "op1", actorId: "a", kind: "manual" },
      true,
    );
    const file = path.join(directory, "updates.jsonl");
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        '"actorId":"a"',
        '"actorId":"b"',
      ),
    );
    await expect(SharedDocumentJournal.open(directory)).rejects.toThrow(
      "CORRUPT_UPDATE_LOG",
    );
  });
  it("serializes concurrent local persistence and durable acknowledgements", async () => {
    const { directory, journal, update } = await fixture();
    await Promise.all([
      journal.append(
        update,
        { operationId: "op1", actorId: "a", kind: "manual" },
        true,
      ),
      journal.acknowledge("op1"),
      journal.compact(),
    ]);
    expect((await SharedDocumentJournal.open(directory)).outbox()).toEqual([]);
  });
});
