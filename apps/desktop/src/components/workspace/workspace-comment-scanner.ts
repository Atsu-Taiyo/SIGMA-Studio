import { collectUserCommentThreads, type CommentUserIdentity, type SigmaDocument, type UserCommentThread } from "@/features/document";

/** 共有教材の中身は他の人の編集で変わるので、版が同じでも一定時間で読み直す。 */
export const SHARED_RESCAN_MS = 120_000;
/**
 * 自分に関係するスレッドが無かった共有教材の読み直し間隔。教材ごとに全文を取りに行く重い処理で、
 * 関係が生まれる (誰かがメンションする) 機会も少ないので、関係のある教材より長く空ける。
 */
export const IDLE_SHARED_RESCAN_MS = 600_000;
/** ローカル教材はディスクから読むだけなので、共有とは別の枠で並べて読む。 */
export const LOCAL_SCAN_CONCURRENCY = 4;
/** 共有教材はサーバーへの往復が支配的なので、ローカルより多く並べる。 */
export const SHARED_SCAN_CONCURRENCY = 6;
/** 走査中に結果を保存し直す最短の間隔 (終了時は必ず保存する)。 */
const PERSIST_INTERVAL_MS = 3_000;

export interface CommentScanFile {
  fileId: string;
  revision: number;
  updatedAt: string;
  shared: boolean;
}

export interface CommentScanDeps {
  loadLocal: (fileId: string) => Promise<SigmaDocument | null>;
  /** コメントだけが要るので、画像は取得しない読み込みを渡す。 */
  loadShared: (fileId: string) => Promise<SigmaDocument | null>;
  now: () => number;
  /** 前回までの結果の置き場。あれば起動直後から前回の一覧を出し、古いものだけ読み直す。 */
  store?: CommentScanStore;
}

/** 教材 1 つぶんの走査結果。保存してもそのまま読み戻せる形にしておく。 */
export interface CommentScanRecord {
  stamp: string;
  scannedAt: number;
  threads: UserCommentThread[];
}

export interface CommentScanStore {
  load(): Record<string, CommentScanRecord> | null;
  save(records: Record<string, CommentScanRecord>): void;
}

const NO_THREADS: readonly UserCommentThread[] = Object.freeze([]);

/**
 * 全教材のコメントから、自分に関係するスレッド (自分宛てのメンション・自分が書いたコメント) を集める。
 * コメントは教材本文 (SigmaDoc) にしか無いので、教材を 1 つずつ読む。読み直しを減らすため、ローカル教材は版が変わるまで、
 * 共有教材は間隔が経つまで結果を持ち越す。
 *
 * 共有教材はサーバーから全文を取るので、数が多いと走査が長引く。そこで
 * - ローカル (速い) と共有 (遅い) は別々の枠で同時に進め、ローカルが共有の後ろで待たないようにする。
 * - 共有は、関係のある教材の読み直し → まだ読んでいない教材 → 関係の無かった教材の順に読む。
 * - 関係の無かった共有教材の読み直しは長く空ける (`IDLE_SHARED_RESCAN_MS`)。
 * 1 つの教材が読めなくても他へ影響させず、前回の結果があればそれを残す。
 */
export class WorkspaceCommentScanner {
  private readonly cache = new Map<string, CommentScanRecord>();
  private dirty = false;
  private savedAt = 0;

  constructor(private readonly identity: CommentUserIdentity, private readonly deps: CommentScanDeps) {
    for (const [fileId, record] of Object.entries(deps.store?.load() ?? {})) this.cache.set(fileId, record);
  }

  /** いまの一覧に載っている教材の結果だけを返す。 */
  snapshot(files: readonly CommentScanFile[]): Map<string, readonly UserCommentThread[]> {
    const result = new Map<string, readonly UserCommentThread[]>();
    for (const file of files) {
      const entry = this.cache.get(file.fileId);
      if (entry && entry.threads.length > 0) result.set(file.fileId, entry.threads);
    }
    return result;
  }

  async scan(
    files: readonly CommentScanFile[],
    options: { signal: AbortSignal; sharedTtlMs?: number; onProgress?: () => void },
  ): Promise<void> {
    const listed = new Set(files.map((file) => file.fileId));
    for (const fileId of this.cache.keys()) {
      if (!listed.has(fileId)) {
        this.cache.delete(fileId);
        this.dirty = true;
      }
    }
    const now = this.deps.now();
    const ttl = options.sharedTtlMs ?? SHARED_RESCAN_MS;
    const stale = files.filter((file) => this.isStale(file, now, ttl));
    const local = stale.filter((file) => !file.shared);
    const shared = stale.filter((file) => file.shared).sort((a, b) => this.sharedRank(a) - this.sharedRank(b) || this.scannedAt(a) - this.scannedAt(b));
    try {
      await Promise.all([
        this.drain(local, LOCAL_SCAN_CONCURRENCY, options),
        this.drain(shared, SHARED_SCAN_CONCURRENCY, options),
      ]);
    } finally {
      this.persist(true);
    }
  }

  private async drain(
    queue: CommentScanFile[],
    concurrency: number,
    options: { signal: AbortSignal; onProgress?: () => void },
  ): Promise<void> {
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        if (options.signal.aborted) return;
        await this.scanFile(file);
        if (options.signal.aborted) continue;
        this.persist(false);
        options.onProgress?.();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  private isStale(file: CommentScanFile, now: number, sharedTtlMs: number): boolean {
    const entry = this.cache.get(file.fileId);
    if (!entry || entry.stamp !== stampOf(file)) return true;
    if (!file.shared) return false;
    const interval = entry.threads.length > 0 ? sharedTtlMs : Math.max(sharedTtlMs, IDLE_SHARED_RESCAN_MS);
    return now - entry.scannedAt >= interval;
  }

  /** 0: 関係のあるスレッドがある / 1: まだ読んでいない / 2: 読んだが関係は無かった。 */
  private sharedRank(file: CommentScanFile): number {
    const entry = this.cache.get(file.fileId);
    if (!entry) return 1;
    return entry.threads.length > 0 ? 0 : 2;
  }

  private scannedAt(file: CommentScanFile): number {
    return this.cache.get(file.fileId)?.scannedAt ?? 0;
  }

  private async scanFile(file: CommentScanFile): Promise<void> {
    const previous = this.cache.get(file.fileId);
    let threads: UserCommentThread[] | undefined;
    try {
      const document = await (file.shared ? this.deps.loadShared(file.fileId) : this.deps.loadLocal(file.fileId));
      if (document) threads = collectUserCommentThreads(document.comments, this.identity);
    } catch {
      // 一時的な失敗 (オフライン・権限の更新中) は、前回の結果を残して次の機会に読み直す。
    }
    this.cache.set(file.fileId, {
      stamp: stampOf(file),
      scannedAt: this.deps.now(),
      threads: threads ?? (previous ? previous.threads : [...NO_THREADS]),
    });
    this.dirty = true;
  }

  private persist(force: boolean): void {
    const store = this.deps.store;
    if (!store || !this.dirty) return;
    const now = this.deps.now();
    if (!force && now - this.savedAt < PERSIST_INTERVAL_MS) return;
    this.savedAt = now;
    this.dirty = false;
    store.save(Object.fromEntries(this.cache));
  }
}

function stampOf(file: CommentScanFile): string {
  return `${file.revision}:${file.updatedAt}`;
}
