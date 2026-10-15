import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { documentSearchText, type SigmaDocument } from "@/features/document";
import type { WorkspaceOverview } from "@/lib/runtime/types";
import {
  bodySearchFileFromSummary,
  WorkspaceBodySearchSession,
  WorkspaceBodyTextIndex,
  type BodySearchFile,
  type BodyTextStore,
  type StoredBodyText,
} from "@/lib/workspace-body-search";
import type { WorkspaceBodySearchUpdate } from "@/lib/workspace-body-search-contract";

const STORE_DIRECTORY = "workspace-search-index";
const STORE_FORMAT = "v1";
const SHARD_COUNT = 64;
/** 片付けるのは、古い版・削除された教材の行が生きている行より多く、ある程度たまってから。 */
const COMPACT_MIN_DEAD_LINES = 64;

/**
 * ローカル教材の本文の文字列を `userData/workspace-search-index/` に置く。
 *
 * 教材を 64 の束に分け、束ごとに 1 行 1 教材 (`fileId \t 印 \t 文字数 \t 文字列`) で書き足していく。
 * 1 教材 1 ファイルにすると数万教材で数万ファイルになり (端数で容量も倍近くなり、読み通しも遅い)、
 * 1 ファイルにまとめると 1 教材を保存するたびに全部を書き直すことになるため。同じ教材は最後の行が有効で、
 * 古い行と削除された教材の行が生きている行より多くなったら、その束だけを書き直して片付ける。
 * 行は改行を先に書いてから足すので、書きかけで止まった行は次の行とつながらず、文字数が合わないので捨てられる。
 */
