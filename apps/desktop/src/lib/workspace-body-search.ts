import type { DocumentMetadata } from "@/lib/runtime/types";

import type {
  WorkspaceBodySearchExcerpt,
  WorkspaceBodySearchUpdate,
} from "./workspace-body-search-contract";

// ---------------------------------------------------------------------------
// 照合。題名 (画面) と本文 (索引) の両方が同じ規則で比べる。
// ---------------------------------------------------------------------------

/** 全角英数・半角カナ・丸数字などの書き分けを寄せる。大文字小文字は照合のときに寄せる。 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC");
}

/** 照合用の形 (書き分けと大文字小文字を寄せたもの)。何度も照合する題名は、これを 1 度だけ作っておく。 */
export function toSearchKey(value: string): string {
  return normalizeSearchText(value).toLowerCase();
}

const searchKey = toSearchKey;

/** 空白で区切った語。どれも含むものが一致 (AND)。 */
export function searchTerms(query: string): string[] {
  return searchKey(query).split(/\s+/u).filter(Boolean);
}

export function matchesSearchTerms(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const key = searchKey(text);
  return terms.every((term) => key.includes(term));
}

/** 索引の中で、1 つの教材の本文のブロックの境目に置く記号。保存形式の改行・区切りと混ざらない。 */
const BLOCK_SEPARATOR = "\u001f";

/** 教材から取り出した文字列 (ブロックごとに改行) を、索引に置く形にする。 */
export function toIndexedText(documentText: string): string {
  return normalizeSearchText(documentText).replace(/[\t\r]/g, " ").replace(/\n/g, BLOCK_SEPARATOR);
}

interface TermMatcher {
  term: string;
  find(text: string): { index: number; length: number } | null;
}

/**
 * 索引の文字列は大文字小文字を残したまま持つ (抜粋をそのまま見せるため)。大文字小文字の無い語
 * (日本語・数字) はそのまま、ある語だけ大文字小文字を無視して探す。
 */
function compileTerms(terms: readonly string[]): TermMatcher[] {
  return terms.map((term) => {
    if (term.toUpperCase() === term) {
      return { term, find: (text) => { const index = text.indexOf(term); return index < 0 ? null : { index, length: term.length }; } };
    }
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    return { term, find: (text) => { const found = pattern.exec(text); return found ? { index: found.index, length: found[0].length } : null; } };
  });
}

const EXCERPT_BEFORE = 16;
const EXCERPT_AFTER = 120;

/**
 * 題名と本文を合わせて全部の語を含み、かつ本文に 1 語でも当たったときだけ、本文の中で最初に当たった
 * 語の前後を返す。抜粋は当たったブロックの中に収め、前を削ったときだけ「…」を付ける。後ろは一覧の幅で
 * 薄れて消えるので、ブロックが続く限り長めに渡しておく。
 */
function matchBody(titleKey: string, text: string, matchers: readonly TermMatcher[]): WorkspaceBodySearchExcerpt | null {
  let best: { index: number; length: number } | null = null;
  for (const matcher of matchers) {
    const found = matcher.find(text);
    if (found) {
      if (!best || found.index < best.index) best = found;
    } else if (!titleKey.includes(matcher.term)) {
      return null;
    }
  }
  if (!best) return null;
  const { index, length } = best;
  const blockStart = text.lastIndexOf(BLOCK_SEPARATOR, index - 1) + 1;
  const blockEnd = text.indexOf(BLOCK_SEPARATOR, index + length);
  let start = Math.max(blockStart, index - EXCERPT_BEFORE);
  let end = Math.min(blockEnd < 0 ? text.length : blockEnd, index + length + EXCERPT_AFTER);
  if (isLowSurrogate(text, start)) start -= 1;
  if (isLowSurrogate(text, end)) end += 1;
  return {
    before: detach(`${start > blockStart ? "…" : ""}${text.slice(start, index)}`),
    match: detach(text.slice(index, index + length)),
    after: detach(text.slice(index + length, end)),
  };
}

