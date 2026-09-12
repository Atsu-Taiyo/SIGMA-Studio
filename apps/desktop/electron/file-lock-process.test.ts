import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import type { DocumentVersion } from "@/lib/document-version-history";
import { acquireFileLock, FILE_LOCK_STALE_MS, type FileLockHandle } from "./file-lock";
import { LocalSigmaDocStore } from "./local-sigma-doc-store";
import {
  DOCUMENT_VERSION_INDEX_FILE_NAME,
  readDocumentVersion,
  readDocumentVersionMetadata,
  resolveDocumentVersionDirectory,
} from "./document-version-sidecar";
import type { LockWorkerAcquisition, LockWorkerCommand, LockWorkerReply } from "../tests/fixtures/file-lock-worker";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeModulesPath = path.resolve(appRoot, "../../node_modules");
const PROCESS_TIMEOUT_MS = 10_000;

class LockWorker {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private nextRequestId = 0;
  private stderr = "";
  private exited = false;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;

  constructor(bundlePath: string) {
    this.child = fork(bundlePath, [], {
      silent: true,
      execArgv: [],
      env: {
        ...process.env,
        NODE_PATH: [nodeModulesPath, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      },
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_000);
    });
    this.child.stdout?.resume();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimeout = setTimeout(() => rejectReady(new Error(`Worker did not become ready. ${this.stderr}`)), PROCESS_TIMEOUT_MS);
    this.child.on("message", (message: LockWorkerReply | { type: "ready" }) => {
      if ("type" in message) {
        clearTimeout(readyTimeout);
        resolveReady();
        return;
      }
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      clearTimeout(request.timeout);
      if (message.ok) {
        request.resolve(message.value);
      } else {
        request.reject(Object.assign(new Error(message.error.message), {
          name: message.error.name,
          ...(message.error.code ? { code: message.error.code } : {}),
        }));
      }
    });
    this.closed = new Promise<void>((resolve) => {
      const failPending = (error: Error) => {
        clearTimeout(readyTimeout);
        rejectReady(error);
        for (const request of this.pending.values()) {
          clearTimeout(request.timeout);
          request.reject(error);
        }
        this.pending.clear();
      };
      this.child.on("error", failPending);
      this.child.once("close", (code, signal) => {
        this.exited = true;
        failPending(new Error(`Worker exited (${code ?? signal}). ${this.stderr}`));
        resolve();
      });
    });
  }

