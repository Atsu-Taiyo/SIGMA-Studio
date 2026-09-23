import { mkdirSync, watch, type FSWatcher, type WatchEventType } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  parseSigmaDocument,
  recoverSigmaDocument,
  type SigmaDocumentRecoveryIssue,
  type SigmaDocumentSchemaFailure,
} from "@/lib/sigma-doc-schema";
import { createId } from "@/lib/id";
import {
  ensurePageLayout,
  pruneUnusedDocumentOverlayAssets,
  type SigmaDocument,
} from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import {
  createSingleGroupWorkspaceLayout,
  normalizeWorkspaceLayout,
  workspaceLayoutOpenFileIds,
  type WorkspaceLayoutV2,
} from "@/lib/workspace-tab-groups";
import {
  availableDocumentTitle,
  type LibraryFileRow as LocalFileRecord,
  type LibraryFolderRow as LocalFolderRecord,
  type LibraryWorkspaceRow as LocalWorkspaceRecord,
} from "@/lib/library-ledger";
import { DEFAULT_DOCUMENT_TITLE, resolveDocumentTitle } from "@/lib/document-title";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import {
  appendBlockHashRevision,
  readBlockHashRevisions,
} from "./block-hash-sidecar";
import {
  LIBRARY_VERSION,
  type LedgerSchemaFailure,
  type LedgerSchemaViolation,
} from "@/lib/library-schema";
import { getLocksDir, getLogsDir, logLedgerEvent } from "./ledger-log";
import { acquireFileLock, type FileLockHandle } from "./file-lock";
import { LedgerSchemaError, toLedgerSchemaFailure } from "./ledger-schema-error";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  shouldCaptureDocumentVersion,
  type DocumentVersion,
  type DocumentVersionMetadata,
  type DocumentVersionOrigin,
} from "@/lib/document-version-history";
import {
  appendDocumentVersion,
  deleteDocumentVersions,
  readDocumentVersion,
  readLatestDocumentVersionMetadata,
  readDocumentVersionMetadata,
} from "./document-version-sidecar";
import { isValidDocumentFileId } from "./document-file-id";
import {
  createEmptyLibrary,
  normalizeFolderName,
  normalizeWorkspaceName,
  parseLibrary,
  type LibraryParseOutcome,
  type LocalLibraryRecord,
} from "./local-library-record";

import { LocalDocumentReconciler } from "./local-document-reconciler";
import { LocalStoreWriteIdentity } from "./local-store-write-identity";
import type { LocalStoreChangeEvent } from "./local-store-change-events";

export type { LocalStoreChangeEvent } from "./local-store-change-events";

const te = createCurrentLocaleTranslator("error");

const DATA_DIR_NAME = "data";
const DOCUMENTS_DIR_NAME = "documents";
const DOC_BLOCK_HASHES_DIR_NAME = "doc-block-hashes";
const DOC_VERSIONS_DIR_NAME = "doc-versions";
const RECOVERY_DIR_NAME = "recovery";
const LIBRARY_FILE_NAME = "library.json";
// library.json の直前の(正常にパースできた)世代を保持するローリングバックアップ。
// writeLibrary が library.json を上書きする直前に、その時点までの既知良好バイトを
// ここへ退避する。library.json 自体が読めない/パースできない時の復元元になる。
const LIBRARY_BACKUP_FILE_NAME = "library.json.bak";
const WORKSPACE_FILE_NAME = "workspace.json";
const WORKSPACE_RECORD_ID = "default";
const DOCUMENT_FILE_SUFFIX = ".sigmadoc.json";
const WATCH_DEBOUNCE_MS = 120;
const DEFAULT_WATCH_RETRY_BASE_MS = 250;
const DEFAULT_WATCH_MAX_RETRIES = 3;
// saveDocument が成功するたびに sidecar へ revision ごとのブロックハッシュを積む。
// 際限なく増え続けないよう、直近のこの件数だけ残して古いものは剪定する。

// adoptOrphanDocumentFiles が1回のensureLibraryで再登録する教材数の上限。
// 極端に大量の孤児ファイルが見つかった場合に無限に時間をかけないための安全弁。
const MAX_ADOPTED_DOCUMENTS = 500;
// reconcileDocumentFile が「行はあるが本文がまだ書けていない」新規作成直後の行を
// 外部削除と誤診断してソフトデリートしてしまわないための猶予時間 (ms)。
// 作成経路をledger row-first順にしたこと(#B4)で生じる短い窓を吸収する。
// テストで上書きできるよう、コンストラクタのoptionsで差し替え可能にしてある。
const DEFAULT_MISSING_BODY_GRACE_MS = 10_000;
// library.json 用のクロスプロセスロックファイル名。data/locks/ 直下に置く
// (data/ 直下ではない — ledger-log.ts の置き場所の制約を参照)。
const LIBRARY_LOCK_FILE_NAME = "library.lock";
// withLedger の in-process 直列化に使う、runExclusive の予約済みキー。fileId は
// すべて createId("file") = "file_<uuid>" 形式なので、この値とは絶対に衝突しない。
const LEDGER_MUTEX_KEY = "\u0000ledger-transaction-mutex";

export interface LocalDocumentMetadata {
  sharingPending?: boolean;
  sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata;
  fileId: string;
  workspaceId: string;
  folderId: string | null;
  docId: string;
  title: string;
  documentPath?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalWorkspaceState {
  openFileIds: string[];
  activeFileId: string;
  layout?: WorkspaceLayoutV2;
}

export interface LocalWorkspaceSummary {
  sharingPending?: boolean;
  sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalFolderSummary {
  sharingPending?: boolean;
  sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata;
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export type LocalWorkspaceFileSummary = LocalDocumentMetadata;

export interface LocalWorkspaceOverview {
  catalog?: import("@/lib/runtime/shared-catalog").SharedCatalogStatus;
  activeWorkspaceId: string;
  workspaces: LocalWorkspaceSummary[];
  folders: LocalFolderSummary[];
  files: LocalWorkspaceFileSummary[];
}

export type LocalWorkspaceOverviewResult =
  | { state: "error"; error: string }
  | { state: "ledger-schema-error"; failure: LedgerSchemaFailure }
  | { state: "ready"; overview: LocalWorkspaceOverview };

export interface LocalStorageResult {
  ok: boolean;
  error?: string;
  /** saveDocument の楽観ロック失敗時のみ: "revision-mismatch"。 */
  code?: "revision-mismatch";
  /** code === "revision-mismatch" のとき、実際に格納されていた revision。 */
  currentRevision?: number;
  /** saveDocument 成功時のみ: 保存直後のファイル revision (呼び出し元が再度 listFiles しなくて済むように)。 */
  revision?: number;
  versionCaptured?: boolean;
  /** Canonical save succeeded, but its best-effort history sidecar capture failed. */
  versionCaptureError?: string;
  /** Canonical delete succeeded, but its best-effort history sidecar cleanup failed. */
  versionCleanupError?: string;
}

/**
 * 読み込み失敗の分類。UI はこれを見て「教材タブは開いたまま原因を中央に出す」
 * (json/schema) か、単に切り替える (missing/io) かを決める。
 */
export type LocalDocumentLoadFailureKind = "missing" | "json" | "schema" | "io";

export type LocalDocumentLoadResult =
  | {
      ok: true;
      document: SigmaDocument;
      revision: number;
      recoveryIssues: SigmaDocumentRecoveryIssue[];
      recoveryBackupPath?: string;
    }
  | {
      ok: false;
      error: string;
      failureKind?: LocalDocumentLoadFailureKind;
      /** failureKind: "schema" のとき、スキーマに合わなかった箇所の内訳。 */
      failures?: SigmaDocumentSchemaFailure[];
      /** 教材本文JSONの絶対パス (AIへ渡す修復プロンプトの入力になる)。 */
      documentPath?: string;
      title?: string;
    };

export interface SaveDocumentOptions {
  /**
   * payloadを構築した時点で観測した revision。保存直前の値ではない。
   * 保存時の台帳 revision と一致しない場合は必ず拒否し、無条件上書き経路は提供しない。
   */
  expectedRevision: number;
  origin?: DocumentVersionOrigin;
}

export interface CaptureDocumentVersionOptions {
  expectedRevision: number;
  origin: DocumentVersionOrigin;
}

/** doc-block-hashes/<encodedFileId>.blockhashes.jsonl の中身 (revision → ハッシュ表)。 */
export interface DocumentBlockHashHistory {
  fileId: string;
  /** revision (数値をJSONキー化した文字列) → その時点の id→ハッシュ 対応表。 */
  revisions: Record<string, Record<string, string>>;
}

type LibraryBackupRestoreResult =
  | { status: "restored"; library: LocalLibraryRecord; repaired: boolean }
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "schema-violation"; violations: LedgerSchemaViolation[] };

interface LocalWorkspaceFileCreateResult {
  file: LocalDocumentMetadata;
  document: SigmaDocument;
  recoveryIssues?: SigmaDocumentRecoveryIssue[];
  recoveryBackupPath?: string;
}

interface InitializeWorkspacePayload {
  initialDocument?: SigmaDocument;
}

interface CreateDocumentPayload {
  title?: string;
  workspaceId?: string | null;
  folderId?: string | null;
}

interface CreateFileFromDocumentPayload {
  document: SigmaDocument;
  workspaceId?: string | null;
  folderId?: string | null;
}

interface UpdateFolderPayload {
  name?: string;
  parentFolderId?: string | null;
}

export interface LocalSigmaDocStoreOptions {
  /**
   * reconcileDocumentFile が「本文が読めない」行を外部削除とみなしてソフトデリート
   * するまでの猶予時間 (ms)。作成直後でまだ本文が書き込まれていないだけの行を
   * 誤って消してしまわないための窓。省略時は DEFAULT_MISSING_BODY_GRACE_MS。
   */
  missingBodyGraceMs?: number;
  /**
   * library.json のクロスプロセスロック (data/locks/library.lock) のチューニング。
   * 省略時は file-lock.ts の既定値 (staleMs=10s, timeoutMs=15s, heartbeatMs=2s)。
   * テストで待ち時間を短縮する目的以外では通常触らない。
   */
  ledgerLock?: { staleMs?: number; timeoutMs?: number; heartbeatMs?: number };
  /** fs.watch failure recovery tuning and injection seam for focused tests. */
  watchFactory?: LocalWatchFactory;
  watchRetryBaseMs?: number;
  watchMaxRetries?: number;
  /** Version sidecar fault-injection seam. Canonical saves must not depend on this succeeding. */
  appendDocumentVersion?: typeof appendDocumentVersion;
  /** Version sidecar fault-injection seam. Canonical deletes must not depend on this succeeding. */
  deleteDocumentVersions?: typeof deleteDocumentVersions;
}

export type LocalWatchFactory = (
  filename: string,
  options: { persistent: boolean },
  listener: (eventType: WatchEventType, filename: string | Buffer | null) => void,
) => FSWatcher;

/** withLedger が fn へ渡す、進行中の台帳トランザクションのハンドル。 */
interface LedgerTransaction {
  /** このトランザクションが読み込んだ (必要なら repair 済みの) 台帳。 */
  library: LocalLibraryRecord;
  /** fn が library を変更した場合に呼ぶ。呼ばれていれば、トランザクションの
   * 一番外側が完了する際に一度だけ writeLibrary が走る (ネストしている間は
   * 何も起きない — 一番外側でだけ実際に書き込む)。 */
  markChanged(): void;
}

/** AsyncLocalStorage で追跡する、進行中の台帳トランザクションの内部状態。 */
interface LedgerTransactionState {
  library: LocalLibraryRecord;
  changed: boolean;
}

/** Application-owned authority runs before any local ledger lock. Undefined means local. */
export type LibraryAuthority = {
  [K in "initializeWorkspace" | "saveWorkspace" | "listFiles" | "getWorkspaceOverview" | "createFileFromDocument" | "duplicateFile" | "deleteFile" | "renameWorkspace" | "deleteWorkspace" | "createFolder" | "updateFolder" | "deleteFolder" | "moveFileToFolder" | "moveFileToWorkspace"]: (...args: Parameters<LocalSigmaDocStore[K]>) => Promise<Awaited<ReturnType<LocalSigmaDocStore[K]>> | undefined>;
};

export class LocalSigmaDocStore {
  private libraryAuthority?: Partial<LibraryAuthority>;
  private readonly rawLibraryContext = new AsyncLocalStorage<boolean>();
  setLibraryAuthority(authority: Partial<LibraryAuthority>): void { this.libraryAuthority = authority; }
  /** Main-only adapter projection/initialization. Never exposed through IPC. */
  withLocalLibrary<T>(run: () => Promise<T>): Promise<T> { return this.rawLibraryContext.run(true, run); }