/**
 * 切り出した文字列を、元の文字列から切り離した複製にする。V8 の部分文字列は元の文字列を指したまま
 * なので、索引の束 (数 MB) から切り出した抜粋を持ち続けると、束がまるごとメモリに残る。
 */
function detach(value: string): string {
  return (` ${value}`).slice(1);
}

function isLowSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

// ---------------------------------------------------------------------------
// 索引。教材ごとの本文の文字列を、本文が変わるまで持ち越す。
// ---------------------------------------------------------------------------

export interface BodySearchFile {
  fileId: string;
  title: string;
  /** ローカル教材の本文ファイルの場所 (台帳の値)。 */
  documentPath?: string;
  /** 本文が変わると変わる印。ローカル教材は版と更新日時。 */
  stamp: string;
  /** 共有教材はサーバーから読むので、印が同じでも一定時間で読み直す (他の人の編集は印に出ないことがある)。 */
  shared: boolean;
  updatedAt: string;
}

export function bodySearchFileFromSummary(file: Pick<DocumentMetadata, "fileId" | "title" | "revision" | "updatedAt" | "sharing" | "documentPath">): BodySearchFile {
  return {
    fileId: file.fileId,
    title: file.title,
    ...(file.documentPath ? { documentPath: file.documentPath } : {}),
    stamp: `${file.revision}:${file.updatedAt}`,
    shared: Boolean(file.sharing),
    updatedAt: file.updatedAt,
  };
}

export interface StoredBodyText {
  fileId: string;
  stamp: string;
  /** `toIndexedText` を通した文字列。 */
  text: string;
}

/**
 * ローカル教材の本文の文字列の置き場。本文の文字列はメモリに抱えず (数万教材で数百 MB になる)、
 * 検索のたびに置き場を頭から読んで照合する。共有教材の本文は置かない (アカウントを替えたら消えるべきもの)。
 */
export interface BodyTextStore {
  /**
   * 教材ごとに最後に置いた文字列を `visit` に渡す。少しずつ読み、合間に `shouldStop` が真なら打ち切って
   * false を返す。`keep` を渡したら、それに無い教材 (削除された教材) は渡さず、置き場からも片付ける。
   */
  scan(visit: (record: StoredBodyText) => void, options?: { keep?: ReadonlySet<string>; shouldStop?: () => boolean }): Promise<boolean>;
  save(record: StoredBodyText): Promise<void>;
}

/** 端末に残さない置き場 (ブラウザ版・テスト)。 */
export function createMemoryBodyTextStore(): BodyTextStore {
  const records = new Map<string, StoredBodyText>();
  return {
    async scan(visit, options = {}) {
      for (const [fileId, record] of [...records]) {
        if (options.shouldStop?.()) return false;
        if (options.keep && !options.keep.has(fileId)) records.delete(fileId);
        else visit(record);
      }
      return true;
    },
    async save(record) {
      records.delete(record.fileId);
      records.set(record.fileId, record);
    },
  };
}

/** 共有教材を読み直すまでの間隔。 */
export const SHARED_BODY_TEXT_TTL_MS = 600_000;
/** 置き場にあるのが一覧と違う版の本文だったことを表す印 (どの教材の印とも一致しない)。 */
const OUTDATED_STAMP = "\u0000outdated";

/**
 * 全教材の本文の索引。メモリに持つのは教材ごとの印 (どの版の本文を置いたか) と共有教材の文字列だけ。
 * 印は最初に置き場を読み通したときに揃い、それまでは「どの教材を読み直すべきか」が決まらない。
 */
export class WorkspaceBodyTextIndex {
  private readonly store: BodyTextStore;
  private readonly localStamps = new Map<string, string>();
  private stampsComplete = false;
  private readonly sharedTexts = new Map<string, { stamp: string; text: string; readAt: number }>();
  private readonly reading = new Map<string, Promise<string | null>>();
  private sharedScope: string | null | undefined;
  private readonly now: () => number;
  private readonly sharedTtlMs: number;