  request<T>(command: LockWorkerCommand): Promise<T> {
    const requestId = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Worker request timed out: ${command.action}. ${this.stderr}`));
      }, PROCESS_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timeout });
      this.child.send({ requestId, command }, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  async terminate(): Promise<void> {
    if (!this.exited) this.child.kill("SIGKILL");
    await this.closed;
  }
}

describe("file locking across real processes", { timeout: 20_000 }, () => {
  let buildDir: string;
  let workerBundle: string;
  let scratchDir: string;
  const workers: LockWorker[] = [];
  const localHandles: FileLockHandle[] = [];

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-lock-worker-build-"));
    workerBundle = path.join(buildDir, "worker.cjs");
    await build({
      entryPoints: [path.join(appRoot, "tests/fixtures/file-lock-worker.ts")],
      outfile: workerBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["fs-native-extensions"],
      alias: { "@": path.join(appRoot, "src") },
      logLevel: "silent",
    });
  });
  afterAll(async () => {
    if (buildDir) await fs.rm(buildDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-lock-process-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      const results = await Promise.allSettled([
        ...workers.splice(0).map((worker) => worker.terminate()),
        ...localHandles.splice(0).map((handle) => handle.release()),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } finally {
      if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
    }
  });

  async function startWorker(): Promise<LockWorker> {
    const worker = new LockWorker(workerBundle);
    workers.push(worker);
    await worker.ready;
    return worker;
  }

  it("does not steal an alive owner's lock when its heartbeat metadata is old", async () => {
    const [owner, contender] = await Promise.all([startWorker(), startWorker()]);
    const lockPath = path.join(scratchDir, "live.lock");
    const held = await owner.request<LockWorkerAcquisition>({
      action: "acquire", lockPath, options: { heartbeatMs: 60_000 },
    });
    await fs.utimes(lockPath, new Date(0), new Date(0));
    await expect(contender.request({
      action: "acquire", lockPath, options: { staleMs: 1, timeoutMs: 0 },
    })).rejects.toThrow(String(held.pid));
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).lockId).toBe(held.lockId);
    await expect(owner.request({ action: "release", lockId: held.lockId })).resolves.toBe(true);
    const next = await contender.request<LockWorkerAcquisition>({ action: "acquire", lockPath, options: { timeoutMs: 0 } });
    expect(next.lockId).not.toBe(held.lockId);
    await expect(contender.request({ action: "release", lockId: next.lockId })).resolves.toBe(true);
  });

  it("recovers after a holding process dies without waiting for a stale lease", async () => {
    const [owner, successor] = await Promise.all([startWorker(), startWorker()]);
    const lockPath = path.join(scratchDir, "crash.lock");
    const held = await owner.request<LockWorkerAcquisition>({ action: "acquire", lockPath });
    await owner.terminate();
    // Windows may finish releasing a dead process's LockFileEx lock shortly
    // after its exit. Allow that OS cleanup, while remaining below the old lease.
    const recoveryStartedAt = performance.now();
    const recovered = await successor.request<LockWorkerAcquisition>({ action: "acquire", lockPath, options: { timeoutMs: 2_000 } });
    expect(performance.now() - recoveryStartedAt).toBeLessThan(FILE_LOCK_STALE_MS);
    expect(recovered.lockId).not.toBe(held.lockId);
    expect(recovered.recoveries).toEqual([{ staleOwnerPid: held.pid, staleOwnerHost: os.hostname() }]);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).lockId).toBe(recovered.lockId);
    await expect(successor.request({ action: "release", lockId: recovered.lockId })).resolves.toBe(true);
  });

  it("serializes shared read-modify-write work across independent processes", async () => {
    const group = await Promise.all([startWorker(), startWorker(), startWorker()]);
    const counterPath = path.join(scratchDir, "counter.txt");
    const criticalPath = path.join(scratchDir, "critical-owner");
    await fs.writeFile(counterPath, "0", "utf8");
    const counts = await Promise.all(group.map((worker) => worker.request<number>({
      action: "counter",
      lockPath: path.join(scratchDir, "counter.lock"),
      counterPath,
      criticalPath,
      count: 8,
    })));
    expect(counts).toEqual([8, 8, 8]);
    expect(await fs.readFile(counterPath, "utf8")).toBe("24");
    await expect(fs.access(criticalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves every created ledger row and document body across processes", async () => {
    const userDataDir = path.join(scratchDir, "store");
    const seedStore = new LocalSigmaDocStore(userDataDir);
    const initial = await seedStore.initializeWorkspace({ initialDocument: createBlankDocument("seed") });
    const group = await Promise.all([startWorker(), startWorker()]);
    type Created = { file: { fileId: string; title: string }; document: SigmaDocument };
    const created = (await Promise.all(group.map((worker, index) => worker.request<Created[]>({
      action: "create-documents", userDataDir, prefix: `worker-${index}`, count: 6,
    })))).flat();
    const expectedIds = [initial.activeFileId, ...created.map((entry) => entry.file.fileId)].sort();
    // Inspect the raw ledger before any read-side repair can adopt orphan bodies.
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, "data/library.json"), "utf8")) as {
      files: Array<{ fileId: string; title: string }>;
    };
    expect(raw.files.map((file) => file.fileId).sort()).toEqual(expectedIds);
    expect(created.map((entry) => entry.file.title).sort()).toEqual(
      [0, 1].flatMap((worker) => Array.from({ length: 6 }, (_, index) => `worker-${worker}-${index}`)).sort(),
    );
    const freshStore = new LocalSigmaDocStore(userDataDir);
    expect((await freshStore.listFiles()).map((file) => file.fileId).sort()).toEqual(expectedIds);
    for (const entry of created) {
      expect(raw.files.find((file) => file.fileId === entry.file.fileId)?.title).toBe(entry.file.title);
      expect(await freshStore.loadDocument(entry.file.fileId)).toEqual(entry.document);
    }
  });

  it("preserves every version index row and matching snapshot across processes", async () => {
    const rootDir = path.join(scratchDir, "versions");
    const fileId = "file_shared";
    const group = await Promise.all([startWorker(), startWorker()]);
    const versions = (await Promise.all(group.map((worker, index) => worker.request<DocumentVersion[]>({
      action: "append-versions", rootDir, fileId, prefix: `worker${index}`, count: 6,
    })))).flat();
    const expectedIds = versions.map((version) => version.versionId).sort();
    const indexPath = path.join(resolveDocumentVersionDirectory(rootDir, fileId), DOCUMENT_VERSION_INDEX_FILE_NAME);
    const indexText = await fs.readFile(indexPath, "utf8");
    expect(indexText.endsWith("\n")).toBe(true);
    const rows = indexText.trimEnd().split("\n").map((line) => JSON.parse(line) as { versionId: string });
    expect(rows.map((row) => row.versionId).sort()).toEqual(expectedIds);
    expect((await readDocumentVersionMetadata(rootDir, fileId)).map((version) => version.versionId).sort()).toEqual(expectedIds);
    for (const version of versions) {
      expect(await readDocumentVersion(rootDir, fileId, version.versionId)).toEqual(version);
    }
  });

  it.each(["metadata write", "metadata removal"] as const)("releases native ownership after a failed %s", async (failure) => {
    const worker = await startWorker();
    const lockPath = path.join(scratchDir, "failure.lock");
    const ioError = Object.assign(new Error(`injected ${failure} failure`), { code: "EACCES" });
    if (failure === "metadata write") {
      const writeFile = fs.writeFile;
      const spy = vi.spyOn(fs, "writeFile").mockImplementation((...args) => (
        args[0] === lockPath ? Promise.reject(ioError) : writeFile(...args)
      ));
      try {
        await expect(acquireFileLock(lockPath).then((handle) => {
          localHandles.push(handle);
          return handle;
        })).rejects.toBe(ioError);
      } finally {
        spy.mockRestore();
      }
    } else {
      const handle = await acquireFileLock(lockPath);
      localHandles.push(handle);
      const unlink = fs.unlink;
      const spy = vi.spyOn(fs, "unlink").mockImplementation((target) => target === lockPath ? Promise.reject(ioError) : unlink(target));
      try {
        await expect(handle.release()).rejects.toBe(ioError);
      } finally {
        spy.mockRestore();
      }
    }
    const next = await worker.request<LockWorkerAcquisition>({ action: "acquire", lockPath, options: { timeoutMs: 0 } });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).lockId).toBe(next.lockId);
    await expect(worker.request({ action: "release", lockId: next.lockId })).resolves.toBe(true);
  });
});