  private documentAuthority?: {
    read(fileId: string): Promise<SigmaDocument | undefined>;
    save(fileId: string, document: SigmaDocument): Promise<LocalStorageResult | undefined>;
  };
  setDocumentAuthority(authority: NonNullable<LocalSigmaDocStore["documentAuthority"]>): void { this.documentAuthority = authority; }
  private readonly dataDir: string;
  private readonly documentsDir: string;
  private readonly docBlockHashesDir: string;
  private readonly docVersionsDir: string;
  /**
   * ブロックハッシュ履歴の行数 (fileId ごと)。追記のたびにファイルを数え直さないための memo。
   * プロセス起動後の初回保存でだけ実ファイルを数える。
   */
  private readonly blockHashLineCounts = new Map<string, number>();
  private readonly versionLineCounts = new Map<string, number>();
  private readonly writeIdentity = new LocalStoreWriteIdentity({
    readFile: (filePath) => fs.readFile(filePath, "utf8"),
    stat: (filePath) => fs.stat(filePath),
  });
  private readonly documentReconciler: LocalDocumentReconciler;
  private readonly recoveryDir: string;
  private readonly libraryPath: string;
  private readonly libraryBackupPath: string;
  private readonly libraryLockPath: string;
  private readonly workspacePath: string;
  private readonly ledgerLockOptions: { staleMs?: number; timeoutMs?: number; heartbeatMs?: number };
  private readonly watchFactory: LocalWatchFactory;
  private readonly watchRetryBaseMs: number;
  private readonly watchMaxRetries: number;
  private readonly appendDocumentVersion: typeof appendDocumentVersion;
  private readonly deleteDocumentVersions: typeof deleteDocumentVersions;
  // readLibraryFileWithReport が最後に正常パースできた生バイト列 (library.json
  // 本体、あるいは .bak からの復元時はその生バイト列)。writeLibrary はこれを
  // library.json.bak へ退避してから library.json を上書きする (ローリングバックアップ)。
  private lastGoodLibraryRaw: string | null = null;
  // 直前に実際に .bak へ書き込んだ内容。lastGoodLibraryRaw と一致する間は
  // 書き込み済みなので、同じ内容で.bakを何度も書き直さないための節約用。
  private lastBackedUpLibraryRaw: string | null = null;
  private watchTimers = new Map<string, NodeJS.Timeout>();
  // per-fileId の非同期直列化キュー (runExclusive)。値は「そのfileIdの直前のタスクが
  // 完了した(成功/失敗いずれでも)ことを表す、常に resolve するマーカー」。
  private readonly fileLockQueues = new Map<string, Promise<unknown>>();
  // AsyncLocalStorage で「現在の非同期呼び出し連鎖が保持している fileId ロックの集合」を
  // 追跡する。saveDocument() は自身の内部でも runExclusive を通すため、承認フロー側が
  // 「読込→鮮度確認→replay→保存」をまとめて runExclusive で囲うと、その中からの
  // saveDocument が同じfileIdへ二重にロックを取りに行き自己デッドロックする。同じ連鎖内
  // からの再入だけをバイパスし、別連鎖 (人間の自動保存IPC等) からの呼び出しは実行中でも
  // 必ずキューに並ばせる (呼び出し連鎖を区別しない「実行中フラグ」では相互排除が壊れる)。
  private readonly heldLocks = new AsyncLocalStorage<Set<string>>();
  // 「現在の非同期呼び出し連鎖が、台帳(library.json)のread-modify-writeトランザクションの
  // 中にいるか」を追跡する。withLedger がこれを見て、既に中にいれば (ネスト呼び出し)
  // 再ロック・再読込せず同じ in-memory library に対して fn を直接実行する (join)。
  // これが ensureLibrary/saveWorkspaceWithLibrary のネスト呼び出しを安全にする仕組み:
  // 別の連鎖 (別の runExclusive(fileId) 呼び出し等) からは必ずここが空なので、
  // 通常通りロックを取りに行く。
  private readonly ledgerTransactionStorage = new AsyncLocalStorage<LedgerTransactionState>();

  constructor(userDataPath: string, options: LocalSigmaDocStoreOptions = {}) {
    this.dataDir = path.join(userDataPath, DATA_DIR_NAME);
    this.documentsDir = path.join(this.dataDir, DOCUMENTS_DIR_NAME);
    this.docBlockHashesDir = path.join(this.dataDir, DOC_BLOCK_HASHES_DIR_NAME);
    this.docVersionsDir = path.join(this.dataDir, DOC_VERSIONS_DIR_NAME);
    this.recoveryDir = path.join(this.dataDir, RECOVERY_DIR_NAME);
    this.libraryPath = path.join(this.dataDir, LIBRARY_FILE_NAME);
    this.libraryBackupPath = path.join(this.dataDir, LIBRARY_BACKUP_FILE_NAME);
    this.libraryLockPath = path.join(getLocksDir(this.dataDir), LIBRARY_LOCK_FILE_NAME);
    this.workspacePath = path.join(this.dataDir, WORKSPACE_FILE_NAME);
    const missingBodyGraceMs = options.missingBodyGraceMs ?? DEFAULT_MISSING_BODY_GRACE_MS;
    this.ledgerLockOptions = options.ledgerLock ?? {};
    this.watchFactory = options.watchFactory ?? (watch as LocalWatchFactory);
    this.watchRetryBaseMs = Math.max(1, options.watchRetryBaseMs ?? DEFAULT_WATCH_RETRY_BASE_MS);
    this.watchMaxRetries = Math.max(0, options.watchMaxRetries ?? DEFAULT_WATCH_MAX_RETRIES);
    this.appendDocumentVersion = options.appendDocumentVersion ?? appendDocumentVersion;
    this.deleteDocumentVersions = options.deleteDocumentVersions ?? deleteDocumentVersions;
    this.documentReconciler = new LocalDocumentReconciler({
      withLedger: (operation) => this.withLedger("reconcileDocumentFile", (tx) => operation({
        findVisibleFile: (fileId) => this.findVisibleFile(tx.library, fileId),
        replaceFile: (file) => this.replaceFile(tx.library, file),
        write: () => this.writeLibrary(tx.library),
      })),
      listVisibleFileIds: () => this.withLedgerRead(async (library) => {
        return this.getVisibleFiles(library).map((file) => file.fileId);
      }),
      resolveDocumentPath: (file) => this.resolveDocumentPath(file),
      readDocument: (filePath) => fs.readFile(filePath, "utf8"),
      writeRecoveryBackup: (fileId, raw) => this.writeRecoveryBackup(fileId, raw),
      writeIdentity: this.writeIdentity,
      missingBodyGraceMs,
      log: (event, details) => logLedgerEvent(this.dataDir, event, details),
    });
  }

  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * 同じ fileId に対する処理を直列化する非同期ミューテックス。saveDocument() は内部で
   * これを使って自分自身のsave処理を保護する。main.ts の承認フロー (approveSingleProposal
   * 等) は「最新doc読込→鮮度確認→replay→saveDocument」という一連の read-modify-write を
   * まとめて runExclusive で囲むことで、その間に他の保存(人間の自動保存や別の承認)が
   * 割り込まないようにする。
   *
   * 再入判定は AsyncLocalStorage で「同じ非同期呼び出し連鎖の中でこの fileId のロックを
   * 既に保持しているか」を追跡して行う: 承認フローが runExclusive の中から saveDocument
   * (内部でまた runExclusive) を呼んでも自己デッドロックせず即実行される一方、**別の**
   * 呼び出し連鎖 (人間の自動保存IPCなど) からの呼び出しは、たとえロックが実行中でも
   * 必ずキューに並んで先行タスクの完了を待つ (単純な「実行中フラグ」判定だと後者まで
   * バイパスしてしまい相互排除が壊れる)。
   */
  async runExclusive<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    // ロック順序の不変条件: runExclusive(fileId) → withLedger の順序だけを許す
    // (逆は禁止)。saveDocument 等は必ずこの順で呼ぶこと。もし withLedger の
    // コールバック (台帳トランザクション進行中) から新規に fileId ロックを取ろうと
    // すると、他の連鎖が「fileIdロック→台帳ロック待ち」で止まっている場合に
    // 相互デッドロックし得る。開発時にすぐ気付けるよう、ここで早期に落とす
    // (LEDGER_MUTEX_KEY 自身の取得は withLedger の内部実装なので対象外)。
    if (
      process.env.NODE_ENV !== "production" &&
      fileId !== LEDGER_MUTEX_KEY &&
      this.ledgerTransactionStorage.getStore() !== undefined
    ) {
      throw new Error(
        `ロック順序不変条件違反: 台帳トランザクション実行中に fileId ロック ("${fileId}") を` +
        " 新規に取得しようとしました。runExclusive(fileId) は必ず withLedger より外側で先に取得してください。",
      );
    }
    const held = this.heldLocks.getStore();
    if (held?.has(fileId)) {
      // 同じ連鎖内からの再入のみバイパス。
      return fn();
    }
    const prior = this.fileLockQueues.get(fileId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => {
      const nextHeld = new Set(held ?? []);
      nextHeld.add(fileId);
      return this.heldLocks.run(nextHeld, fn);
    });
    // 次の呼び出しが待つキューの末尾は「常に resolve するマーカー」にする。run 自体の
    // 失敗理由は呼び出し元に(returnしたrunを通じて)そのまま伝わる。
    this.fileLockQueues.set(fileId, run.catch(() => undefined));
    return run;
  }

  /**
   * library.json に対する read-modify-write を1つの単位として直列化する。
   *
   * - 既に台帳トランザクションが進行中の連鎖からの呼び出し (nested ensureLibrary /
   *   saveWorkspaceWithLibrary など) は **join** する: 同じ in-memory library を
   *   そのまま fn へ渡し、再ロック・再読込・再書き込みは一切行わない。そうしないと
   *   自己デッドロックするか、直前の(まだ書き出していない)変更を握り潰して
   *   ディスクから読み直してしまう。
   * - そうでなければ: in-process の直列化 (runExclusive を予約キーで再利用) →
   *   クロスプロセスのファイルロック (data/locks/library.lock) → 台帳の読込+repair
   *   (ensureLibrary、あるいは skipEnsure 指定時は素の読込) → fn → fn が
   *   markChanged() を呼んでいれば最後に一度だけ writeLibrary、の順で実行する。
   *
   * ロック順序の不変条件: runExclusive(fileId) → withLedger の順序を必ず守ること
   * (逆は禁止)。saveDocument はこの順で呼んでいる。
   */
  private async withLedger<T>(
    op: string,
    fn: (tx: LedgerTransaction) => Promise<T>,
    options: { skipEnsure?: boolean; initialDocument?: SigmaDocument } = {},
  ): Promise<T> {
    const existingState = this.ledgerTransactionStorage.getStore();
    if (existingState) {
      const tx: LedgerTransaction = {
        library: existingState.library,
        markChanged: () => {
          existingState.changed = true;
        },
      };
      return fn(tx);
    }

    return this.runExclusive(LEDGER_MUTEX_KEY, async () => {
      await this.ensureBaseDirs();

      let lock: FileLockHandle;
      try {
        lock = await acquireFileLock(this.libraryLockPath, {
          op,
          staleMs: this.ledgerLockOptions.staleMs,
          timeoutMs: this.ledgerLockOptions.timeoutMs,
          heartbeatMs: this.ledgerLockOptions.heartbeatMs,
          onStaleLockBroken: (info) => {
            logLedgerEvent(this.dataDir, "ledger-lock-broken", { op, ...info });
          },
        });
      } catch (error) {
        logLedgerEvent(this.dataDir, "ledger-lock-timeout", {
          op,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      try {
        const library = options.skipEnsure
          ? (await this.readLibraryFile()) ?? createEmptyLibrary()
          : await this.ensureLibrary(options.initialDocument);
        const state: LedgerTransactionState = { library, changed: false };
        return await this.ledgerTransactionStorage.run(state, async () => {
          const tx: LedgerTransaction = {
            library: state.library,
            markChanged: () => {
              state.changed = true;
            },
          };
          const result = await fn(tx);
          if (state.changed) {
            await this.writeLibrary(state.library);
          }
          return result;
        });
      } finally {
        await lock.release();
      }
    });
  }

  /**
   * library.json の読み取り専用アクセス。**ロックを一切取らない** — writeLibrary が
   * tmp書き込み+renameのアトミック置換であるため、ロック無しで読んでも「トアリング」
   * (書きかけの不完全な内容)を見ることはなく、常に「更新前の完全な内容」か
   * 「更新後の完全な内容」のどちらかになる。
   *
   * ただし読み込んだ内容が「ensureLibraryの自動修復が必要な状態」
   * (可視ワークスペースが無い/アクティブワークスペースが不可視/アクティブ
   * ワークスペースにファイルが0件) であれば、その場では直さず withLedger へ
   * 昇格して初めて実際の修復・書き込みを行う。listFiles・loadDocument・
   * 定常状態の getWorkspaceOverview (MCPが高頻度で呼ぶ) など、ホットな読み取り
   * パスをロックフリーに保つためにこの設計にしている。
   */
  private async withLedgerRead<T>(fn: (library: LocalLibraryRecord) => Promise<T>): Promise<T> {
    const existingState = this.ledgerTransactionStorage.getStore();
    if (existingState) {
      return fn(existingState.library);
    }
    await this.ensureBaseDirs();
    const loaded = await this.readLibraryFileWithReport();
    const library = loaded?.library ?? createEmptyLibrary();
    // 可視性の3条件に加えて、行レベルの修復/隔離が発生した読込 (loaded.repaired)
    // でも昇格する。ensureLibrary は昔から「修復が起きた読込は次の書き込み機会に
    // 便乗してディスクへも書き戻す」自己修復をしており、これは listFiles 等の
    // 単純な読み取り経路からの呼び出しでも常に成立していた挙動 — 3181件の既存
    // テストの一部がこれに依存しているため、ホットパスの条件を可視性の3条件だけに
    // 絞ると既存挙動が壊れる。修復が起きるのは異常系 (壊れた/古い行) の初回読込
    // だけなので、定常状態のホットパスがロックフリーであるという狙いは変わらない。
    if (loaded?.repaired || this.libraryNeedsEnsureWrite(library)) {
      return this.withLedger("ensureLibrary", async (tx) => fn(tx.library));
    }
    return fn(library);
  }

  /** withLedgerRead が「ロック無し読み取りのままで良いか、withLedger へ昇格すべきか」
   * を判定する同期述語。ensureLibrary が自動修復する条件のうち、放置すると
   * ユーザーへ実害が出るもの (可視ワークスペース無し/アクティブワークスペースが
   * 不可視/アクティブワークスペースにファイルが0件) だけに意図的に絞ってある。 */
  private libraryNeedsEnsureWrite(library: LocalLibraryRecord): boolean {
    if (!this.hasAnyVisibleWorkspace(library)) {
      return true;
    }
    const activeWorkspace = this.findVisibleWorkspace(library, library.activeWorkspaceId);
    if (!activeWorkspace) {
      return true;
    }
    return !library.files.some((file) => file.workspaceId === library.activeWorkspaceId);
  }

  async initializeWorkspace(payload: InitializeWorkspacePayload = {}): Promise<LocalWorkspaceState> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.initializeWorkspace?.(payload);
      if (managed !== undefined) return managed;
    }
    return this.withLedger(
      "initializeWorkspace",
      async (tx) => this.readWorkspace(tx.library),
      { initialDocument: payload.initialDocument },
    );
  }

  async listFiles(): Promise<LocalDocumentMetadata[]> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.listFiles?.();
      if (managed !== undefined) return managed;
    }
    return this.withLedgerRead(async (library) => {
      return this.getVisibleFiles(library).map(mapFileMetadata).sort(compareFileUpdatedAt);
    });
  }