  constructor(deps: { store?: BodyTextStore; now?: () => number; sharedTtlMs?: number } = {}) {
    this.store = deps.store ?? createMemoryBodyTextStore();
    this.now = deps.now ?? Date.now;
    this.sharedTtlMs = deps.sharedTtlMs ?? SHARED_BODY_TEXT_TTL_MS;
  }

  /** 置き場を一度読み通し、どの教材の本文がどの版か分かっている。 */
  get ready(): boolean {
    return this.stampsComplete;
  }

  /** サインインしている人が替わったら、前の人の共有教材の本文を捨てる。 */
  setSharedScope(scope: string | null): void {
    if (this.sharedScope !== undefined && this.sharedScope !== scope) this.sharedTexts.clear();
    this.sharedScope = scope;
  }

  has(fileId: string): boolean {
    return this.localStamps.has(fileId) || this.sharedTexts.has(fileId);
  }

  needsRead(file: BodySearchFile): boolean {
    if (!file.shared) return this.localStamps.get(file.fileId) !== file.stamp;
    const entry = this.sharedTexts.get(file.fileId);
    return !entry || entry.stamp !== file.stamp || this.now() - entry.readAt >= this.sharedTtlMs;
  }

  /**
   * 置いてある本文 (古い版のものも) を、一覧にある教材について順に `visit` へ渡す。最後まで読めたら true。
   * 一覧から消えたローカル教材の本文は、ここで片付ける。
   */
  async scan(
    files: readonly BodySearchFile[],
    visit: (file: BodySearchFile, text: string, stamp: string) => void,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    const listed = new Map(files.map((file) => [file.fileId, file]));
    for (const [fileId, entry] of this.sharedTexts) {
      const file = listed.get(fileId);
      if (file?.shared) visit(file, entry.text, entry.stamp);
    }
    const local = new Set(files.filter((file) => !file.shared).map((file) => file.fileId));
    const completed = await this.store.scan((record) => {
      const file = listed.get(record.fileId);
      if (!file || file.shared) return;
      // 覚えるのは一覧の側の文字列。置き場から切り出した文字列を持つと、束がまるごとメモリに残る。
      // この画面で読んで書き足した印は、読み通しの途中で見た古い行より新しいので上書きしない。
      if (!this.localStamps.has(file.fileId)) this.localStamps.set(file.fileId, record.stamp === file.stamp ? file.stamp : OUTDATED_STAMP);
      visit(file, record.text, record.stamp);
    }, { keep: local.size > 0 ? local : undefined, shouldStop });
    if (completed) {
      this.stampsComplete = true;
      if (local.size > 0) for (const fileId of this.localStamps.keys()) if (!local.has(fileId)) this.localStamps.delete(fileId);
    }
    return completed;
  }

  /** 本文を読んで索引を更新し、索引に置いた形の文字列を返す。同じ教材を同時に 2 度読まない。読めなかったら null。 */
  read(file: BodySearchFile, readText: (file: BodySearchFile) => Promise<string | null>): Promise<string | null> {
    const running = this.reading.get(file.fileId);
    if (running) return running;
    const task = (async () => {
      try {
        const raw = await readText(file);
        if (raw === null) return null;
        const text = toIndexedText(raw);
        if (file.shared) {
          this.sharedTexts.set(file.fileId, { stamp: file.stamp, text, readAt: this.now() });
        } else {
          this.localStamps.set(file.fileId, file.stamp);
          await this.store.save({ fileId: file.fileId, stamp: file.stamp, text }).catch(() => {});
        }
        return text;
      } catch {
        // オフライン・権限の更新中・壊れた教材。前の結果を残し、次の機会に読み直す。
        return null;
      } finally {
        this.reading.delete(file.fileId);
      }
    })();
    this.reading.set(file.fileId, task);
    return task;
  }
}

