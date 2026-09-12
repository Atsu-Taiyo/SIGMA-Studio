import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireFileLock as acquireRuntimeFileLock } from "./file-lock";
import * as nativeLock from "./file-lock-native";

describe("acquireFileLock", () => {
  let scratchDir: string;
  let lockPath: string;
  const handles: Array<Awaited<ReturnType<typeof acquireRuntimeFileLock>>> = [];
  const pendingAcquisitions = new Set<Promise<void>>();

  function acquireFileLock(...args: Parameters<typeof acquireRuntimeFileLock>) {
    const operation = acquireRuntimeFileLock(...args).then((handle) => {
      handles.push(handle);
      return handle;
    });
    const settled = operation.then(() => undefined, () => undefined);
    pendingAcquisitions.add(settled);
    void settled.then(() => pendingAcquisitions.delete(settled));
    return operation;
  }

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-file-lock-"));
    lockPath = path.join(scratchDir, "locks", "test.lock");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const errors: unknown[] = [];
    try {
      // Releasing existing owners lets any queued acquisition finish. Drain the
      // newly granted handles too before removing the persistent mutex inode.
      while (handles.length > 0 || pendingAcquisitions.size > 0) {
        const results = await Promise.allSettled(handles.splice(0).map((handle) => handle.release()));
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason);
        }
        await Promise.all(pendingAcquisitions);
      }
      if (errors.length > 0) throw new AggregateError(errors, "Failed to release test-owned file locks.");
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("acquires and releases a lock", async () => {
    const handle = await acquireFileLock(lockPath, { op: "test" });
    expect(handle.lockId).toEqual(expect.any(String));
    await expect(fs.readFile(lockPath, "utf8")).resolves.toContain(handle.lockId);
    const mutexBefore = await fs.stat(`${lockPath}.mutex`);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).version).toBe(2);

    const released = await handle.release();
    expect(released).toBe(true);
    expect(await handle.release()).toBe(false);
    await expect(fs.access(lockPath)).rejects.toThrow();
    const next = await acquireFileLock(lockPath, { timeoutMs: 0 });
    expect((await fs.stat(`${lockPath}.mutex`)).ino).toBe(mutexBefore.ino);
    await next.release();
  });

  it("blocks a second acquire until the first is released", async () => {
    const first = await acquireFileLock(lockPath, { op: "first" });

    let secondAcquired = false;
    const secondPromise = acquireFileLock(lockPath, {
      op: "second",
      timeoutMs: 2_000,
      staleMs: 5_000,
    }).then((handle) => {
      secondAcquired = true;
      return handle;
    });

    // まだ解放していないので取得できていないはず。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondAcquired).toBe(false);

    await first.release();

    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    expect(second.lockId).not.toEqual(first.lockId);
    await second.release();
  });

  it("keeps a live owner even when its heartbeat is older than staleMs", async () => {
    const staleHandle = await acquireFileLock(lockPath, { op: "stale-owner" });
    const staleMtime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleMtime, staleMtime);

    try {
      await expect(acquireFileLock(lockPath, {
        op: "contender",
        staleMs: 50,
        timeoutMs: 0,
      })).rejects.toThrow(new RegExp(`${process.pid}`));
      expect(JSON.parse(await fs.readFile(lockPath, "utf8")).lockId).toBe(staleHandle.lockId);
    } finally {
      await staleHandle.release();
    }
    const next = await acquireFileLock(lockPath, { timeoutMs: 0 });
    await next.release();
  });

  it("breaks a lock immediately when the owning pid on this host is dead", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const deadPayload = {
      version: 1,
      lockId: "dead-lock-id",
      pid: 999_999_99, // 実在しない pid のはず
      host: os.hostname(),
      op: "crashed",
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(deadPayload), "utf8");

    const start = Date.now();
    const handle = await acquireFileLock(lockPath, {
      op: "recoverer",
      staleMs: 10_000,
      timeoutMs: 5_000,
    });
    const elapsed = Date.now() - start;

    expect(handle.lockId).not.toEqual("dead-lock-id");
    // stale 判定(10s)や timeout(5s)を待たず、即座に破棄されるはず。
    expect(elapsed).toBeLessThan(2_000);
    await handle.release();
  });

  it("names the holding pid and respects live legacy metadata even when its mtime is stale", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const livePayload = {
      version: 1,
      lockId: "live-lock-id",
      pid: process.pid, // このテストプロセス自身 = 確実に生存中
      host: os.hostname(),
      op: "long-running",
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(livePayload), "utf8");
    await fs.utimes(lockPath, new Date(0), new Date(0));

    await expect(
      acquireFileLock(lockPath, {
        op: "waiter",
        staleMs: 10_000,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(new RegExp(`${process.pid}`));

    // 生存中の他人のロックは奪われずそのまま残っているはず。
    const remaining = JSON.parse(await fs.readFile(lockPath, "utf8")) as { lockId: string };
    expect(remaining.lockId).toBe("live-lock-id");
  });

  it("releases the lock even when the guarded work throws", async () => {
    const handle = await acquireFileLock(lockPath, { op: "guarded" });
    await expect(
      (async () => {
        try {
          throw new Error("boom");
        } finally {
          await handle.release();
        }
      })(),
    ).rejects.toThrow("boom");

    await expect(fs.access(lockPath)).rejects.toThrow();

    // 解放済みなので再取得できる。
    const next = await acquireFileLock(lockPath, { op: "after-throw" });
    await next.release();
  });

  it("does not unlink someone else's lock when the lockId no longer matches", async () => {
    const handle = await acquireFileLock(lockPath, { op: "original" });

    // 誰かに奪われた(=別の lockId で上書きされた)状況を再現する。
    await fs.unlink(lockPath);
    const otherPayload = {
      version: 1,
      lockId: "someone-else",
      pid: process.pid,
      host: os.hostname(),
      op: "thief",
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(otherPayload), { flag: "wx" });

    const released = await handle.release();
    expect(released).toBe(false);

    const remaining = JSON.parse(await fs.readFile(lockPath, "utf8")) as { lockId: string };
    expect(remaining.lockId).toBe("someone-else");
  });

  it("treats a corrupt/unparseable lockfile payload as stale rather than throwing", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{ not valid json ", "utf8");

    const start = Date.now();
    const handle = await acquireFileLock(lockPath, {
      op: "after-corrupt",
      staleMs: 10_000,
      timeoutMs: 5_000,
    });
    const elapsed = Date.now() - start;

    expect(handle.lockId).toEqual(expect.any(String));
    expect(elapsed).toBeLessThan(2_000);
    await handle.release();
  });

  it("recovers protocol2 metadata with a live pid after its OS ownership has ended", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      version: 2, lockId: "abandoned", pid: process.pid, host: os.hostname(),
      op: "abandoned", acquiredAt: new Date().toISOString(),
    }));
    const recovered = vi.fn();
    const handle = await acquireFileLock(lockPath, { timeoutMs: 0, onStaleLockBroken: recovered });
    try {
      expect(recovered).toHaveBeenCalledExactlyOnceWith({ staleOwnerPid: process.pid, staleOwnerHost: os.hostname() });
      expect(JSON.parse(await fs.readFile(lockPath, "utf8")).lockId).toBe(handle.lockId);
    } finally {
      await handle.release();
    }
  });

  it("does not infer that a legacy owner on another host is dead from its old timestamp", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      version: 1, lockId: "remote-owner", pid: 12345, host: `other-${os.hostname()}`,
      op: "remote", acquiredAt: new Date(0).toISOString(),
    }));
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const recovered = vi.fn();
    await expect(acquireFileLock(lockPath, { timeoutMs: 0, onStaleLockBroken: recovered })).rejects.toThrow("12345");
    expect(recovered).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).lockId).toBe("remote-owner");
  });

  it("fails explicitly on native locking errors and closes the failed attempt", async () => {
    const failure = Object.assign(new Error("native locking unavailable"), { code: "ENOTSUP" });
    const realOpen = fs.open;
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await realOpen(...args);
      if (args[0] === `${lockPath}.mutex`) opened = file;
      return file;
    });
    vi.spyOn(nativeLock, "tryLockFileDescriptor").mockImplementationOnce(() => { throw failure; });
    await expect(acquireFileLock(lockPath, { timeoutMs: 0 })).rejects.toBe(failure);
    expect(opened?.fd).toBe(-1);
    const next = await acquireFileLock(lockPath, { timeoutMs: 0 });
    await next.release();
  });

  it("removes its published metadata and releases ownership when publication reports failure", async () => {
    const failure = new Error("failure after writing the complete payload");
    const realWriteFile = fs.writeFile;
    let injected = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      await realWriteFile(...args);
      if (args[0] === lockPath && !injected) {
        injected = true;
        throw failure;
      }
    });
    await expect(acquireFileLock(lockPath, { timeoutMs: 0 })).rejects.toBe(failure);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const next = await acquireFileLock(lockPath, { timeoutMs: 0 });
    await next.release();
  });

  it("closes the descriptor and releases OS ownership even if explicit unlock throws", async () => {
    const realOpen = fs.open;
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await realOpen(...args);
      if (args[0] === `${lockPath}.mutex`) opened = file;
      return file;
    });
    const owner = await acquireFileLock(lockPath, { timeoutMs: 0 });
    const failure = new Error("native unlock failed before releasing ownership");
    vi.spyOn(nativeLock, "unlockFileDescriptor").mockImplementationOnce(() => { throw failure; });
    await expect(owner.release()).rejects.toBe(failure);
    expect(opened?.fd).toBe(-1);
    const next = await acquireFileLock(lockPath, { timeoutMs: 0 });
    await next.release();
  });

  it("finishes pending heartbeats before releasing OS ownership to another owner", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
    const realUtimes = fs.utimes;
    vi.spyOn(fs, "utimes").mockImplementation(async (...args: Parameters<typeof fs.utimes>) => {
      if (args[0] === lockPath) {
        entered();
        await resumePromise;
      }
      return realUtimes(...args);
    });
    const owner = await acquireFileLock(lockPath, { heartbeatMs: 1 });
    let releaseFinished = false;
    let release: Promise<boolean> | undefined;
    try {
      await enteredPromise;
      release = owner.release().then((result) => { releaseFinished = true; return result; });
      await expect(acquireFileLock(lockPath, { timeoutMs: 0 })).rejects.toThrow(new RegExp(`${process.pid}`));
      expect(releaseFinished).toBe(false);
    } finally {
      resume();
      await (release ?? owner.release());
    }
    const next = await acquireFileLock(lockPath, { timeoutMs: 0 });
    await next.release();
  });
});
