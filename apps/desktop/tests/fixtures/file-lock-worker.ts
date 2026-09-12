import fs from "node:fs/promises";

import { acquireFileLock, type FileLockHandle, type FileLockOptions } from "../../electron/file-lock";
import { LocalSigmaDocStore } from "../../electron/local-sigma-doc-store";
import { appendDocumentVersion } from "../../electron/document-version-sidecar";
import { createBlankDocument } from "@/lib/blank-document";
import type { DocumentVersion } from "@/lib/document-version-history";

export type LockWorkerCommand =
  | { action: "acquire"; lockPath: string; options?: Omit<FileLockOptions, "onStaleLockBroken"> }
  | { action: "release"; lockId: string }
  | { action: "counter"; lockPath: string; counterPath: string; criticalPath: string; count: number }
  | { action: "create-documents"; userDataDir: string; prefix: string; count: number }
  | { action: "append-versions"; rootDir: string; fileId: string; prefix: string; count: number };

export interface LockWorkerAcquisition {
  lockId: string;
  pid: number;
  recoveries: Array<{ staleOwnerPid: number | null; staleOwnerHost: string | null }>;
}

export type LockWorkerReply =
  | { requestId: number; ok: true; value: unknown }
  | { requestId: number; ok: false; error: { name: string; message: string; code?: string } };

const heldLocks = new Map<string, FileLockHandle>();

async function execute(command: LockWorkerCommand): Promise<unknown> {
  switch (command.action) {
    case "acquire": {
      const recoveries: LockWorkerAcquisition["recoveries"] = [];
      const handle = await acquireFileLock(command.lockPath, {
        ...command.options,
        onStaleLockBroken: (info) => recoveries.push(info),
      });
      heldLocks.set(handle.lockId, handle);
      return { lockId: handle.lockId, pid: process.pid, recoveries } satisfies LockWorkerAcquisition;
    }
    case "release": {
      const handle = heldLocks.get(command.lockId);
      if (!handle) throw new Error("Unknown worker lock handle.");
      try {
        return await handle.release();
      } finally {
        heldLocks.delete(command.lockId);
      }
    }
    case "counter": {
      for (let index = 0; index < command.count; index += 1) {
        const handle = await acquireFileLock(command.lockPath, { op: "counter", timeoutMs: 5_000 });
        let ownsCriticalMarker = false;
        try {
          // This second exclusive create is an independent overlap detector,
          // not the synchronization mechanism used to protect the counter.
          await fs.writeFile(command.criticalPath, String(process.pid), { flag: "wx" });
          ownsCriticalMarker = true;
          const value = Number(await fs.readFile(command.counterPath, "utf8"));
          if (!Number.isSafeInteger(value)) throw new Error("Invalid shared counter.");
          await fs.writeFile(command.counterPath, String(value + 1), "utf8");
        } finally {
          try {
            if (ownsCriticalMarker) await fs.unlink(command.criticalPath);
          } finally {
            await handle.release();
          }
        }
      }
      return command.count;
    }
    case "create-documents": {
      const store = new LocalSigmaDocStore(command.userDataDir);
      const created = [];
      for (let index = 0; index < command.count; index += 1) {
        created.push(await store.createDocument({ title: `${command.prefix}-${index}` }));
      }
      return created;
    }
    case "append-versions": {
      const versions: DocumentVersion[] = [];
      for (let index = 0; index < command.count; index += 1) {
        const version: DocumentVersion = {
          versionId: `version_${command.prefix}-${index}`,
          revision: index + 1,
          capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          origin: "user",
          document: createBlankDocument(`${command.prefix}-${index}`),
        };
        await appendDocumentVersion(command.rootDir, command.fileId, version);
        versions.push(version);
      }
      return versions;
    }
  }
}

process.on("message", (message: { requestId: number; command: LockWorkerCommand }) => {
  void execute(message.command).then(
    (value) => process.send?.({ requestId: message.requestId, ok: true, value } satisfies LockWorkerReply),
    (error: unknown) => process.send?.({
      requestId: message.requestId,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      },
    } satisfies LockWorkerReply),
  );
});

process.send?.({ type: "ready", pid: process.pid });