// ---------------------------------------------------------------------------
// セッション。検索欄が開いている間、索引を作りながら今の検索語の結果を流す。
// ---------------------------------------------------------------------------

export interface BodySearchSource {
  /** 検索の対象 (全ワークスペースの教材と、見えている共有教材)。 */
  list(): Promise<BodySearchFile[]>;
  /** 教材の本文の文字列。教材が無い・読めないときは null。 */
  readText(file: BodySearchFile): Promise<string | null>;
  /** 共有教材を読める人の区別。替わったら共有教材の索引を捨てる。 */
  sharedScope?(): string | null;
}

export interface BodySearchSessionOptions {
  /** ローカル教材はディスクから読んで解析するだけなので、少なく並べる。 */
  localConcurrency?: number;
  /** 共有教材はサーバーとの往復が支配的なので、多めに並べる。 */
  sharedConcurrency?: number;
  /**
   * 教材の一覧を取り直すまでの間隔。既定では取り直さず、`invalidate` されたときだけ取り直す
   * (一覧は台帳を丸ごと読むので、打鍵のたびに取ると main が止まり、入力が遅れる)。
   */
  listTtlMs?: number;
  /** 見つかった教材をまとめて送る間隔。 */
  flushMs?: number;
  now?: () => number;
}

const DEFAULT_LOCAL_CONCURRENCY = 2;
const DEFAULT_SHARED_CONCURRENCY = 6;
const DEFAULT_LIST_TTL_MS = Number.POSITIVE_INFINITY;
const DEFAULT_FLUSH_MS = 250;
/** 教材が変わってから今の検索語で探し直すまでの間 (続けて届く変更の知らせをまとめる)。 */
const RERUN_AFTER_CHANGE_MS = 300;

/**
 * 1 つの検索欄 (画面) に対応する本文検索。
 *
 * 検索語を受けたら、索引に置いてある本文 (古い版のものも) を読み通して照合し、見つかったものから送る。
 * まだ読んでいない・古くなった教材は、検索語に関係なく裏で読み進め、読めたものから今の検索語で照合して
 * 差分で送る (古い版で一致していた教材が外れたら、それも伝える)。検索語を変えても読み進めはやり直さない。
 * 読む順は、まだ一度も読んでいない教材 → 古くなった教材、それぞれ新しく更新されたものから
 * (探している教材は最近のものであることが多い)。
 */
export class WorkspaceBodySearchSession {
  private files: BodySearchFile[] = [];
  private readonly titleKeys = new Map<string, string>();
  private listedAt = Number.NEGATIVE_INFINITY;
  private listing: Promise<void> | null = null;
  /** 読む順に並べた残り。ローカルと共有は別々の枠で同時に読む。 */
  private queues: Record<"local" | "shared", BodySearchFile[]> = { local: [], shared: [] };
  /** 今の一覧について、読む教材が決まった (索引の印が揃ってから決める)。 */
  private queueBuilt = false;
  /** まだ読み終えていない教材。読めなかったものも、このセッションでは読み終えた扱いにする。 */
  private readonly pending = new Set<string>();
  /** このセッションで読み終えた教材と、そのときの印 (印が変わったら読み直す)。 */
  private readonly checked = new Map<string, string>();
  /** このセッションで読み直せた教材と、その印。 */
  private readonly refreshed = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly running = { local: 0, shared: 0 };
  private query: { id: number; text: string; terms: string[]; matchers: TermMatcher[] } | null = null;
  private rerunTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  /** 今の検索語の最初の 1 通をまだ送っていない (送るときは `reset`)。 */
  private resetPending = false;
  /** 今の検索語で画面へ送った一致 (抜粋が変わったかの比較用)。 */
  private readonly reported = new Map<string, string>();
  private readonly outbox = { hits: new Map<string, WorkspaceBodySearchExcerpt>(), removed: new Set<string>() };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPending = -1;
  private closed = false;
  private readonly options: Required<Omit<BodySearchSessionOptions, "now">>;
  private readonly now: () => number;

