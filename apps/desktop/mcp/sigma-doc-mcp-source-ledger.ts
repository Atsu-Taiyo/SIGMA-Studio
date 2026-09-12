import type { AiSourceReference } from "../electron/local-sigma-doc-proposal-store";

/**
 * run スコープの「参照台帳」。
 *
 * `sourceReferences` は本来モデルが書き込みツール呼び出しに自分で添える任意項目だが、
 * 添え忘れると「何を参照して書いたのか」がユーザーに一切残らない。ここでは実際のツール
 * 利用 (ライブラリ検索のヒット・その後の読み取り・ユーザーのメンション) を記録し、
 * 書き込み時にモデルの自己申告とマージして決定論的に補完する。
 *
 * 「参照した」の定義は意図的に厳しくしてある:
 *
 * - `search_library` でヒットし **かつ その後に本文を読んだ** 教材
 * - ユーザーが明示的にメンションした教材 (読まなくても意図は明らか)
 *
 * 検索ヒットだけで引用扱いにすると、AIが1回検索しただけで無関係な教材が大量にチップ化して
 * しまう。「実際に使ったものだけ」という受入基準に合わせ、読み取りとの積を取る。
 *
 * Codex / Antigravity ではこのMCPサーバープロセスが全 run で共有され長時間常駐するため、
 * 台帳は必ず runId キーで持ち、run 数・run あたり件数の両方に上限を置く。
 */

/** 同時に保持する run 数の上限。超えたら最も古い run から捨てる。 */
export const MCP_SOURCE_LEDGER_RUN_LIMIT = 32;
/** 1 run が貯め込める教材数の上限 (検索ヒット・読み取り・メンションそれぞれに適用)。 */
const MCP_SOURCE_LEDGER_ENTRIES_PER_RUN_LIMIT = 200;

interface RunSourceLedger {
  /** search_library でヒットした fileId → title。 */
  searchHits: Map<string, string | undefined>;
  /** 現在編集中以外の教材を読み取った fileId。 */
  readFileIds: Set<string>;
  /** ユーザーがメンションした fileId → title。 */
  mentioned: Map<string, string | undefined>;
}

export interface SourceLedgerDocument {
  fileId: string;
  title?: string;
}

const ledgers = new Map<string, RunSourceLedger>();

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRunId(runId: string | undefined): string | undefined {
  const trimmed = runId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * runId を持たない呼び出し (外部CLIから直接叩かれた場合など) は記録しない。従来どおり
 * モデルの自己申告だけが参照元になる。
 */
function getOrCreateLedger(runId: string | undefined): RunSourceLedger | null {
  const key = normalizeRunId(runId);
  if (!key) {
    return null;
  }
  const existing = ledgers.get(key);
  if (existing) {
    // アクセス順を保つため入れ直す (Map は挿入順なので、これで LRU として機能する)。
    ledgers.delete(key);
    ledgers.set(key, existing);
    return existing;
  }
  const created: RunSourceLedger = {
    searchHits: new Map(),
    readFileIds: new Set(),
    mentioned: new Map(),
  };
  ledgers.set(key, created);
  evictOldestLedgers();
  return created;
}

function evictOldestLedgers(): void {
  while (ledgers.size > MCP_SOURCE_LEDGER_RUN_LIMIT) {
    const oldestKey = ledgers.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    ledgers.delete(oldestKey);
  }
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MCP_SOURCE_LEDGER_ENTRIES_PER_RUN_LIMIT) {
    return;
  }
  map.set(key, value);
}

function boundedAdd<T>(set: Set<T>, value: T): void {
  if (!set.has(value) && set.size >= MCP_SOURCE_LEDGER_ENTRIES_PER_RUN_LIMIT) {
    return;
  }
  set.add(value);
}

/** search_library のヒットを記録する (この時点ではまだ引用にならない)。 */
export function recordLibrarySearchHits(runId: string | undefined, hits: SourceLedgerDocument[]): void {
  const ledger = getOrCreateLedger(runId);
  if (!ledger) {
    return;
  }
  for (const hit of hits) {
    if (!hit.fileId) {
      continue;
    }
    boundedSet(ledger.searchHits, hit.fileId, normalizeTitle(hit.title));
  }
}

/** 他教材の本文を読んだことを記録する。検索ヒットとの積が引用になる。 */
export function recordDocumentRead(runId: string | undefined, fileId: string | undefined): void {
  if (!fileId) {
    return;
  }
  const ledger = getOrCreateLedger(runId);
  if (!ledger) {
    return;
  }
  boundedAdd(ledger.readFileIds, fileId);
}

/** ユーザーがメンションした教材を記録する。読まれなくても引用になる。 */
export function recordMentionedDocuments(runId: string | undefined, documents: SourceLedgerDocument[]): void {
  const ledger = getOrCreateLedger(runId);
  if (!ledger) {
    return;
  }
  for (const document of documents) {
    if (!document.fileId) {
      continue;
    }
    boundedSet(ledger.mentioned, document.fileId, normalizeTitle(document.title));
  }
}

/**
 * この run で「実際に使った」と言える教材参照を返す。編集対象そのものは常に除外する
 * (自分自身を出典として挙げても意味がない)。
 */
export function collectUsedSourceReferences(
  runId: string | undefined,
  currentFileId: string | undefined,
): AiSourceReference[] {
  const key = normalizeRunId(runId);
  const ledger = key ? ledgers.get(key) : undefined;
  if (!ledger) {
    return [];
  }

  const titlesByFileId = new Map<string, string | undefined>();
  for (const [fileId, title] of ledger.searchHits) {
    if (ledger.readFileIds.has(fileId)) {
      titlesByFileId.set(fileId, title);
    }
  }
  for (const [fileId, title] of ledger.mentioned) {
    // メンション側の title を優先する (ユーザーが見ている名前に近い)。
    titlesByFileId.set(fileId, title ?? titlesByFileId.get(fileId));
  }
  titlesByFileId.delete(currentFileId ?? "");

  return Array.from(titlesByFileId, ([fileId, title]) => ({
    type: "document" as const,
    fileId,
    ...(title ? { title } : {}),
  }));
}

/** run 終了時に台帳を捨てる。呼ばれなくても LRU で追い出されるので必須ではない。 */
export function releaseSourceLedger(runId: string | undefined): void {
  const key = normalizeRunId(runId);
  if (key) {
    ledgers.delete(key);
  }
}

export function clearSourceLedgerForTests(): void {
  ledgers.clear();
}

export function getSourceLedgerRunCountForTests(): number {
  return ledgers.size;
}
