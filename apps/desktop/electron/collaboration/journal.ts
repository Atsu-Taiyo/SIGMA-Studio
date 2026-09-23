import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SharedDocument } from "../../src/features/collaboration/model/shared-document";
import {
  fromBase64,
  toBase64,
  MAX_DOCUMENT_BYTES,
  type OperationIdentity,
  type SharedBinding,
} from "../../src/features/collaboration/model/protocol";
import { stableValue } from "../../src/features/collaboration/model/value";

export interface PendingUpdate {
  identity: OperationIdentity;
  update: string;
}
interface Checkpoint {
  version: 1;
  binding: SharedBinding;
  sequence: number;
  state: string;
  pending: PendingUpdate[];
}
type RecordPayload =
  | { kind: "update"; value: PendingUpdate; pending: boolean }
  | { kind: "ack"; operationId: string };
interface LogRecord {
  sequence: number;
  payload: RecordPayload;
  checksum: string;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableValue(value)).digest("hex");
}
export async function durableWrite(file: string, bytes: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    // Directory fsync is supported on POSIX, but not on every Windows filesystem.
    try {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(String(error.code))
      ))
        throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** The main process is the sole owner; every accepted update is flushed before it is sent. */
export class SharedDocumentJournal {
  private sequence = 0;
  private readonly pending = new Map<string, PendingUpdate>();
  private tail: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private constructor(
    readonly directory: string,
    readonly binding: SharedBinding,
    readonly document: SharedDocument,
  ) {}

  static async create(
    directory: string,
    binding: SharedBinding,
    document: SharedDocument,
  ): Promise<SharedDocumentJournal> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const journal = new SharedDocumentJournal(directory, binding, document);
    try {
      await fs.access(path.join(directory, "snapshot.json"));
      throw new Error("SESSION_EXISTS");
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    await journal.writeCheckpoint();
    return journal;
  }

  static async open(directory: string): Promise<SharedDocumentJournal> {
    const raw = JSON.parse(
      await fs.readFile(path.join(directory, "snapshot.json"), "utf8"),
    ) as { value: Checkpoint; checksum: string };
    if (raw.checksum !== checksum(raw.value) || raw.value.version !== 1)
      throw new Error("CORRUPT_SNAPSHOT");
    const document = new SharedDocument(
      fromBase64(raw.value.state, MAX_DOCUMENT_BYTES),
    );
    if (
      document.identity().sharedDocumentId !==
        raw.value.binding.sharedDocumentId ||
      document.identity().epoch !== raw.value.binding.epoch
    )
      throw new Error("SESSION_IDENTITY_MISMATCH");
    const journal = new SharedDocumentJournal(
      directory,
      raw.value.binding,
      document,
    );
    journal.sequence = raw.value.sequence;
    raw.value.pending.forEach((item) =>
      journal.pending.set(item.identity.operationId, item),
    );
    let log = "";
    try {
      log = await fs.readFile(path.join(directory, "updates.jsonl"), "utf8");
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const complete = log.slice(0, log.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as LogRecord;
      if (
        checksum({ sequence: record.sequence, payload: record.payload }) !==
        record.checksum
      )
        throw new Error("CORRUPT_UPDATE_LOG");
      if (record.sequence <= journal.sequence) continue; // Snapshot committed before log rotation.
      if (record.sequence !== journal.sequence + 1)
        throw new Error("MISSING_UPDATE_LOG");
      journal.applyRecord(record.payload);
      journal.sequence = record.sequence;
    }
    // A process may have stopped during its final append. Never append after a torn record.
    if (complete.length !== log.length)
      await durableWrite(path.join(directory, "updates.jsonl"), complete);
    document.project();
    return journal;
  }

  outbox(): PendingUpdate[] {
    return [...this.pending.values()].map((item) => structuredClone(item));
  }

  append(
    update: Uint8Array,
    identity: OperationIdentity,
    pending: boolean,
  ): Promise<void> {
    return this.exclusive(async () => {
      const existing = this.pending.get(identity.operationId);
      if (existing) {
        if (existing.update !== toBase64(update))
          throw new Error("OPERATION_ID_REUSED");
        return;
      }
      await this.writeRecord({
        kind: "update",
        value: { identity, update: toBase64(update) },
        pending,
      });
    });
  }

  acknowledge(operationId: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.pending.has(operationId))
        await this.writeRecord({ kind: "ack", operationId });
    });
  }

  compact(): Promise<void> {
    return this.exclusive(async () => {
      await this.writeCheckpoint();
      await durableWrite(path.join(this.directory, "updates.jsonl"), "");
    });
  }

  flush(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail
      .then(() => {
        if (this.failure) throw this.failure;
        return operation();
      })
      .catch((error) => {
        this.failure = error;
        throw error;
      });
    this.tail = next.catch(() => {});
    return next;
  }

  private async writeRecord(payload: RecordPayload): Promise<void> {
    const body = { sequence: this.sequence + 1, payload };
    const record: LogRecord = { ...body, checksum: checksum(body) };
    const handle = await fs.open(
      path.join(this.directory, "updates.jsonl"),
      "a",
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.applyRecord(payload);
    this.sequence = body.sequence;
  }

  private applyRecord(payload: RecordPayload): void {
    if (payload.kind === "ack") {
      this.pending.delete(payload.operationId);
      return;
    }
    this.document.applyUpdate(
      fromBase64(payload.value.update, MAX_DOCUMENT_BYTES),
    );
    if (payload.pending)
      this.pending.set(payload.value.identity.operationId, payload.value);
  }

  private async writeCheckpoint(): Promise<void> {
    const value: Checkpoint = {
      version: 1,
      binding: this.binding,
      sequence: this.sequence,
      state: toBase64(this.document.snapshot()),
      pending: this.outbox(),
    };
    await durableWrite(
      path.join(this.directory, "snapshot.json"),
      JSON.stringify({ value, checksum: checksum(value) }),
    );
  }
}