  constructor(
    private readonly index: WorkspaceBodyTextIndex,
    private readonly source: BodySearchSource,
    private readonly emit: (update: WorkspaceBodySearchUpdate) => void,
    options: BodySearchSessionOptions = {},
  ) {
    this.options = {
      localConcurrency: options.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY,
      sharedConcurrency: options.sharedConcurrency ?? DEFAULT_SHARED_CONCURRENCY,
      listTtlMs: options.listTtlMs ?? DEFAULT_LIST_TTL_MS,
      flushMs: options.flushMs ?? DEFAULT_FLUSH_MS,
    };
    this.now = options.now ?? Date.now;
  }

  async setQuery(queryId: number, query: string): Promise<void> {
    if (this.closed) return;
    const terms = searchTerms(query);
    const generation = ++this.generation;
    this.query = { id: queryId, text: query, terms, matchers: compileTerms(terms) };
    this.reported.clear();
    this.outbox.hits.clear();
    this.outbox.removed.clear();
    this.cancelFlush();
    this.resetPending = true;
    if (terms.length === 0) {
      this.flush();
      // 検索欄に入っただけ (まだ打っていない) なら、一覧だけ先に取っておき、最初の 1 文字で待たせない。
      await this.refresh();
      return;
    }
    await this.refresh();
    if (this.closed || generation !== this.generation) return;
    // 読み通しが長引いても、最初の 1 通 (見つかった分) は間を置かずに送る。
    this.scheduleFlush();
    const completed = await this.index.scan(this.files, (file, text, stamp) => {
      if (generation !== this.generation) return;
      // このセッションで読み直せた教材は、読み通しの途中で見えた古い版より新しい結果を送ってある。
      if (stamp !== file.stamp && this.refreshed.get(file.fileId) === file.stamp) return;
      this.report(file, this.match(file, text));
    }, () => this.closed || generation !== this.generation);
    if (this.closed || generation !== this.generation) return;
    if (completed && !this.queueBuilt) this.buildQueue();
    this.flush();
    this.pump();
  }

  /**
   * 教材が増えた・変わった・消えた。一覧を取り直し、検索中なら今の検索語で探し直す (同じ検索語の
   * `reset` をもう一度送る)。打ち直さなくても、開いたままの検索結果が新しい本文に追いつく。
   */
  invalidate(): void {
    this.listedAt = Number.NEGATIVE_INFINITY;
    if (this.closed || !this.query || this.query.terms.length === 0) return;
    if (this.rerunTimer !== null) clearTimeout(this.rerunTimer);
    this.rerunTimer = setTimeout(() => {
      this.rerunTimer = null;
      const query = this.query;
      if (!this.closed && query && query.terms.length > 0) void this.setQuery(query.id, query.text);
    }, RERUN_AFTER_CHANGE_MS);
  }

  close(): void {
    this.closed = true;
    if (this.rerunTimer !== null) clearTimeout(this.rerunTimer);
    this.rerunTimer = null;
    this.cancelFlush();
    this.queues = { local: [], shared: [] };
  }

  private async refresh(): Promise<void> {
    if (this.now() - this.listedAt < this.options.listTtlMs) return;
    this.listing ??= (async () => {
      try {
        const files = await this.source.list();
        this.index.setSharedScope(this.source.sharedScope?.() ?? null);
        this.files = files;
        this.titleKeys.clear();
        for (const file of files) this.titleKeys.set(file.fileId, searchKey(file.title));
        this.queueBuilt = false;
      } catch {
        // 一覧が取れなければ、前の一覧のまま続ける (最初なら対象なし)。
      } finally {
        this.listedAt = this.now();
        if (!this.queueBuilt && this.index.ready) this.buildQueue();
        this.listing = null;
      }
    })();
    await this.listing;
  }