  async loadDocument(fileId: string): Promise<SigmaDocument | null> {
    const result = await this.loadDocumentWithRecovery(fileId);
    return result.ok ? result.document : null;
  }

  async loadDocumentWithRecovery(fileId: string): Promise<LocalDocumentLoadResult> {
    const managed = this.rawLibraryContext.getStore() ? undefined : await this.documentAuthority?.read(fileId);
    if (managed) return { ok: true, document: managed, revision: 1, recoveryIssues: [] };
    return this.withLedgerRead(async (library) => {
      const file = this.findVisibleFile(library, fileId);
      if (!file) {
        return { ok: false, error: te("electron.storage.documentNotFound"), failureKind: "missing" };
      }

      const documentPath = this.resolveDocumentPath(file);
      try {
        const raw = await fs.readFile(documentPath, "utf8");
        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error
              ? te("electron.storage.invalidJsonWithDetail", { detail: error.message })
              : te("electron.storage.invalidJson"),
            failureKind: "json",
            documentPath,
            title: file.title,
          };
        }
        const recovered = recoverSigmaDocument(input);
        if (!recovered.ok) {
          return {
            ...recovered,
            failureKind: "schema",
            documentPath,
            title: file.title,
          };
        }
        const document = ensurePageLayout(recovered.document);
        if (recovered.issues.length === 0) {
          return { ok: true, document, revision: file.revision, recoveryIssues: [] };
        }
        const recoveryBackupPath = await this.writeRecoveryBackup(fileId, raw);
        return {
          ok: true,
          document,
          revision: file.revision,
          recoveryIssues: recovered.issues,
          recoveryBackupPath,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : te("electron.storage.loadFailed"),
          failureKind: "io",
          documentPath,
          title: file.title,
        };
      }
    });
  }

  async listDocumentVersions(fileId: string): Promise<DocumentVersionMetadata[]> {
    return this.runExclusive(fileId, async () => this.withLedger("listDocumentVersions", async (tx) => {
      if (!this.findVisibleFile(tx.library, fileId)) return [];
      return (await readDocumentVersionMetadata(this.docVersionsDir, fileId, {
        onIndexTailRecovered: (recovery) => this.logDocumentVersionIndexRecovery(fileId, recovery),
      })).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    }, { skipEnsure: true }));
  }

  async getDocumentVersion(fileId: string, versionId: string): Promise<DocumentVersion | null> {
    return this.runExclusive(fileId, async () => this.withLedger("getDocumentVersion", async (tx) => {
      if (!this.findVisibleFile(tx.library, fileId)) return null;
      const version = await readDocumentVersion(this.docVersionsDir, fileId, versionId, {
        onIndexTailRecovered: (recovery) => this.logDocumentVersionIndexRecovery(fileId, recovery),
      });
      if (!version) return null;
      try {
        return { ...version, document: ensurePageLayout(parseSigmaDocument(version.document)) };
      } catch {
        return null;
      }
    }, { skipEnsure: true }));
  }

  async captureDocumentVersion(
    fileId: string,
    document: SigmaDocument,
    options: CaptureDocumentVersionOptions,
  ): Promise<{ ok: boolean; version?: DocumentVersionMetadata; error?: string }> {
    return this.runExclusive(fileId, async () => this.withLedger("captureDocumentVersion", async (tx) => {
      const file = this.findVisibleFile(tx.library, fileId);
      if (!file) return { ok: false, error: te("electron.storage.saveTargetNotFound") };
      if (file.revision !== options.expectedRevision) {
        return { ok: false, error: te("electron.storage.revisionConflict") };
      }
      let now = new Date().toISOString();
      const normalized = ensurePageLayout(parseSigmaDocument(document));
      const latestMetadata = await readLatestDocumentVersionMetadata(this.docVersionsDir, fileId, {
        onIndexTailRecovered: (recovery) => this.logDocumentVersionIndexRecovery(fileId, recovery),
      });
      if (latestMetadata && now <= latestMetadata.capturedAt) {
        now = new Date(Date.parse(latestMetadata.capturedAt) + 1).toISOString();
      }
      const latest = latestMetadata
        ? await readDocumentVersion(this.docVersionsDir, fileId, latestMetadata.versionId)
        : null;
      if (!shouldCaptureDocumentVersion({
        previousDocument: latest?.document ?? null,
        latestVersionDocument: latest?.document ?? null,
        nextDocument: normalized,
        latestVersion: latestMetadata,
        origin: options.origin,
        nowMs: Date.parse(now),
        force: true,
      })) return { ok: true };
      const version: DocumentVersion = {
        versionId: createId("version"),
        revision: file.revision,
        capturedAt: now,
        origin: options.origin,
        document: normalized,
      };
      await this.appendDocumentVersion(this.docVersionsDir, fileId, version, this.versionLineCounts, {
        onIndexTailRecovered: (recovery) => this.logDocumentVersionIndexRecovery(fileId, recovery),
      });
      const versionMetadata: DocumentVersionMetadata = {
        versionId: version.versionId,
        revision: version.revision,
        capturedAt: version.capturedAt,
        origin: version.origin,
      };
      return { ok: true, version: versionMetadata };
    }));
  }

  async saveDocument(
    fileId: string,
    document: SigmaDocument,
    options: SaveDocumentOptions,
  ): Promise<LocalStorageResult> {
    const managed = this.rawLibraryContext.getStore() ? undefined : await this.documentAuthority?.save(fileId, document);
    if (managed) return managed;
    // ロック順序の不変条件: fileId ロックを必ず先に取り、その内側で台帳トランザクション
    // (withLedger) を開始する。逆順にすると他の呼び出しとデッドロックし得る。
    return this.runExclusive(fileId, async () => {
      const currentAuthority = this.rawLibraryContext.getStore() ? undefined : await this.documentAuthority?.save(fileId, document);
      if (currentAuthority) return currentAuthority;
      return this.withLedger("saveDocument", async (tx) => {
        try {
          const library = tx.library;
          const file = this.findVisibleFile(library, fileId);
          if (!file) {
            return { ok: false, error: te("electron.storage.saveTargetNotFound") };
          }
          if (file.revision !== options.expectedRevision) {
            logLedgerEvent(this.dataDir, "document-save-revision-mismatch", {
              fileId,
              expectedRevision: options.expectedRevision,
              currentRevision: file.revision,
            });
            return {
              ok: false,
              code: "revision-mismatch",
              currentRevision: file.revision,
              error: te("electron.storage.revisionConflict"),
            };
          }

          const now = new Date().toISOString();
          let previousDocument: SigmaDocument | null = null;
          try {
            previousDocument = ensurePageLayout(parseSigmaDocument(JSON.parse(
              await fs.readFile(this.resolveDocumentPath(file), "utf8"),
            )));
          } catch {
            // 本文の通常保存を妨げない。読み込み不能なら比較不能として初版を作れる。
          }
          const normalized = pruneUnusedDocumentOverlayAssets(ensurePageLayout(parseSigmaDocument({
            ...document,
            updatedAt: document.updatedAt ?? now,
          })));
          const nextFile: LocalFileRecord = {
            ...file,
            docId: normalized.docId,
            title: resolveDocumentTitle(normalized),
            documentPath: getDocumentPath(file.fileId),
            revision: Math.max(0, file.revision) + 1,
            updatedAt: normalized.updatedAt ?? now,
          };
          // 書き込み順序の不変条件: 台帳の行の存在は本文の存在に絶対に遅れてはならない
          // (行の中身が遅れるのは構わない)。ここは更新経路 — 行は既に存在しており本文が
          // 真実の情報源なので、本文を先に書く (createFileFromDocument の作成経路とは逆)。
          // writeLibrary がここで失敗しても、残るのは古いタイトル/revisionのままの行
          // だけで、次の reconcile が追いつく。
          await this.writeDocumentForFile(nextFile, normalized);
          this.replaceFile(library, nextFile);
          this.touchWorkspace(library, nextFile.workspaceId, now);
          await this.writeLibrary(library);
          await this.writeBlockHashSidecar(fileId, nextFile.revision, computeDocumentBlockHashes(normalized));
          let versionCaptured = false;
          let versionCaptureError: string | undefined;
          try {
            const latestMetadata = await readLatestDocumentVersionMetadata(this.docVersionsDir, fileId, {
              onIndexTailRecovered: (recovery) => this.logDocumentVersionIndexRecovery(fileId, recovery),
            });
            const capturedAt = latestMetadata && now <= latestMetadata.capturedAt
              ? new Date(Date.parse(latestMetadata.capturedAt) + 1).toISOString()
              : now;
            const origin = options.origin ?? "user";
            const latest = latestMetadata && (origin === "tab-switch" || origin === "app-close")
              ? await readDocumentVersion(this.docVersionsDir, fileId, latestMetadata.versionId)
              : null;
            if (shouldCaptureDocumentVersion({
              previousDocument,
              latestVersionDocument: latest?.document ?? null,
              nextDocument: normalized,
              latestVersion: latestMetadata,
              origin,
              nowMs: Date.parse(capturedAt),
            })) {
              await this.appendDocumentVersion(this.docVersionsDir, fileId, {
                versionId: createId("version"),
                revision: nextFile.revision,
                capturedAt,
                origin,
                document: normalized,
              }, this.versionLineCounts, {
                onIndexTailRecovered: (recovery) => this.logDocumentVersionIndexRecovery(fileId, recovery),
              });
              versionCaptured = true;
            }
          } catch (error) {
            versionCaptureError = error instanceof Error ? error.message : String(error);
            logLedgerEvent(this.dataDir, "document-version-capture-failed", {
              fileId,
              revision: nextFile.revision,
              error: versionCaptureError,
            });
          }
          return { ok: true, revision: nextFile.revision, versionCaptured, versionCaptureError };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : te("electron.storage.saveFailed"),
          };
        }
      });
    });
  }

  /**
   * doc-block-hashes/<encodedFileId>.blockhashes.jsonl を読む。読み取り専用の履歴で、
   * MCP側(後続タスク)が「提案が触ったブロックが、提案作成時点から実際に変わったか」を
   * 過去のrevisionまで遡って確認するために使う想定。ファイルが無い/壊れている場合は null。
   */
  async readDocumentBlockHashes(fileId: string): Promise<DocumentBlockHashHistory | null> {
    const revisions = await readBlockHashRevisions(this.docBlockHashesDir, fileId);
    return revisions ? { fileId, revisions } : null;
  }



  /**
   * tmp書き込み→fsync→rename の耐クラッシュ書き込み。renameの後、そのメタデータ変更
   * (ディレクトリエントリの更新) 自体をディスクへ確実に反映させるため、ディレクトリの
   * fsyncをベストエフォートで試みる。Windowsではディレクトリを"r"でopenしての
   * fsyncがEPERM/EISDIRで失敗することがあるため、これは失敗しても書き込み自体を
   * 失敗させない (ベストエフォート)。tmpファイル自体の書き込み/fsync/renameのいずれかが
   * 失敗した場合は、必ずtmpファイルを掃除してから例外を再送出する (.tmpを残さない)。
   */
  private async writeFileDurable(targetPath: string, data: string): Promise<string | null> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    let writtenStatToken: string | null = null;
    try {
      await fs.writeFile(temporaryPath, data, "utf8");
      const handle = await fs.open(temporaryPath, "r+");
      try {
        await handle.sync();
        // 自己エコー判定用の目印は **rename する前に**、いま書いた実体そのものから採る。
        // rename 後に対象パスを stat すると、その隙間に外部が書き換えたファイルの
        // (size, mtime, ino) を「自分の書き込み」として憶えてしまい、以後その変更を
        // 本文も読まずに握り潰す。rename は ino/size/mtime を保つので、tmp の fd から
        // 採った値は rename 後の対象と一致する。
        const stat = await handle.stat();
        writtenStatToken = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      const dirHandle = await fs.open(path.dirname(targetPath), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // ベストエフォート: Windowsはディレクトリのopen/fsyncでEPERM/EISDIRを
      // 投げることがある。ここでの失敗は書き込み自体の成否に影響させない。
    }
    return writtenStatToken;
  }

  /**
   * ブロックハッシュ履歴を 1 行追記する (形式は `block-hash-sidecar.ts` が唯一の出典)。
   *
   * 以前は「履歴ファイル全体を読む → 展開 → pretty で書き直す」を毎保存やっていた。
   * 1,500 ブロックの教材では 1 revision あたり約 165KB で、100 revision 残す設計なので
   * 保存のたびに十数 MB を読み書きしていた (文書サイズ × 履歴長に比例)。
   *
   * 行数はプロセス内で数える。数え直すのは起動後の初回だけで、その 1 回はファイル全体を
   * 読む — 以前は毎保存で払っていたコストなので実質 1/N になる。
   */
  private async writeBlockHashSidecar(
    fileId: string,
    revision: number,
    hashes: Record<string, string>,
  ): Promise<void> {
    await appendBlockHashRevision(
      this.docBlockHashesDir,
      fileId,
      revision,
      hashes,
      this.blockHashLineCounts,
    );
  }

  async createDocument(payload: CreateDocumentPayload = {}): Promise<LocalWorkspaceFileCreateResult> {
    const title = normalizeDocumentTitle(payload.title);
    const document = createBlankDocument(title);
    return this.createFileFromDocument({
      document,
      workspaceId: payload.workspaceId,
      folderId: payload.folderId,
    });
  }

  async createFileFromDocument(payload: CreateFileFromDocumentPayload): Promise<LocalWorkspaceFileCreateResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.createFileFromDocument?.(payload);
      if (managed !== undefined) return managed;
    }
    return this.withLedger("createFileFromDocument", async (tx) => {
      const library = tx.library;
      // workspaceId 省略時は、既存の優先ワークスペースをローカル保存先に使う。
      const targetWorkspaceId = payload.workspaceId
        ?? this.getPreferredActiveWorkspace(library)?.id
        ?? this.restoreOrCreateDefaultWorkspace(library, true).id;
      const workspace = this.resolveWorkspace(library, targetWorkspaceId);
      const folderId = this.resolveFolderId(library, workspace.id, payload.folderId ?? null);
      const now = new Date().toISOString();
      const normalized = pruneUnusedDocumentOverlayAssets(ensurePageLayout(parseSigmaDocument({
        ...payload.document,
        updatedAt: payload.document.updatedAt ?? now,
      })));
      const requestedTitle = resolveDocumentTitle(normalized);
      const title = availableDocumentTitle(requestedTitle, library.files, { workspaceId: workspace.id, folderId });
      if (title !== requestedTitle) normalized.metadata = { ...normalized.metadata, title };
      const file: LocalFileRecord = {
        fileId: createId("file"),
        workspaceId: workspace.id,
        folderId,
        docId: normalized.docId,
        title,
        documentPath: "",
        revision: 1,
        createdAt: normalized.updatedAt ?? now,
        updatedAt: normalized.updatedAt ?? now,
        deletedAt: null,
      };
      file.documentPath = getDocumentPath(file.fileId);

      // 書き込み順序の不変条件: 台帳の行の存在は本文の存在に絶対に遅れてはならない
      // (行の中身が遅れるのは構わない)。作成経路では行を先に書く — writeDocumentForFile
      // が途中でクラッシュ/失敗しても「本文が無いことが分かる可視の行」が残るだけで
      // 済み (loadDocumentWithRecovery が診断可能なエラーを返す)、"台帳に載っていない
      // 孤児本文" (実際に7件の教材が消えた事故の形そのもの) にはならない。
      library.files.push(file);
      this.touchWorkspace(library, workspace.id, now);
      await this.writeLibrary(library);
      await this.writeDocumentForFile(file, normalized);
      await this.touchLibraryMtimeAfterCreate();
      await this.saveWorkspaceWithLibrary({
        openFileIds: [file.fileId],
        activeFileId: file.fileId,
      });
      return { file: mapFileMetadata(file), document: normalized };
    }, { initialDocument: payload.document });
  }

  async duplicateFile(fileId: string): Promise<LocalWorkspaceFileCreateResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.duplicateFile?.(fileId);
      if (managed !== undefined) return managed;
    }
    const sourceFile = await this.withLedgerRead(async (library) =>
      this.findVisibleFile(library, fileId));
    if (!sourceFile) {
      throw new Error(te("electron.storage.duplicateNotFound"));
    }
    const source = await this.loadDocument(fileId);
    if (!source) {
      throw new Error(te("electron.storage.duplicateLoadFailed"));
    }

    const now = new Date().toISOString();
    const document = ensurePageLayout({
      ...cloneDocument(source),
      docId: createId("doc"),
      metadata: {
        ...source.metadata,
        title: `${resolveDocumentTitle(source)} のコピー`,
      },
      updatedAt: now,
    });
    return this.createFileFromDocument({
      document,
      workspaceId: sourceFile.workspaceId,
      folderId: sourceFile.folderId,
    });
  }

  async deleteFile(fileId: string, options?: { expectedRevision: number }): Promise<LocalStorageResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.deleteFile?.(fileId, options);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("deleteFile", async (tx) => {
        const library = tx.library;
        const file = this.findVisibleFile(library, fileId);
        if (!file) {
          return { ok: false, error: te("electron.storage.deleteNotFound") };
        }

        if (options && file.revision !== options.expectedRevision) {
          return { ok: false, code: "revision-mismatch", currentRevision: file.revision, error: te("electron.storage.revisionConflict") };
        }

        const now = new Date().toISOString();
        const nextFile = {
          ...file,
          deletedAt: now,
          updatedAt: now,
        };
        this.replaceFile(library, nextFile);
        this.touchWorkspace(library, file.workspaceId, now);
        await this.writeLibrary(library);
        const visibleFiles = this.getVisibleFiles(library);
        if (visibleFiles.length > 0) {
          const workspace = await this.readWorkspace(library);
          const availableFileIds = new Set(visibleFiles.map((item) => item.fileId));
          const openFileIds = workspace.openFileIds.filter((id) => id !== fileId && availableFileIds.has(id));
          const activeFileId = availableFileIds.has(workspace.activeFileId)
            ? workspace.activeFileId
            : openFileIds[0] ?? visibleFiles[0]?.fileId;
          if (activeFileId && (workspace.openFileIds.includes(fileId) || workspace.activeFileId === fileId)) {
            const nextOpenFileIds = openFileIds.length > 0 ? openFileIds : [activeFileId];
            await this.saveWorkspaceWithLibrary({
              openFileIds: nextOpenFileIds,
              activeFileId,
              ...(workspace.layout ? {
                layout: normalizeWorkspaceLayout(workspace.layout, nextOpenFileIds, activeFileId, availableFileIds),
              } : {}),
            });
          }
        }

        let versionCleanupError: string | undefined;
        try {
          await this.deleteDocumentVersions(this.docVersionsDir, fileId);
        } catch (error) {
          versionCleanupError = error instanceof Error ? error.message : String(error);
          logLedgerEvent(this.dataDir, "document-version-cleanup-failed", {
            fileId,
            error: versionCleanupError,
          });
        }

        return { ok: true, ...(versionCleanupError ? { versionCleanupError } : {}) };
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.storage.deleteFailed"),
      };
    }
  }

  private logDocumentVersionIndexRecovery(
    fileId: string,
    recovery: { indexPath: string; kind: string; discardedBytes: number },
  ): void {
    logLedgerEvent(this.dataDir, "document-version-index-tail-recovered", {
      fileId,
      indexPath: recovery.indexPath,
      kind: recovery.kind,
      discardedBytes: recovery.discardedBytes,
    });
  }

  async saveWorkspace(state: LocalWorkspaceState): Promise<LocalStorageResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.saveWorkspace?.(state);
      if (managed !== undefined) return managed;
    }
    try {
      await this.withLedger("saveWorkspace", async () => {
        await this.saveWorkspaceWithLibrary(state);
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.storage.workspaceStateSaveFailed"),
      };
    }
  }

  /** Metadata-only adapter input. Never changes selected workspace or reads document bodies. */
  async getLocalLibrarySnapshot(): Promise<LocalWorkspaceOverview> {
    return this.withLedgerRead(async library => {
      const overview = this.createWorkspaceOverview(library, library.activeWorkspaceId);
      return { ...overview, folders: this.getVisibleWorkspaces(library).flatMap(w => this.createWorkspaceOverview(library, w.id).folders), files: this.getVisibleFiles(library).map(mapFileMetadata) };
    });
  }

  async getWorkspaceOverview(
    workspaceId?: string | null,
  ): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.getWorkspaceOverview?.(workspaceId);
      if (managed !== undefined) return managed;
    }
    try {
      // 定常状態 (MCPが高頻度で呼ぶ) ではロックを一切取らない: activeWorkspaceId が
      // 既に解決先と一致していれば書き込みは要らないので、そのまま読み取り専用で返す。
      // 実際に更新が必要な時だけ withLedger へ昇格し、他プロセスとの競合から守る
      // (renameWorkspace 等のフル書き換えとの競合で新規行が巻き戻る事故を防ぐ)。
      return await this.withLedgerRead(async (library) => {
        const workspace = this.resolveWorkspace(library, workspaceId);
        if (library.activeWorkspaceId === workspace.id) {
          return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
        }
        return this.withLedger("getWorkspaceOverview", async (tx) => {
          const txLibrary = tx.library;
          const txWorkspace = this.resolveWorkspace(txLibrary, workspaceId);
          if (txLibrary.activeWorkspaceId !== txWorkspace.id) {
            txLibrary.activeWorkspaceId = txWorkspace.id;
            tx.markChanged();
          }
          return { state: "ready", overview: this.createWorkspaceOverview(txLibrary, txWorkspace.id) };
        });
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.workspaceLoadFailed"));
    }
  }

  async createWorkspace(name: string): Promise<LocalWorkspaceOverviewResult> {
    try {
      return await this.withLedger("createWorkspace", async (tx) => {
        const library = tx.library;
        const now = new Date().toISOString();
        const workspace: LocalWorkspaceRecord = {
          id: createId("workspace"),
          name: normalizeWorkspaceName(name),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        library.workspaces.push(workspace);
        library.activeWorkspaceId = workspace.id;
        tx.markChanged();
        return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.workspaceCreateFailed"));
    }
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.renameWorkspace?.(workspaceId, name);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("renameWorkspace", async (tx) => {
        const library = tx.library;
        const workspace = this.findVisibleWorkspace(library, workspaceId);
        if (!workspace) {
          return { state: "error", error: te("electron.storage.workspaceNotFound") };
        }
        const now = new Date().toISOString();
        const nextWorkspace = {
          ...workspace,
          name: normalizeWorkspaceName(name),
          updatedAt: now,
        };
        this.replaceWorkspace(library, nextWorkspace);
        tx.markChanged();
        return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.workspaceRenameFailed"));
    }
  }

  async deleteWorkspace(workspaceId: string): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.deleteWorkspace?.(workspaceId);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("deleteWorkspace", async (tx) => {
        const library = tx.library;
        const workspace = this.findVisibleWorkspace(library, workspaceId);
        if (!workspace) {
          return { state: "error", error: te("electron.storage.workspaceNotFound") };
        }
        const remainingWorkspaces = this.getVisibleWorkspaces(library)
          .filter((item) => item.id !== workspaceId);
        if (remainingWorkspaces.length === 0) {
          return { state: "error", error: te("electron.storage.lastWorkspace") };
        }

        const now = new Date().toISOString();
        library.folders = library.folders.map((folder) =>
          folder.workspaceId === workspaceId && !folder.deletedAt
            ? { ...folder, deletedAt: now, updatedAt: now }
            : folder);
        library.files = library.files.map((file) =>
          file.workspaceId === workspaceId && !file.deletedAt
            ? { ...file, deletedAt: now, updatedAt: now }
            : file);
        this.replaceWorkspace(library, { ...workspace, deletedAt: now, updatedAt: now });

        const nextActiveWorkspace = this.getPreferredActiveWorkspace(library);
        library.activeWorkspaceId = nextActiveWorkspace?.id ?? "";
        await this.writeLibrary(library);

        const visibleFiles = this.getVisibleFiles(library);
        if (visibleFiles.length > 0) {
          const workspaceState = await this.readWorkspace(library);
          const availableFileIds = new Set(visibleFiles.map((item) => item.fileId));
          const openFileIds = workspaceState.openFileIds.filter((id) => availableFileIds.has(id));
          const activeFileId = availableFileIds.has(workspaceState.activeFileId)
            ? workspaceState.activeFileId
            : openFileIds[0] ?? visibleFiles.find((item) => item.workspaceId === nextActiveWorkspace?.id)?.fileId ?? visibleFiles[0]?.fileId;
          if (activeFileId) {
            const nextOpenFileIds = openFileIds.length > 0 ? openFileIds : [activeFileId];
            await this.saveWorkspaceWithLibrary({
              openFileIds: nextOpenFileIds,
              activeFileId,
              ...(workspaceState.layout ? {
                layout: normalizeWorkspaceLayout(workspaceState.layout, nextOpenFileIds, activeFileId, availableFileIds),
              } : {}),
            });
          }
        }

        return {
          state: "ready",
          overview: this.createWorkspaceOverview(library, library.activeWorkspaceId),
        };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.workspaceDeleteFailed"));
    }
  }

  async createFolder(
    workspaceId: string,
    name: string,
    parentFolderId?: string | null,
  ): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.createFolder?.(workspaceId, name, parentFolderId);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("createFolder", async (tx) => {
        const library = tx.library;
        const workspace = this.resolveWorkspace(library, workspaceId);
        const parentId = this.resolveFolderId(library, workspace.id, parentFolderId ?? null);
        const now = new Date().toISOString();
        const folder: LocalFolderRecord = {
          id: createId("folder"),
          workspaceId: workspace.id,
          parentFolderId: parentId,
          name: normalizeFolderName(name),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        library.folders.push(folder);
        this.touchWorkspace(library, workspace.id, now);
        tx.markChanged();
        return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.folderCreateFailed"));
    }
  }

  async updateFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateFolderPayload,
  ): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.updateFolder?.(workspaceId, folderId, patch);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("updateFolder", async (tx) => {
        const library = tx.library;
        const workspace = this.resolveWorkspace(library, workspaceId);
        const folder = this.findVisibleFolder(library, workspace.id, folderId);
        if (!folder) {
          return { state: "error", error: te("electron.storage.folderNotFound") };
        }

        const parentFolderId = patch.parentFolderId === undefined
          ? folder.parentFolderId
          : this.resolveFolderId(library, workspace.id, patch.parentFolderId);
        if (parentFolderId && this.isFolderDescendant(library, workspace.id, parentFolderId, folder.id)) {
          return { state: "error", error: te("electron.storage.invalidFolderMove") };
        }

        const now = new Date().toISOString();
        const nextFolder: LocalFolderRecord = {
          ...folder,
          name: patch.name === undefined ? folder.name : normalizeFolderName(patch.name),
          parentFolderId,
          updatedAt: now,
        };
        this.replaceFolder(library, nextFolder);
        this.touchWorkspace(library, workspace.id, now);
        tx.markChanged();
        return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.folderUpdateFailed"));
    }
  }

  async deleteFolder(workspaceId: string, folderId: string): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.deleteFolder?.(workspaceId, folderId);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("deleteFolder", async (tx) => {
        const library = tx.library;
        const workspace = this.resolveWorkspace(library, workspaceId);
        const folder = this.findVisibleFolder(library, workspace.id, folderId);
        if (!folder) {
          return { state: "error", error: te("electron.storage.folderNotFound") };
        }
        const hasChildFolder = library.folders.some((item) =>
          item.workspaceId === workspace.id && item.parentFolderId === folderId && !item.deletedAt);
        const hasFile = library.files.some((item) =>
          item.workspaceId === workspace.id && item.folderId === folderId && !item.deletedAt);
        if (hasChildFolder || hasFile) {
          return { state: "error", error: te("electron.storage.nonEmptyFolder") };
        }

        const now = new Date().toISOString();
        this.replaceFolder(library, { ...folder, deletedAt: now, updatedAt: now });
        this.touchWorkspace(library, workspace.id, now);
        tx.markChanged();
        return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.folderDeleteFailed"));
    }
  }

  async moveFileToFolder(
    workspaceId: string,
    fileId: string,
    folderId?: string | null,
  ): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.moveFileToFolder?.(workspaceId, fileId, folderId);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("moveFileToFolder", async (tx) => {
        const library = tx.library;
        const workspace = this.resolveWorkspace(library, workspaceId);
        const file = this.findVisibleFile(library, fileId);
        if (!file || file.workspaceId !== workspace.id) {
          return { state: "error", error: te("electron.storage.documentNotFound") };
        }
        const targetFolderId = this.resolveFolderId(library, workspace.id, folderId ?? null);
        const now = new Date().toISOString();
        this.replaceFile(library, {
          ...file,
          folderId: targetFolderId,
          updatedAt: now,
        });
        this.touchWorkspace(library, workspace.id, now);
        tx.markChanged();
        return { state: "ready", overview: this.createWorkspaceOverview(library, workspace.id) };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.documentMoveFailed"));
    }
  }

  async moveFileToWorkspace(
    fileId: string,
    targetWorkspaceId: string,
    folderId?: string | null,
  ): Promise<LocalWorkspaceOverviewResult> {
    if (!this.rawLibraryContext.getStore()) {
      const managed = await this.libraryAuthority?.moveFileToWorkspace?.(fileId, targetWorkspaceId, folderId);
      if (managed !== undefined) return managed;
    }
    try {
      return await this.withLedger("moveFileToWorkspace", async (tx) => {
        const library = tx.library;
        const file = this.findVisibleFile(library, fileId);
        if (!file) {
          return { state: "error", error: te("electron.storage.documentNotFound") };
        }
        const targetWorkspace = this.resolveWorkspace(library, targetWorkspaceId);
        const targetFolderId = this.resolveFolderId(library, targetWorkspace.id, folderId ?? null);
        const now = new Date().toISOString();
        this.replaceFile(library, {
          ...file,
          workspaceId: targetWorkspace.id,
          folderId: targetFolderId,
          updatedAt: now,
        });
        this.touchWorkspace(library, file.workspaceId, now);
        this.touchWorkspace(library, targetWorkspace.id, now);
        library.activeWorkspaceId = targetWorkspace.id;
        await this.writeLibrary(library);
        await this.saveWorkspaceWithLibrary({
          openFileIds: [file.fileId],
          activeFileId: file.fileId,
        });
        return {
          state: "ready",
          overview: this.createWorkspaceOverview(library, targetWorkspace.id),
        };
      });
    } catch (error) {
      return this.toOverviewFailure(error, te("electron.storage.documentWorkspaceMoveFailed"));
    }
  }

  private toOverviewFailure(
    error: unknown,
    fallback: string,
  ): LocalWorkspaceOverviewResult {
    const failure = toLedgerSchemaFailure(error);
    return failure
      ? { state: "ledger-schema-error", failure }
      : { state: "error", error: error instanceof Error ? error.message : fallback };
  }

  watch(onChange: (event: LocalStoreChangeEvent) => void): () => void {
    this.ensureBaseDirsSync();
    type WatchScope = "documents" | "library";
    type WatchListener = (eventType: WatchEventType, filename: string | Buffer | null) => void;
    const watchers = new Map<WatchScope, FSWatcher>();
    const retryTimers = new Set<NodeJS.Timeout>();
    let stopped = false;

    const startWatcher = (
      scope: WatchScope,
      targetPath: string,
      listener: WatchListener,
      retryAttempt = 0,
    ) => {
      if (stopped) {
        return;
      }
      let watcher: FSWatcher;
      try {
        watcher = this.watchFactory(targetPath, { persistent: true }, listener);
      } catch (error) {
        handleWatcherFailure(scope, targetPath, listener, retryAttempt, error);
        return;
      }
      watchers.set(scope, watcher);
      if (retryAttempt > 0) {
        logLedgerEvent(this.dataDir, "local-store-watch-restarted", { scope, retryAttempt });
      }
      watcher.on("error", (error) => {
        if (stopped || watchers.get(scope) !== watcher) {
          return;
        }
        watchers.delete(scope);
        watcher.close();
        handleWatcherFailure(scope, targetPath, listener, retryAttempt, error);
      });
    };

    const handleWatcherFailure = (
      scope: WatchScope,
      targetPath: string,
      listener: WatchListener,
      retryAttempt: number,
      error: unknown,
    ) => {
      if (stopped) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logLedgerEvent(this.dataDir, "local-store-watch-failed", {
        scope,
        retryAttempt,
        error: errorMessage,
      });
      if (retryAttempt >= this.watchMaxRetries) {
        logLedgerEvent(this.dataDir, "local-store-watch-permanently-failed", {
          scope,
          retryAttempt,
          error: errorMessage,
        });
        onChange({ type: "watcher", scope, change: "failed", timestamp: Date.now() });
        return;
      }
      const delay = this.watchRetryBaseMs * (2 ** retryAttempt);
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        startWatcher(scope, targetPath, listener, retryAttempt + 1);
      }, delay);
      retryTimers.add(timer);
    };
    const schedule = (key: string, callback: () => void) => {
      const current = this.watchTimers.get(key);
      if (current) {
        clearTimeout(current);
      }
      const timer = setTimeout(() => {
        this.watchTimers.delete(key);
        callback();
      }, WATCH_DEBOUNCE_MS);
      this.watchTimers.set(key, timer);
    };

    const watchDocumentFile = (filename: string | Buffer | null) => {
      if (!filename) {
        schedule("documents", () => void this.reconcileAllDocumentFiles(onChange));
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(DOCUMENT_FILE_SUFFIX)) {
        return;
      }
      const fileId = decodeDocumentFileName(name);
      if (!fileId) {
        return;
      }
      schedule(`document:${fileId}`, () => void this.reconcileDocumentFile(fileId, onChange));
    };

    startWatcher("documents", this.documentsDir, (_event, filename) => watchDocumentFile(filename));
    startWatcher("library", this.dataDir, (_event, filename) => {
      if (!filename) {
        schedule("library", () => void (async () => {
          const [libraryIsInternal, workspaceIsInternal] = await Promise.all([
            this.writeIdentity.matchesFile(this.libraryPath),
            this.writeIdentity.matchesFile(this.workspacePath),
          ]);
          if (libraryIsInternal && workspaceIsInternal) {
            return;
          }
          onChange({ type: "library", timestamp: Date.now() });
        })());
        return;
      }
      const name = filename.toString();
      if (name === WORKSPACE_FILE_NAME) {
        schedule("workspace", () => void (async () => {
          if (await this.writeIdentity.matchesFile(this.workspacePath)) {
            return;
          }
          onChange({ type: "workspace", timestamp: Date.now() });
        })());
      } else if (name === LIBRARY_FILE_NAME) {
        schedule("library", () => void (async () => {
          if (await this.writeIdentity.matchesFile(this.libraryPath)) {
            return;
          }
          onChange({ type: "library", timestamp: Date.now() });
        })());
      }
    });

    return () => {
      stopped = true;
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
      retryTimers.clear();
      for (const timer of this.watchTimers.values()) {
        clearTimeout(timer);
      }
      this.watchTimers.clear();
    };
  }

  private async ensureLibrary(initialDocument?: SigmaDocument): Promise<LocalLibraryRecord> {
    await this.ensureBaseDirs();
    const loaded = await this.readLibraryFileWithReport();
    const library = loaded?.library ?? createEmptyLibrary();
    const libraryFileWasMissing = loaded === null;
    const libraryHadNoFiles = library.files.length === 0;
    // library.json.bak から復元された読込か。この場合、台帳の内容はそのバックアップ
    // 世代時点の(意図的な)ソフトデリート状態などをそのまま反映しているはずなので、
    // 孤児本文の再登録 (adoptOrphanDocumentFiles) は絶対に走らせてはならない
    // (そのバックアップ世代では知らなかった/意図的に消した行を復活させかねない)。
    const libraryWasRestoredFromBackup = loaded?.restoredFromBackup ?? false;

    // 行レベルの修復/隔離が発生した読込は、次回の何気ない読み取りにそのまま便乗して
    // ディスクへも書き戻す (自己修復)。そうしないと、修復済みの内容はメモリ上だけの
    // ものにとどまり、次に何か別の理由で writeLibrary が呼ばれるまで元の壊れた行が
    // ディスク上に残り続けてしまう。
    let changed = loaded?.repaired ?? false;
    let defaultWorkspaceWasJustCreatedOrRestored = false;
    // 可視ワークスペースが無い場合だけ、削除済みワークスペースの復元または
    // 既定ワークスペースの新設を行う (#312 の再発防止策)。
    if (!this.hasAnyVisibleWorkspace(library)) {
      this.restoreOrCreateDefaultWorkspace(library, !libraryFileWasMissing);
      changed = true;
      defaultWorkspaceWasJustCreatedOrRestored = true;
    }

    // getVisibleFiles はワークスペース単位で可視性を判定するため、消えた
    // ワークスペースを指したままのfile行は今日すでに不可視 (=見えないだけの静かな
    // 消失パス) になっている。書き戻す前に、必ず実在するワークスペースへ付け替える。
    if (this.rehomeOrphanFileRecords(library)) {
      changed = true;
    }

    if (!this.findVisibleWorkspace(library, library.activeWorkspaceId)) {
      library.activeWorkspaceId = this.getPreferredActiveWorkspace(library)?.id ?? this.getVisibleWorkspaces(library)[0].id;
      changed = true;
    }

    // わざと狭い条件にしてある: 通常起動 (library.json が既にあり、行も既にあり、
    // ワークスペースも既存のまま) では絶対に発火させない。台帳が壊れて作り直された
    // 時 (ファイル欠損/空/デフォルトワークスペースの新設・復元) にだけ、
    // documents/ に残っている本文を再登録する (#312 の再発防止策その2)。
    const shouldAdoptOrphans = !libraryWasRestoredFromBackup &&
      (libraryFileWasMissing || libraryHadNoFiles || defaultWorkspaceWasJustCreatedOrRestored);
    let adoptedOrphanCount = 0;
    if (shouldAdoptOrphans) {
      adoptedOrphanCount = await this.adoptOrphanDocumentFiles(library, library.activeWorkspaceId);
      if (adoptedOrphanCount > 0) {
        changed = true;
      }
    }

    const activeWorkspaceId = library.activeWorkspaceId;
    const activeWorkspaceHasAnyFile = library.files.some((file) => file.workspaceId === activeWorkspaceId);
    if (
      adoptedOrphanCount === 0 &&
      !activeWorkspaceHasAnyFile &&
      this.getVisibleFiles(library).filter((file) => file.workspaceId === activeWorkspaceId).length === 0
    ) {
      const now = new Date().toISOString();
      const document = createInitialDocument(initialDocument);
      const file: LocalFileRecord = {
        fileId: createId("file"),
        workspaceId: activeWorkspaceId,
        folderId: null,
        docId: document.docId,
        title: resolveDocumentTitle(document, "サンプル教材"),
        documentPath: "",
        revision: 1,
        createdAt: document.updatedAt ?? now,
        updatedAt: document.updatedAt ?? now,
        deletedAt: null,
      };
      file.documentPath = getDocumentPath(file.fileId);
      // 書き込み順序の不変条件: 台帳の行の存在は本文の存在に絶対に遅れてはならない
      // (行の中身が遅れるのは構わない)。作成経路では行を先に書く — 途中でクラッシュ
      // しても「本文が無いことが分かる可視の行」が残るだけで済み (loadDocumentWithRecovery
      // が診断可能なエラーを返す)、"台帳に載っていない孤児本文" (今回の実被害と同じ形)
      // にはならない。
      library.files.push(file);
      changed = true;
      await this.writeLibrary(library);
      await this.writeDocumentForFile(file, document);
      // このブランチはこの下の `if (changed)` で必ずもう一度 writeLibrary が走る
      // (changedは既にtrue) ので、そこで自然に台帳のmtimeが本文の書き込み後まで
      // 進む。touchLibraryMtimeAfterCreateを重ねて呼ぶ必要はない。
    }

    if (changed) {
      await this.writeLibrary(library);
    }
    return library;
  }

  /** ensureLibrary の自動作成分岐に使う可視ワークスペース判定。 */
  private hasAnyVisibleWorkspace(library: LocalLibraryRecord): boolean {
    return this.getVisibleWorkspaces(library).length > 0;
  }

  /**
   * 論理削除されたワークスペースのうち、最も新しく更新されたものを
   * 復元する。deleteWorkspace はワークスペースと配下のfileを同じ `now` で
   * まとめて論理削除するため、「そのワークスペースの論理削除と同時刻に
   * 削除されたfile」だけを一緒に復元する — ユーザーが別のタイミングで
   * 個別に削除した教材まで巻き添えで復活させないための条件。
   * 復元候補が無ければ null。
   */
  private restoreMostRecentDeletedWorkspace(library: LocalLibraryRecord): LocalWorkspaceRecord | null {
    const candidate = library.workspaces
      .filter((workspace) => workspace.deletedAt)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
    if (!candidate) {
      return null;
    }
    const now = new Date().toISOString();
    const restoredWorkspace: LocalWorkspaceRecord = { ...candidate, deletedAt: null, updatedAt: now };
    this.replaceWorkspace(library, restoredWorkspace);

    let restoredFileCount = 0;
    library.files = library.files.map((file) => {
      if (file.workspaceId === candidate.id && file.deletedAt === candidate.deletedAt) {
        restoredFileCount += 1;
        return { ...file, deletedAt: null, updatedAt: now };
      }
      return file;
    });

    logLedgerEvent(this.dataDir, "workspace-auto-restored", {
      workspaceId: restoredWorkspace.id,
      restoredFileCount,
    });
    return restoredWorkspace;
  }

  /**
   * 新しい「マイ教材」を実際に作成し、台帳ログへ記録する唯一の場所。
   * createWorkspace (ユーザーの明示操作) 以外でワークスペースを新設するのは
   * 必ずここを経由すること。
   */
  private mintWorkspace(library: LocalLibraryRecord, libraryExisted: boolean): LocalWorkspaceRecord {
    const now = new Date().toISOString();
    const workspace: LocalWorkspaceRecord = {
      id: createId("workspace"),
      name: "マイ教材",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    library.workspaces.push(workspace);
    logLedgerEvent(this.dataDir, "workspace-auto-created", {
      workspaceId: workspace.id,
      workspaceCount: library.workspaces.length,
      fileCount: library.files.length,
      libraryExisted,
    });
    return workspace;
  }

  /**
   * ensureLibrary が「可視なワークスペースが1つも無い」と判定した時にだけ呼ぶ。
   * 論理削除されたワークスペースがあれば復元 (ファイルごと) し、
   * 無ければ新設する。どちらの場合もこのライブラリの唯一のワークスペースに
   * なるので、そのままアクティブにする。
   */
  private restoreOrCreateDefaultWorkspace(library: LocalLibraryRecord, libraryExisted: boolean): LocalWorkspaceRecord {
    const restored = this.restoreMostRecentDeletedWorkspace(library);
    const workspace = restored ?? this.mintWorkspace(library, libraryExisted);
    library.activeWorkspaceId = workspace.id;
    return workspace;
  }

  private async ensureBaseDirs(): Promise<void> {
    await fs.mkdir(this.documentsDir, { recursive: true });
    // ロック/ログ置き場は data/ 直下ではなくサブディレクトリにする必要がある
    // (watch(this.dataDir, ...) は非再帰で、data/ 直下にファイルが増えると
    // 誤った library change イベントが飛ぶ — ledger-log.ts の置き場所制約を参照)。
    // watcher が動き出す前 (watch() は ensureBaseDirsSync を呼ぶ) までに必ず
    // 存在させておく。
    await fs.mkdir(getLocksDir(this.dataDir), { recursive: true });
    await fs.mkdir(getLogsDir(this.dataDir), { recursive: true });
  }

  private ensureBaseDirsSync(): void {
    mkdirSync(this.documentsDir, { recursive: true });
    mkdirSync(getLocksDir(this.dataDir), { recursive: true });
    mkdirSync(getLogsDir(this.dataDir), { recursive: true });
  }

  private async readLibraryFile(): Promise<LocalLibraryRecord | null> {
    const result = await this.readLibraryFileWithReport();
    return result?.library ?? null;
  }

  /**
   * parseLibrary が行った行レベルの修復/隔離を、台帳ログへ1行ずつ記録した上で、
   * 何らかの修復/隔離が起きたかどうかを返す。ログの永続化自体はここで throw しない
   * (logLedgerEvent の契約) ので、パース処理の成否には一切影響しない。
   * 通常読込・.bak からの復元読込の両方から呼ぶ共通処理。
   */
  private logLibraryParseRepairs(parsed: LibraryParseOutcome): boolean {
    for (const repair of parsed.repairs) {
      logLedgerEvent(this.dataDir, "ledger-row-repaired", {
        table: repair.table,
        id: repair.id,
        fields: repair.fields,
      });
    }
    for (const quarantined of parsed.quarantinedRows) {
      logLedgerEvent(this.dataDir, "ledger-row-quarantined", { table: quarantined.table });
    }
    for (const quarantinedArray of parsed.quarantinedArrays) {
      logLedgerEvent(this.dataDir, "ledger-array-quarantined", { table: quarantinedArray.table });
    }
    return parsed.repairs.length > 0 || parsed.quarantinedRows.length > 0 || parsed.quarantinedArrays.length > 0;
  }

  /**
   * 壊れて読めなかった library.json の生バイト列を、writeRecoveryBackup と同じ
   * hash重複排除の作法で data/recovery/library-<hash>.json へフォレンジック保存する。
   * ここで何もこの中身を解釈しない (素通しの退避のみ)。
   */
  private async preserveCorruptLibraryBytes(raw: string): Promise<void> {
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const preservedPath = path.join(this.recoveryDir, `library-${hash}.json`);
    await fs.mkdir(this.recoveryDir, { recursive: true });
    try {
      await fs.writeFile(preservedPath, raw, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isPlainObject(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    logLedgerEvent(this.dataDir, "ledger-corrupt-preserved", { path: preservedPath });
  }

  /**
   * library.json.bak からの復元を試みる。library.json 自体が丸ごと無い(ENOENT)
   * 場合と、読めたが壊れていてパースできない場合の、両方の最終手段として呼ばれる。
   * .bak が無い/パースできない/現行スキーマに違反する場合も、それぞれを判別できる
   * 結果として返し、呼び出し元に既定動作またはスキーマエラー化を委ねる。
   */
  private async tryRestoreLibraryFromBackup(): Promise<LibraryBackupRestoreResult> {
    let backupRaw: string;
    try {
      backupRaw = await fs.readFile(this.libraryBackupPath, "utf8");
    } catch (error) {
      return isPlainObject(error) && error.code === "ENOENT"
        ? { status: "absent" }
        : { status: "unreadable" };
    }
    const parsed = parseLibrary(backupRaw);
    if (parsed.status === "schema-violation") {
      logLedgerEvent(this.dataDir, "ledger-backup-schema-mismatch", {
        violationCount: parsed.violations.length,
        paths: parsed.violations.map((violation) => violation.path),
      });
      return { status: "schema-violation", violations: parsed.violations };
    }
    if (parsed.status === "unreadable") {
      return { status: "unreadable" };
    }
    logLedgerEvent(this.dataDir, "ledger-restored-from-backup", {});
    // .bak の生バイト列は「正常にパースできた」ものなので、これ自体を次回の
    // ローリングバックアップの起点として扱ってよい。
    this.lastGoodLibraryRaw = backupRaw;
    const repaired = this.logLibraryParseRepairs(parsed.outcome);
    return { status: "restored", library: parsed.outcome.library, repaired };
  }

  private async readLibraryFileWithReport(): Promise<{ library: LocalLibraryRecord; repaired: boolean; restoredFromBackup: boolean } | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.libraryPath, "utf8");
    } catch (error) {
      if (!isPlainObject(error) || error.code !== "ENOENT") {
        throw error;
      }
      // library.json が丸ごと存在しない: 通常は「初回起動でまだ何も無い」正常系だが、
      // 直前の世代が.bakに残っていれば、それを空の状態から作り直すよりも復元する方が
      // 常に安全 (フォルダ構成やワークスペース名を失わずに済む)。.bakも無ければ従来通り
      // null を返し、呼び出し元 (ensureLibrary) の「台帳が無い」既定動作に委ねる。
      const restored = await this.tryRestoreLibraryFromBackup();
      if (restored.status === "restored") {
        return { library: restored.library, repaired: restored.repaired, restoredFromBackup: true };
      }
      if (restored.status === "schema-violation") {
        const backupRaw = await fs.readFile(this.libraryBackupPath, "utf8");
        const actualVersion = (JSON.parse(backupRaw) as Record<string, unknown>).version;
        throw new LedgerSchemaError({
          libraryPath: this.libraryBackupPath,
          expectedVersion: LIBRARY_VERSION,
          actualVersion,
          violations: restored.violations,
        });
      }
      return null;
    }

    const parsed = parseLibrary(raw);
    if (parsed.status === "schema-violation") {
      const actualVersion = (JSON.parse(raw) as Record<string, unknown>).version;
      logLedgerEvent(this.dataDir, "ledger-schema-mismatch", {
        violationCount: parsed.violations.length,
        paths: parsed.violations.map((violation) => violation.path),
      });
      throw new LedgerSchemaError({
        libraryPath: this.libraryPath,
        expectedVersion: LIBRARY_VERSION,
        actualVersion,
        violations: parsed.violations,
      });
    }
    if (parsed.status === "unreadable") {
      // JSON構文自体が壊れている・トップレベルがobjectでない等、行単位の寛容パーサーでも
      // 救えない全体破損。まず生バイト列をフォレンジック用に退避してから、.bakへの
      // 復元を試みる。.bakも無ければ、今日と全く同じメッセージで例外を投げ、
      // 呼び出し元に「何も上書きせず中止する」既存の安全側動作をさせる。
      await this.preserveCorruptLibraryBytes(raw);
      const restored = await this.tryRestoreLibraryFromBackup();
      if (restored.status === "restored") {
        return { library: restored.library, repaired: restored.repaired, restoredFromBackup: true };
      }
      if (restored.status === "schema-violation") {
        const backupRaw = await fs.readFile(this.libraryBackupPath, "utf8");
        const actualVersion = (JSON.parse(backupRaw) as Record<string, unknown>).version;
        throw new LedgerSchemaError({
          libraryPath: this.libraryBackupPath,
          expectedVersion: LIBRARY_VERSION,
          actualVersion,
          violations: restored.violations,
        });
      }
      throw new Error(te("electron.storage.libraryIndexCorrupt"));
    }

    const repaired = this.logLibraryParseRepairs(parsed.outcome);
    this.lastGoodLibraryRaw = raw;
    return { library: parsed.outcome.library, repaired, restoredFromBackup: false };
  }

  private async writeLibrary(library: LocalLibraryRecord): Promise<void> {
    const data = JSON.stringify(library, null, 2);
    await fs.mkdir(path.dirname(this.libraryPath), { recursive: true });

    // ローリングバックアップ: library.json を上書きする前に、直前に正常パースできた
    // 世代の生バイト列を library.json.bak へ退避する。同じ内容を何度も書き直さない
    // よう、前回バックアップした内容と変わっていなければ書き込みを省く (#B4 5.)。
    if (this.lastGoodLibraryRaw !== null && this.lastGoodLibraryRaw !== this.lastBackedUpLibraryRaw) {
      await this.writeFileDurable(this.libraryBackupPath, this.lastGoodLibraryRaw);
      this.lastBackedUpLibraryRaw = this.lastGoodLibraryRaw;
    }

    // 「内容が変わっていなければ書かない」最適化は入れない。
    //
    // 保存経路では revision と updatedAt が必ず動くので条件が成立せず、効果が出るのは
    // 台帳を触らない no-op の書き込みだけだった。一方で判定の土台になる
    // `lastGoodLibraryRaw` は「今ディスクにあるバイト列」とは限らず
    // (`tryRestoreLibraryFromBackup` は .bak の内容を代入するが library.json は書かない)、
    // 省略したときは内部署名の記録も飛ぶので watcher に外部変更として誤検知される。
    // 得るものが無い側にこれだけの不変条件を積むのは割に合わないので、常に書く。
    await this.writeFileDurable(this.libraryPath, data);
    this.writeIdentity.rememberSignature(this.libraryPath, data);
    this.lastGoodLibraryRaw = data;
  }

  private async loadDocumentFromFileRecord(file: LocalFileRecord): Promise<SigmaDocument | null> {
    try {
      const raw = await fs.readFile(this.resolveDocumentPath(file), "utf8");
      const recovered = recoverSigmaDocument(JSON.parse(raw));
      if (!recovered.ok) {
        return null;
      }
      if (recovered.issues.length > 0) {
        await this.writeRecoveryBackup(file.fileId, raw);
      }
      return ensurePageLayout(recovered.document);
    } catch {
      return null;
    }
  }

  /**
   * loadDocumentFromFileRecord の path-based な姉妹版: まだ LocalFileRecord が
   * 存在しない (=台帳に登録されていない) fileId から、documents/ 上の本文だけを
   * 読む。孤児教材の再登録 (adoptOrphanDocumentFiles) 専用で、失敗理由を
   * ログへ残せるよう null ではなく判別可能な結果を返す。
   */
  private async readDocumentBodyByFileId(
    fileId: string,
  ): Promise<{ ok: true; document: SigmaDocument } | { ok: false; reason: string }> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.dataDir, getDocumentPath(fileId)), "utf8");
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : te("electron.storage.loadFailed") };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: te("electron.storage.invalidJson") };
    }
    const recovered = recoverSigmaDocument(parsed);
    if (!recovered.ok) {
      return { ok: false, reason: recovered.error };
    }
    return { ok: true, document: ensurePageLayout(recovered.document) };
  }

  /**
   * documents/ にあるのに library.files のどの行にも対応しない本文 (孤児) を
   * targetWorkspaceId 直下へ再登録する。台帳が壊れて作り直された時にだけ
   * ensureLibrary から呼ばれる (通常起動では発火しない、呼び出し側のガード参照)。
   *
   * - 既に library.files にある fileId は deletedAt の有無に関わらずスキップする
   *   (論理削除された教材を巻き添えで復活させない)。
   * - 本文は一切書き換えない (読み取り専用)。
   * - 読めない/復元できない本文は行を作らずスキップし、理由をログする。
   *
   * 戻り値は実際に登録した件数。
   */
  private async adoptOrphanDocumentFiles(
    library: LocalLibraryRecord,
    targetWorkspaceId: string,
  ): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.documentsDir);
    } catch {
      return 0;
    }

    const knownFileIds = new Set(library.files.map((file) => file.fileId));
    const targetWorkspace = this.findVisibleWorkspace(library, targetWorkspaceId);
    if (!targetWorkspace) {
      return 0;
    }

    interface OrphanCandidate {
      fileId: string;
      document: SigmaDocument;
      mtimeIso: string;
    }
    const candidates: OrphanCandidate[] = [];

    for (const entry of entries) {
      const fileId = decodeDocumentFileName(entry);
      if (!fileId || knownFileIds.has(fileId)) {
        continue;
      }
      const result = await this.readDocumentBodyByFileId(fileId);
      if (!result.ok) {
        logLedgerEvent(this.dataDir, "orphan-adoption-skipped", { fileId, reason: result.reason });
        continue;
      }
      let mtimeIso: string;
      try {
        const stats = await fs.stat(path.join(this.dataDir, getDocumentPath(fileId)));
        mtimeIso = stats.mtime.toISOString();
      } catch {
        mtimeIso = result.document.updatedAt ?? new Date().toISOString();
      }
      candidates.push({ fileId, document: result.document, mtimeIso });
    }

    // 決定的な順序にするため mtime 昇順で揃える。
    candidates.sort((a, b) => a.mtimeIso.localeCompare(b.mtimeIso));

    const toAdopt = candidates.slice(0, MAX_ADOPTED_DOCUMENTS);
    if (candidates.length > MAX_ADOPTED_DOCUMENTS) {
      logLedgerEvent(this.dataDir, "orphan-adoption-skipped", {
        reason: "adoption-cap-exceeded",
        skippedCount: candidates.length - MAX_ADOPTED_DOCUMENTS,
      });
    }

    const adoptedFileIds: string[] = [];
    for (const candidate of toAdopt) {
      const timestamp = candidate.document.updatedAt ?? candidate.mtimeIso;
      const record: LocalFileRecord = {
        fileId: candidate.fileId,
        workspaceId: targetWorkspaceId,
        folderId: null,
        docId: candidate.document.docId,
        title: resolveDocumentTitle(candidate.document),
        documentPath: getDocumentPath(candidate.fileId),
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      library.files.push(record);
      adoptedFileIds.push(candidate.fileId);
    }

    if (adoptedFileIds.length > 0) {
      logLedgerEvent(this.dataDir, "orphan-documents-adopted", {
        count: adoptedFileIds.length,
        workspaceId: targetWorkspaceId,
        fileIds: adoptedFileIds,
      });
    }

    return adoptedFileIds.length;
  }

  private async readWorkspace(library: LocalLibraryRecord): Promise<LocalWorkspaceState> {
    const visibleFileIds = new Set(this.getVisibleFiles(library).map((file) => file.fileId));
    const fallbackFileId = this.getVisibleFiles(library)
      .find((file) => file.workspaceId === library.activeWorkspaceId)?.fileId ??
      this.getVisibleFiles(library)[0]?.fileId;

    let parsed: Partial<LocalWorkspaceState> | null = null;
    try {
      const raw = await fs.readFile(this.workspacePath, "utf8");
      const value = JSON.parse(raw) as unknown;
      if (isPlainObject(value)) {
        parsed = {
          openFileIds: Array.isArray(value.openFileIds)
            ? value.openFileIds.filter((id): id is string => typeof id === "string")
            : undefined,
          activeFileId: typeof value.activeFileId === "string" ? value.activeFileId : undefined,
          layout: isPlainObject(value.layout) && value.layout.version === 2
            ? value.layout as unknown as WorkspaceLayoutV2
            : undefined,
        };
      }
    } catch {
      parsed = null;
    }

    const activeFileId = parsed?.activeFileId && visibleFileIds.has(parsed.activeFileId)
      ? parsed.activeFileId
      : fallbackFileId;
    if (!activeFileId) {
      throw new Error(te("electron.storage.noSavedDocuments"));
    }
    const openFileIds = uniqueIds([
      ...(parsed?.openFileIds ?? []).filter((id) => visibleFileIds.has(id)),
      activeFileId,
    ]);
    const layout = parsed?.layout
      ? normalizeWorkspaceLayout(parsed.layout, openFileIds, activeFileId, visibleFileIds)
      : undefined;
    const state = {
      openFileIds: layout ? workspaceLayoutOpenFileIds(layout) : openFileIds,
      activeFileId: layout?.lastDocumentFileId ?? activeFileId,
      ...(layout ? { layout } : {}),
    };
    await this.saveWorkspaceWithLibrary(state);
    return state;
  }

  /**
   * workspace.json (「開いているタブ/アクティブなタブ」だけの、台帳とは別の
   * 小さな状態ファイル) を書く。台帳(library.json)の activeWorkspaceId 更新を
   * 伴い得るため、常に withLedger でくるむ — こうすることで、この関数だけが
   * 単独 (すでに台帳トランザクションの外) から呼ばれても自前でロックを取りに行き、
   * 既に進行中のトランザクションの内側から呼ばれれば (呼び出し元は全て変換済み)
   * join して同じ in-memory library をそのまま使う。呼び出し元から library を
   * 引数で受け取らないのはこのため — 引数で受け取ると、join できずに内部で
   * 新しく読み直した library と食い違う古いコピーを渡されるリスクが生まれる。
   */
  private async saveWorkspaceWithLibrary(state: LocalWorkspaceState): Promise<void> {
    return this.withLedger("saveWorkspaceWithLibrary", async (tx) => {
      const library = tx.library;
      const visibleFileIds = new Set(this.getVisibleFiles(library).map((file) => file.fileId));
      const activeFileId = visibleFileIds.has(state.activeFileId)
        ? state.activeFileId
        : state.openFileIds.find((id) => visibleFileIds.has(id));
      if (!activeFileId) {
        throw new Error(te("electron.storage.noSavedDocuments"));
      }
      const activeFile = this.findVisibleFile(library, activeFileId);
      if (activeFile && library.activeWorkspaceId !== activeFile.workspaceId) {
        library.activeWorkspaceId = activeFile.workspaceId;
        await this.writeLibrary(library);
      }
      const layout = normalizeWorkspaceLayout(
        state.layout ?? createSingleGroupWorkspaceLayout(state.openFileIds, activeFileId),
        state.openFileIds,
        activeFileId,
        visibleFileIds,
      );
      const record = {
        id: WORKSPACE_RECORD_ID,
        openFileIds: uniqueIds([
          ...state.openFileIds.filter((id) => visibleFileIds.has(id)),
          activeFileId,
        ]),
        activeFileId,
        layout,
      };
      const data = JSON.stringify(record, null, 2);
      await fs.writeFile(this.workspacePath, data, "utf8");
      this.writeIdentity.rememberSignature(this.workspacePath, data);
    });
  }

  private async writeDocumentForFile(file: LocalFileRecord, document: SigmaDocument): Promise<void> {
    // 整形して書かない。人が直接読むファイルではなく、教材サイズに比例して
    // 文字列化・書き込み・(watcher 側の) 読み直しのすべてが重くなるだけだった。
    const data = JSON.stringify(document);
    const documentPath = this.resolveDocumentPath(file);
    // rename前に(=writeFileDurableの中で実際にファイルシステムへ可視化される前に)
    // 内部署名を憶えておく。そうしないと、rename直後に発火し得るwatcherのfsイベントを
    // 「自分自身の書き込み」ではなく外部変更と誤認する窓が生まれる。
    this.writeIdentity.rememberSignature(documentPath, data);
    const statToken = await this.writeFileDurable(documentPath, data);
    // 本文を読まずに自分の書き込みを弾くための目印。ハッシュによる判定は後段に残す。
    this.writeIdentity.recordStat(documentPath, statToken);
  }

  /**
   * 作成経路 (行→本文の順で書く) の直後だけに呼ぶ。MCP側の読み込みキャッシュ
   * (mcp/sigma-doc-mcp-store.ts の isDocumentCacheWriteConsistent) は「本文の
   * mtimeが台帳(library.json)のmtime以下」であることを、保存が競合中でない
   * (=読んだ本文が台帳のラベルより新しすぎない) ことの目印として使っている。
   * 更新経路 (saveDocument) は本文→行の順のままなのでこの前提は保たれるが、
   * 作成経路は安全性のため行→本文の順にしたぶん本文の方が新しくなり、目印が
   * 逆転してしまう。中身は変えずに台帳ファイルのmtimeだけ本文の書き込み後まで
   * 進めて、この目印を壊さないようにする。ベストエフォート — 失敗してもキャッシュが
   * 一時的に効かなくなるだけで、正しさには影響しない。
   */
  private async touchLibraryMtimeAfterCreate(): Promise<void> {
    const now = new Date();
    await fs.utimes(this.libraryPath, now, now).catch(() => undefined);
  }

  private async writeRecoveryBackup(fileId: string, raw: string): Promise<string> {
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const backupPath = path.join(
      this.recoveryDir,
      `${encodeURIComponent(fileId)}-${hash}${DOCUMENT_FILE_SUFFIX}`,
    );
    await fs.mkdir(this.recoveryDir, { recursive: true });
    try {
      await fs.writeFile(backupPath, raw, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isPlainObject(error) || error.code !== "EEXIST") {
        throw new Error(te("electron.storage.recoveryBackupFailed"), { cause: error });
      }
    }
    return backupPath;
  }

  private resolveDocumentPath(file: LocalFileRecord): string {
    return path.join(this.dataDir, file.documentPath || getDocumentPath(file.fileId));
  }

  private resolveWorkspace(
    library: LocalLibraryRecord,
    workspaceId?: string | null,
  ): LocalWorkspaceRecord {
    // 明示的な workspaceId が指定されたのに見つからない場合は、そのまま
    // 「見つかりません」を投げる (例: 削除済みのワークスペースIDを渡された時)。
    if (workspaceId) {
      const workspace = this.findVisibleWorkspace(library, workspaceId);
      if (!workspace) {
        throw new Error(te("electron.storage.workspaceNotFound"));
      }
      return workspace;
    }
    const workspace = this.findVisibleWorkspace(library, library.activeWorkspaceId) ?? this.getVisibleWorkspaces(library)[0];
    if (workspace) {
      return workspace;
    }
    throw new Error(te("electron.storage.workspaceNotFound"));
  }

  private resolveFolderId(
    library: LocalLibraryRecord,
    workspaceId: string,
    folderId?: string | null,
  ): string | null {
    const normalized = folderId?.trim() || null;
    if (!normalized) {
      return null;
    }
    const folder = this.findVisibleFolder(library, workspaceId, normalized);
    if (!folder) {
      throw new Error(te("electron.storage.folderNotFound"));
    }
    return folder.id;
  }

  private createWorkspaceOverview(
    library: LocalLibraryRecord,
    workspaceId: string,
  ): LocalWorkspaceOverview {
    const files = this.getVisibleFiles(library).filter((file) => file.workspaceId === workspaceId);
    const folders = this.getVisibleFolders(library).filter((folder) => folder.workspaceId === workspaceId);
    const fileCountByFolderId = new Map<string, number>();
    for (const file of files) {
      if (!file.folderId) {
        continue;
      }
      fileCountByFolderId.set(file.folderId, (fileCountByFolderId.get(file.folderId) ?? 0) + 1);
    }

    return {
      activeWorkspaceId: workspaceId,
      workspaces: this.getVisibleWorkspaces(library).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
      folders: folders.map((folder) => ({
        id: folder.id,
        workspaceId: folder.workspaceId,
        parentFolderId: folder.parentFolderId,
        name: folder.name,
        fileCount: fileCountByFolderId.get(folder.id) ?? 0,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      })),
      files: files.map(mapFileMetadata),
    };
  }

  private reconcileAllDocumentFiles(onChange: (event: LocalStoreChangeEvent) => void): Promise<void> {
    return this.documentReconciler.reconcileAll(onChange);
  }

  private reconcileDocumentFile(
    fileId: string,
    onChange: (event: LocalStoreChangeEvent) => void,
  ): Promise<void> {
    return this.documentReconciler.reconcile(fileId, onChange);
  }

  private getVisibleWorkspaces(library: LocalLibraryRecord): LocalWorkspaceRecord[] {
    return library.workspaces.filter((workspace) => !workspace.deletedAt);
  }

  private getVisibleFolders(library: LocalLibraryRecord): LocalFolderRecord[] {
    return library.folders.filter((folder) => !folder.deletedAt);
  }

  private getVisibleFiles(library: LocalLibraryRecord): LocalFileRecord[] {
    const visibleWorkspaceIds = new Set(this.getVisibleWorkspaces(library).map((workspace) => workspace.id));
    return library.files.filter((file) => !file.deletedAt && visibleWorkspaceIds.has(file.workspaceId));
  }

  private findVisibleWorkspace(
    library: LocalLibraryRecord,
    workspaceId: string,
  ): LocalWorkspaceRecord | null {
    return this.getVisibleWorkspaces(library).find((workspace) => workspace.id === workspaceId) ?? null;
  }

  private findVisibleFolder(
    library: LocalLibraryRecord,
    workspaceId: string,
    folderId: string,
  ): LocalFolderRecord | null {
    return this.getVisibleFolders(library)
      .find((folder) => folder.workspaceId === workspaceId && folder.id === folderId) ?? null;
  }

  private findVisibleFile(
    library: LocalLibraryRecord,
    fileId: string,
  ): LocalFileRecord | null {
    return this.getVisibleFiles(library).find((file) => file.fileId === fileId) ?? null;
  }

  private replaceWorkspace(library: LocalLibraryRecord, nextWorkspace: LocalWorkspaceRecord): void {
    library.workspaces = library.workspaces.map((workspace) =>
      workspace.id === nextWorkspace.id ? nextWorkspace : workspace);
  }

  private replaceFolder(library: LocalLibraryRecord, nextFolder: LocalFolderRecord): void {
    library.folders = library.folders.map((folder) => folder.id === nextFolder.id ? nextFolder : folder);
  }

  private replaceFile(library: LocalLibraryRecord, nextFile: LocalFileRecord): void {
    library.files = library.files.map((file) => file.fileId === nextFile.fileId ? nextFile : file);
  }

  private touchWorkspace(library: LocalLibraryRecord, workspaceId: string, updatedAt: string): void {
    const workspace = this.findVisibleWorkspace(library, workspaceId);
    if (workspace) {
      this.replaceWorkspace(library, { ...workspace, updatedAt });
    }
  }

  private getPreferredActiveWorkspace(library: LocalLibraryRecord): LocalWorkspaceRecord | null {
    return this.getVisibleWorkspaces(library)[0] ?? null;
  }

  /**
   * getVisibleFiles はワークスペース単位で可視性を判定する。そのため、workspaceId が
   * どのワークスペース行とも一致しないfile行は、台帳のfiles配列には残っていても
   * 今日すでにUI上のどこにも出てこない (=静かな消失パス)。復元可能な最小限の手当てとして、
   * そうした孤児行を優先ワークスペースへ付け替えて可視化する。
   */
  private rehomeOrphanFileRecords(library: LocalLibraryRecord): boolean {
    const workspaceIds = new Set(library.workspaces.map((workspace) => workspace.id));
    const preferred = this.getPreferredActiveWorkspace(library);
    if (!preferred) {
      return false;
    }
    let changed = false;
    library.files = library.files.map((file) => {
      if (workspaceIds.has(file.workspaceId)) {
        return file;
      }
      changed = true;
      logLedgerEvent(this.dataDir, "file-rehomed", {
        fileId: file.fileId,
        previousWorkspaceId: file.workspaceId,
        workspaceId: preferred.id,
      });
      return { ...file, workspaceId: preferred.id };
    });
    return changed;
  }

  private isFolderDescendant(
    library: LocalLibraryRecord,
    workspaceId: string,
    candidateFolderId: string,
    ancestorFolderId: string,
  ): boolean {
    let cursor = this.findVisibleFolder(library, workspaceId, candidateFolderId);
    while (cursor) {
      if (cursor.id === ancestorFolderId) {
        return true;
      }
      cursor = cursor.parentFolderId
        ? this.findVisibleFolder(library, workspaceId, cursor.parentFolderId)
        : null;
    }
    return false;
  }


}