export function createBodyTextDiskStore(userDataPath: string): BodyTextStore {
  const directory = path.join(userDataPath, STORE_DIRECTORY);
  const shardPath = (shard: number) => path.join(directory, `text-${STORE_FORMAT}-${shard.toString().padStart(2, "0")}.tsv`);
  // 同じ束への書き足しと片付けは順番に行う (片付けの最中に足した行を失わないように)。
  const queues = new Map<number, Promise<unknown>>();
  const exclusive = <T>(shard: number, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(shard) ?? Promise.resolve()).then(task, task);
    queues.set(shard, next.catch(() => {}));
    return next;
  };

  const compact = (shard: number, keep: ReadonlySet<string> | undefined) => exclusive(shard, async () => {
    const content = await fs.readFile(shardPath(shard), "utf8").catch(() => "");
    const latest = new Map<string, string>();
    for (const line of content.split("\n")) {
      const record = parseLine(line);
      if (!record) continue;
      latest.delete(record.fileId);
      latest.set(record.fileId, line);
    }
    const lines = [...latest].filter(([fileId]) => !keep || keep.has(fileId)).map(([, line]) => `\n${line}`);
    const temporary = `${shardPath(shard)}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, lines.join(""));
    await fs.rename(temporary, shardPath(shard)).catch(async (error) => {
      await fs.rm(temporary, { force: true });
      throw error;
    });
  });

  return {
    async scan(visit, options = {}) {
      for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
        if (options.shouldStop?.()) return false;
        const content = await fs.readFile(shardPath(shard), "utf8").catch(() => "");
        if (!content) continue;
        const lines = content.split("\n");
        const seen = new Set<string>();
        let dead = 0;
        let live = 0;
        // 後ろの行ほど新しい。同じ教材の 2 行目以降 (古い版) は飛ばす。
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          if (!lines[index]) continue;
          const record = parseLine(lines[index]);
          if (!record || seen.has(record.fileId)) {
            dead += 1;
            continue;
          }
          seen.add(record.fileId);
          if (options.keep && !options.keep.has(record.fileId)) {
            dead += 1;
            continue;
          }
          live += 1;
          visit(record);
        }
        if (dead >= COMPACT_MIN_DEAD_LINES && dead > live) void compact(shard, options.keep).catch(() => {});
      }
      return true;
    },
    save(record) {
      if (/[\t\n]/.test(record.fileId) || /[\t\n]/.test(record.stamp) || /[\t\n]/.test(record.text)) return Promise.resolve();
      return exclusive(shardOf(record.fileId), async () => {
        await fs.mkdir(directory, { recursive: true });
        await fs.appendFile(shardPath(shardOf(record.fileId)), `\n${record.fileId}\t${record.stamp}\t${record.text.length}\t${record.text}`);
      });
    },
  };
}

function parseLine(line: string): StoredBodyText | null {
  const first = line.indexOf("\t");
  const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
  const third = second < 0 ? -1 : line.indexOf("\t", second + 1);
  if (first <= 0 || third < 0) return null;
  const text = line.slice(third + 1);
  if (Number(line.slice(second + 1, third)) !== text.length) return null;
  return { fileId: line.slice(0, first), stamp: line.slice(first + 1, second), text };
}

/** FNV-1a。教材 ID から束を決める (起動をまたいで同じ束になればよい)。 */
function shardOf(fileId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fileId.length; index += 1) {
    hash ^= fileId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SHARD_COUNT;
}

interface WorkerJob {
  id: number;
  filePath: string;
  resolve: (text: string | null) => void;
}

interface PooledWorker {
  worker: Worker;
  job: WorkerJob | null;
}

/**
 * ローカル教材の本文を読んで文字列にするワーカー。教材の JSON は画像込みで 100MB 近いことがあり、
 * main で解析すると全ウィンドウの IPC が止まるので、読み込みと解析ごと別スレッドで行う。
 * 使っていない間はスレッドを終わらせる。
 */
export class BodyTextWorkerPool {
  private readonly workers: PooledWorker[] = [];
  private readonly queue: WorkerJob[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: { workerPath: string; size?: number; idleMs?: number }) {}

  extract(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, filePath, resolve });
      this.dispatch();
    });
  }

  close(): void {
    this.clearIdle();
    for (const job of this.queue.splice(0)) job.resolve(null);
    for (const pooled of this.workers.splice(0)) {
      pooled.job?.resolve(null);
      void pooled.worker.terminate();
    }
  }

  private dispatch(): void {
    this.clearIdle();
    while (this.queue.length > 0) {
      let pooled = this.workers.find((candidate) => candidate.job === null);
      if (!pooled && this.workers.length < (this.options.size ?? 2)) pooled = this.startWorker();
      if (!pooled) return;
      const job = this.queue.shift()!;
      pooled.job = job;
      pooled.worker.postMessage({ id: job.id, filePath: job.filePath });
    }
    if (this.workers.every((pooled) => pooled.job === null)) {
      this.idleTimer = setTimeout(() => this.close(), this.options.idleMs ?? 30_000);
    }
  }

  private startWorker(): PooledWorker {
    // 画像を含む大きな教材の解析に足りるだけの上限。超えたらその教材だけを諦める。
    const worker = new Worker(this.options.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    const pooled: PooledWorker = { worker, job: null };
    const finish = (text: string | null) => {
      const job = pooled.job;
      pooled.job = null;
      job?.resolve(text);
    };
    worker.on("message", (message: { id?: unknown; text?: unknown }) => {
      if (pooled.job && message.id === pooled.job.id) finish(typeof message.text === "string" ? message.text : null);
      this.dispatch();
    });
    const discard = () => {
      const index = this.workers.indexOf(pooled);
      if (index < 0) return;
      this.workers.splice(index, 1);
      finish(null);
      this.dispatch();
    };
    worker.on("error", discard);
    worker.on("exit", discard);
    worker.unref();
    this.workers.push(pooled);
    return pooled;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export interface WorkspaceBodySearchServiceDeps {
  userDataPath: string;
  workerPath: string;
  /** 全ワークスペースの教材と、見えている共有教材 (検索の一覧と同じもの)。 */
  searchOverview: () => Promise<WorkspaceOverview>;
  documentBodyPath: (file: { fileId: string; documentPath?: string }) => string;
  /** 共有教材の本文 (画像は取らない)。 */
  loadSharedDocument: (fileId: string) => Promise<SigmaDocument | null>;
  /** サインインしている人。替わったら共有教材の索引を捨てる。 */
  sharedScope: () => string | null;
}

export interface WorkspaceBodySearchService {
  open(emit: (update: WorkspaceBodySearchUpdate) => void): WorkspaceBodySearchSession;
  release(session: WorkspaceBodySearchSession): void;
  /** 教材の一覧が変わった。開いている検索は次の検索語で一覧を取り直す。 */
  invalidate(): void;
  close(): void;
}

/**
 * 全教材の本文検索。索引は全ウィンドウで 1 つを共有し、ウィンドウごとの検索欄はセッションになる。
 * ローカル教材の文字列は端末に残して次の起動でも使い、共有教材の文字列はメモリにだけ置く。
 */
export function createWorkspaceBodySearchService(deps: WorkspaceBodySearchServiceDeps): WorkspaceBodySearchService {
  const index = new WorkspaceBodyTextIndex({ store: createBodyTextDiskStore(deps.userDataPath) });
  const pool = new BodyTextWorkerPool({ workerPath: deps.workerPath });
  const sessions = new Set<WorkspaceBodySearchSession>();

  const source = {
    async list(): Promise<BodySearchFile[]> {
      const { files } = await deps.searchOverview();
      return files.map(bodySearchFileFromSummary);
    },
    async readText(file: BodySearchFile): Promise<string | null> {
      if (file.shared) {
        const document = await deps.loadSharedDocument(file.fileId);
        return document ? documentSearchText(document) : null;
      }
      return pool.extract(deps.documentBodyPath(file));
    },
    sharedScope: deps.sharedScope,
  };

  return {
    open(emit) {
      const session = new WorkspaceBodySearchSession(index, source, emit);
      sessions.add(session);
      return session;
    },
    release(session) {
      session.close();
      sessions.delete(session);
    },
    invalidate() {
      for (const session of sessions) session.invalidate();
    },
    close() {
      for (const session of sessions) session.close();
      sessions.clear();
      pool.close();
    },
  };
}