  private buildQueue(): void {
    const queue = this.files
      .filter((file) => this.index.needsRead(file) && this.checked.get(file.fileId) !== file.stamp)
      .sort((a, b) => Number(this.index.has(a.fileId)) - Number(this.index.has(b.fileId)) || compareUpdatedAtDesc(a, b));
    this.pending.clear();
    for (const file of queue) this.pending.add(file.fileId);
    this.queues = { local: queue.filter((file) => !file.shared), shared: queue.filter((file) => file.shared) };
    this.queueBuilt = true;
  }

  /** 読み残しの数。読む教材がまだ決まっていない間は、一覧の全部を読み残しとみなす。 */
  private pendingCount(): number {
    return this.queueBuilt ? this.pending.size : this.files.length;
  }

  private match(file: BodySearchFile, text: string): WorkspaceBodySearchExcerpt | null {
    if (!this.query) return null;
    return matchBody(this.titleKeys.get(file.fileId) ?? searchKey(file.title), text, this.query.matchers);
  }

  private pump(): void {
    if (this.closed || !this.queueBuilt) return;
    for (const lane of ["local", "shared"] as const) {
      const limit = lane === "shared" ? this.options.sharedConcurrency : this.options.localConcurrency;
      while (this.running[lane] < limit) {
        const file = this.queues[lane].shift();
        if (!file) break;
        if (this.inFlight.has(file.fileId)) continue;
        if (!this.index.needsRead(file)) {
          // 別の画面のセッションが先に読み終えていた。結果は次の検索語の読み通しで拾う。
          this.settle(file, null);
          continue;
        }
        this.running[lane] += 1;
        this.inFlight.add(file.fileId);
        void this.index.read(file, (target) => this.source.readText(target)).then((text) => {
          this.running[lane] -= 1;
          this.inFlight.delete(file.fileId);
          this.settle(file, text);
          this.pump();
        });
      }
    }
  }

  private settle(file: BodySearchFile, text: string | null): void {
    this.checked.set(file.fileId, file.stamp);
    if (text !== null) this.refreshed.set(file.fileId, file.stamp);
    this.pending.delete(file.fileId);
    if (this.closed || !this.query || this.query.terms.length === 0) return;
    // 読めなかったときは、前の版での結果をそのまま残す。
    if (text !== null) this.report(file, this.match(file, text));
    if (this.pending.size === 0) this.flush();
    else this.scheduleFlush();
  }

  private report(file: BodySearchFile, excerpt: WorkspaceBodySearchExcerpt | null): void {
    const previous = this.reported.get(file.fileId);
    if (excerpt) {
      const key = excerptKey(excerpt);
      if (previous === key) return;
      this.reported.set(file.fileId, key);
      this.outbox.hits.set(file.fileId, excerpt);
      this.outbox.removed.delete(file.fileId);
    } else if (previous !== undefined) {
      this.reported.delete(file.fileId);
      this.outbox.removed.add(file.fileId);
      this.outbox.hits.delete(file.fileId);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.options.flushMs);
  }

  private cancelFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private flush(): void {
    this.cancelFlush();
    if (this.closed || !this.query) return;
    const pending = this.query.terms.length === 0 ? 0 : this.pendingCount();
    const reset = this.resetPending;
    if (!reset && this.outbox.hits.size === 0 && this.outbox.removed.size === 0 && pending === this.lastPending) return;
    const hits = [...this.outbox.hits].map(([fileId, excerpt]) => ({ fileId, excerpt }));
    const removed = reset ? [] : [...this.outbox.removed];
    this.outbox.hits.clear();
    this.outbox.removed.clear();
    this.resetPending = false;
    this.lastPending = pending;
    this.emit({ queryId: this.query.id, reset, hits, removed, pending });
  }
}

function excerptKey(excerpt: WorkspaceBodySearchExcerpt): string {
  return `${excerpt.before}\u0000${excerpt.match}\u0000${excerpt.after}`;
}

function compareUpdatedAtDesc(a: BodySearchFile, b: BodySearchFile): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}
