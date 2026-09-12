import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { acquireFileLock, type FileLockHandle } from "./file-lock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// POSIX permits unlinking the first owner's still-open inode. Windows may reject
// that unlink, so this fixture deliberately exercises the POSIX creation window.
describe.skipIf(process.platform === "win32")("file lock creation window", () => {
  let scratchDir: string | undefined;
  let restoreWriteFile: (() => void) | undefined;
  const handles: FileLockHandle[] = [];
  let bothAcquiredBeforeEitherRelease = false;

  // Setup errors must fail the suite, rather than count as the expected failure.
  // In particular, a failed open/write is not evidence of the exclusion bug.
  beforeAll(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-file-lock-race-"));
    const lockPath = path.join(scratchDir, "creation.lock");
    const opened = deferred();
    const resumePayloadWrite = deferred();
    const realWriteFile = fs.writeFile;
    let intercepted = false;
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [filePath, data, options] = args;
      if (filePath !== lockPath || intercepted || typeof options !== "object" || options?.flag !== "wx") {
        return realWriteFile(...args);
      }
      if (typeof data !== "string") throw new Error("Expected a JSON string lock payload.");
      intercepted = true;
      // This is the actual open/write split within fs.promises.writeFile, with
      // only the payload write paused. Reads, retries and unlink use the real FS.
      const file = await fs.open(lockPath, "wx");
      try {
        opened.resolve();
        await resumePayloadWrite.promise;
        await file.writeFile(data, { encoding: "utf8" });
      } finally {
        await file.close();
      }
    });
    restoreWriteFile = () => spy.mockRestore();

    const firstAttempt = acquireFileLock(lockPath, { op: "first", heartbeatMs: 60_000 }).then(
      (handle) => ({ ok: true as const, handle }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let first: FileLockHandle | undefined;
    let second: FileLockHandle | undefined;
    try {
      await Promise.race([
        opened.promise,
        firstAttempt.then((result) => {
          if (!result.ok) throw result.error;
          throw new Error("The first acquisition completed without pausing its payload write.");
        }),
      ]);
      const secondAttempt = await acquireFileLock(lockPath, {
        op: "second",
        heartbeatMs: 60_000,
        // A correct implementation can reject immediately without waiting for
        // the first writer, keeping this regression free of sleeps and races.
        timeoutMs: 0,
      }).then(
        (handle) => ({ ok: true as const, handle }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (secondAttempt.ok) {
        second = secondAttempt.handle;
        handles.push(second);
      } else {
        const te = createCurrentLocaleTranslator("error");
        expect(secondAttempt.error).toEqual(new Error(te("electron.lock.timeout", {
          pid: te("electron.lock.unknownPid"),
          path: lockPath,
        })));
      }
    } finally {
      resumePayloadWrite.resolve();
      const result = await firstAttempt;
      if (!result.ok) throw result.error;
      first = result.handle;
      handles.push(first);
    }
    if (second) expect(second.lockId).not.toBe(first.lockId);
    bothAcquiredBeforeEitherRelease = first !== undefined && second !== undefined;
  });

  afterAll(async () => {
    restoreWriteFile?.();
    try {
      const results = await Promise.allSettled(handles.map((handle) => handle.release()));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    } finally {
      if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
    }
  });

  // The OS mutex protects the creation window even while JSON is unreadable.
  it("does not grant two owners a lock while its initial payload is being written", () => {
    expect(bothAcquiredBeforeEitherRelease).toBe(false);
  });
});

type ObservedOperation<T> = { ok: true; value: T } | { ok: false; error: unknown };

function requireCompletedOperation<T>(result: ObservedOperation<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Tracks only the filesystem operations and resources owned by one identity-race fixture. */
function createLockIdentityFixture() {
  let scratchDir: string | undefined;
  let lockPath: string;
  let restoreUnlink: (() => void) | undefined;
  const handles: FileLockHandle[] = [];
  const pendingOperations: Array<Promise<unknown>> = [];
  const resumeGates: Array<() => void> = [];

  function observe<T>(operation: Promise<T>): Promise<ObservedOperation<T>> {
    const result = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    pendingOperations.push(result);
    return result;
  }

  return {
    async initialize() {
      scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-file-lock-identity-"));
      lockPath = path.join(scratchDir, "identity.lock");
      return lockPath;
    },
    acquire(op: string) {
      return observe(acquireFileLock(lockPath, { op, heartbeatMs: 60_000, timeoutMs: 0 }).then((handle) => {
        handles.push(handle);
        return handle;
      }));
    },
    release(handle: FileLockHandle) {
      return observe(handle.release());
    },
    pauseNextUnlink() {
      const entered = deferred();
      const resume = deferred();
      resumeGates.push(resume.resolve);
      const realUnlink = fs.unlink;
      let intercepted = false;
      const spy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        if (target === lockPath && !intercepted) {
          intercepted = true;
          entered.resolve();
          await resume.promise;
        }
        return realUnlink(target);
      });
      restoreUnlink = () => spy.mockRestore();
      return {
        resume: resume.resolve,
        async waitFor(operation: Promise<ObservedOperation<unknown>>) {
          await Promise.race([
            entered.promise,
            operation.then((result) => {
              requireCompletedOperation(result);
              throw new Error("The operation completed without pausing its lock unlink.");
            }),
          ]);
        },
      };
    },
    async readCurrentLockId(): Promise<string | null> {
      let raw: string;
      try {
        raw = await fs.readFile(lockPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("lockId" in value) || typeof value.lockId !== "string") {
        throw new Error("Expected a complete lock payload after acquisition.");
      }
      return value.lockId;
    },
    requireAcquiredOrTimedOut(result: ObservedOperation<FileLockHandle>): void {
      if (result.ok) return;
      // After the intervening acquisition completes, only a normal contention
      // timeout is an acceptable rejection. I/O/setup errors must fail beforeAll.
      const te = createCurrentLocaleTranslator("error");
      expect(result.error).toEqual(new Error(te("electron.lock.timeout", {
        pid: String(process.pid),
        path: lockPath,
      })));
    },
    async cleanup() {
      for (const resume of resumeGates) resume();
      try {
        await Promise.all(pendingOperations);
      } finally {
        restoreUnlink?.();
        try {
          const results = await Promise.allSettled(handles.map((handle) => handle.release()));
          for (const result of results) {
            if (result.status === "rejected") throw result.reason;
          }
        } finally {
          if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
        }
      }
    },
  };
}

// These identity windows need no open descriptor: acquisition has completed
// before each replacement, so unlike the creation fixture they also run on Windows.
describe("file lock stale recovery identity window", () => {
  const fixture = createLockIdentityFixture();
  let competingOwners = false;
  let grantedOwnersPreserved = false;

  beforeAll(async () => {
    const lockPath = await fixture.initialize();
    await fs.writeFile(lockPath, JSON.stringify({
      version: 2,
      lockId: "stale-owner",
      pid: process.pid,
      host: os.hostname(),
      op: "stale-owner",
      acquiredAt: new Date(0).toISOString(),
    }));
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const pause = fixture.pauseNextUnlink();
    const delayedAttempt = fixture.acquire("delayed-recovery");
    try {
      await pause.waitFor(delayedAttempt);
      // Both attempts independently recover the same abandoned v2 payload. The second
      // may publish a live lock, or a correct coordination gate may reject it
      // with the normal contention timeout while the first recovery is paused.
      const owners: FileLockHandle[] = [];
      const replacement = await fixture.acquire("replacement-recovery");
      fixture.requireAcquiredOrTimedOut(replacement);
      if (replacement.ok) {
        owners.push(replacement.value);
        expect(await fixture.readCurrentLockId()).toBe(replacement.value.lockId);
      }
      pause.resume();
      const delayed = await delayedAttempt;
      fixture.requireAcquiredOrTimedOut(delayed);
      if (delayed.ok) owners.push(delayed.value);
      const publishedLockId = await fixture.readCurrentLockId();
      competingOwners = owners.length > 1;
      grantedOwnersPreserved = owners.every((owner) => owner.lockId === publishedLockId);
    } finally {
      pause.resume();
    }
  });

  afterAll(() => fixture.cleanup());

  // The OS mutex must keep recovery serialized through metadata removal.
  it("preserves exclusive ownership when concurrent stale recovery resumes", () => {
    expect({ competingOwners, grantedOwnersPreserved }).toEqual({
      competingOwners: false,
      grantedOwnersPreserved: true,
    });
  });
});

describe("file lock release identity window", () => {
  const fixture = createLockIdentityFixture();
  let competingOwners = false;
  let grantedOwnersPreserved = false;

  beforeAll(async () => {
    const lockPath = await fixture.initialize();
    const original = requireCompletedOperation(await fixture.acquire("original-owner"));
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const pause = fixture.pauseNextUnlink();
    const delayedRelease = fixture.release(original);
    try {
      await pause.waitFor(delayedRelease);
      // release has already checked its lockId, but its old lock expires before
      // unlink. Recovery may publish a replacement or time out behind a correct
      // coordination gate; neither schedule may lose an unreleased owner.
      const owners: FileLockHandle[] = [];
      const replacement = await fixture.acquire("replacement-owner");
      fixture.requireAcquiredOrTimedOut(replacement);
      if (replacement.ok) {
        owners.push(replacement.value);
        expect(await fixture.readCurrentLockId()).toBe(replacement.value.lockId);
      }
      pause.resume();
      requireCompletedOperation(await delayedRelease);
      // When recovery was serialized, the old owner has now released and this
      // acquisition is valid. It must be rejected only while a replacement owns it.
      const third = await fixture.acquire("third-owner");
      fixture.requireAcquiredOrTimedOut(third);
      if (third.ok) owners.push(third.value);
      const publishedLockId = await fixture.readCurrentLockId();
      competingOwners = owners.length > 1;
      grantedOwnersPreserved = owners.every((owner) => owner.lockId === publishedLockId);
    } finally {
      pause.resume();
    }
  });

  afterAll(() => fixture.cleanup());

  // The OS mutex must remain held through the old owner's metadata removal.
  it("keeps a replacement owner when the old owner's release resumes", () => {
    expect({ competingOwners, grantedOwnersPreserved }).toEqual({
      competingOwners: false,
      grantedOwnersPreserved: true,
    });
  });
});