function mapFileMetadata(file: LocalFileRecord): LocalDocumentMetadata {
  return {
    fileId: file.fileId,
    workspaceId: file.workspaceId,
    folderId: file.folderId,
    docId: file.docId,
    title: file.title,
    documentPath: file.documentPath,
    revision: file.revision,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

/**
 * 台帳ブートストラップ時に書く「最初の 1 本」。
 *
 * ここは `saveDocument` / `createFileFromDocument` の本体とは別に本文を書き出す経路で、
 * 以前は renderer 側の検証に暗黙に頼っていた (renderer が IPC 前に zod を通していた)。
 * renderer の検証を外した以上、**受け取った文書はここで必ず検証する**。
 * `ensurePageLayout` は version と pageLayout しか触らないので、content / metadata は
 * 素通りしてしまい、未知のブロック種別や余計なキーがそのままディスクに残る。
 */
function createInitialDocument(initialDocument?: SigmaDocument): SigmaDocument {
  const now = new Date().toISOString();
  if (initialDocument) {
    return ensurePageLayout(parseSigmaDocument({
      ...cloneDocument(initialDocument),
      docId: createId("doc"),
      updatedAt: now,
    }));
  }
  return createBlankDocument();
}

function cloneDocument(document: SigmaDocument): SigmaDocument {
  if (typeof structuredClone === "function") {
    return structuredClone(document);
  }
  return JSON.parse(JSON.stringify(document)) as SigmaDocument;
}

function getDocumentPath(fileId: string): string {
  return path.join(DOCUMENTS_DIR_NAME, `${encodeURIComponent(fileId)}${DOCUMENT_FILE_SUFFIX}`);
}

function decodeDocumentFileName(filename: string): string | null {
  if (!filename.endsWith(DOCUMENT_FILE_SUFFIX)) {
    return null;
  }
  try {
    const fileId = decodeURIComponent(filename.slice(0, -DOCUMENT_FILE_SUFFIX.length));
    return isValidDocumentFileId(fileId) ? fileId : null;
  } catch {
    return null;
  }
}

function normalizeDocumentTitle(title?: string): string {
  const normalized = title?.trim() ?? "";
  return (normalized || DEFAULT_DOCUMENT_TITLE).slice(0, 160);
}

function compareFileUpdatedAt(a: LocalDocumentMetadata, b: LocalDocumentMetadata): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
