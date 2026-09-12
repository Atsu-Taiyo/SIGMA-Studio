import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

// ライブラリ(教材台帳)まわりの診断ログ。ロック待ち・破損検知・救済処理などの
// 事実を追跡できるようにするためのもの。ログ自体の書き込み失敗が本処理を
// 巻き込んで壊すことがあってはならないため、この関数は絶対に throw しない。
//
// 置き場所の制約: ログ・ロックファイルは必ず data/ 直下ではなく
// data/logs, data/locks のサブディレクトリに置くこと。
// local-sigma-doc-store.ts は watch(this.dataDir, ...) を非再帰で張っており、
// data/ 直下にファイルが増えるとその !filename 分岐が発火し、MCP側の変更ごとに
// 偽の library change イベントが renderer へ飛んでしまう。

export const LOGS_DIR_NAME = "logs";
export const LOCKS_DIR_NAME = "locks";
export const LEDGER_LOG_FILE_NAME = "ledger.log";

/** ログ末尾がこのバイト数を超えたら ledger.log -> ledger.log.1 へロールする。 */
export const LEDGER_LOG_ROTATE_BYTES = 2 * 1024 * 1024;

export type LedgerEvent =
  | "workspace-auto-created"
  | "workspace-auto-restored"
  | "ledger-row-repaired"
  | "ledger-row-quarantined"
  | "ledger-array-quarantined"
  | "ledger-restored-from-backup"
  | "ledger-corrupt-preserved"
  | "ledger-schema-mismatch"
  | "ledger-backup-schema-mismatch"
  | "ledger-lock-waited"
  | "ledger-lock-broken"
  | "ledger-lock-timeout"
  | "ledger-lock-lost"
  | "document-save-revision-mismatch"
  | "document-version-capture-failed"
  | "document-version-cleanup-failed"
  | "document-version-index-tail-recovered"
  | "local-store-watch-failed"
  | "local-store-watch-restarted"
  | "local-store-watch-permanently-failed"
  | "orphan-documents-adopted"
  | "orphan-adoption-skipped"
  | "file-rehomed"
  | "file-body-missing"
  | "file-body-unreadable-by-reconcile"
  | "file-soft-deleted-by-reconcile";

export function getLogsDir(dataDir: string): string {
  return path.join(dataDir, LOGS_DIR_NAME);
}

export function getLocksDir(dataDir: string): string {
  return path.join(dataDir, LOCKS_DIR_NAME);
}

export function getLedgerLogPath(dataDir: string): string {
  return path.join(getLogsDir(dataDir), LEDGER_LOG_FILE_NAME);
}

function currentRole(): "mcp" | "main" {
  return process.env.SIGMA_STUDIO_MCP_PROVIDER ? "mcp" : "main";
}

function rotateIfNeeded(logPath: string): void {
  try {
    const stats = statSync(logPath);
    if (stats.size <= LEDGER_LOG_ROTATE_BYTES) {
      return;
    }
  } catch {
    // ファイルがまだ無ければローテーション不要。
    return;
  }

  const rotatedPath = `${logPath}.1`;
  try {
    unlinkSync(rotatedPath);
  } catch {
    // 既存の .1 が無ければ無視。
  }
  try {
    renameSync(logPath, rotatedPath);
  } catch {
    // rename に失敗しても致命的ではない(次回書き込みで再試行される)。
  }
}

function appendLine(dataDir: string, line: string): void {
  const logsDir = getLogsDir(dataDir);
  mkdirSync(logsDir, { recursive: true });
  const logPath = getLedgerLogPath(dataDir);
  rotateIfNeeded(logPath);
  appendFileSync(logPath, line + "\n", "utf8");
}

/**
 * 台帳まわりのイベントを記録する。console.warn への出力と
 * <dataDir>/logs/ledger.log への追記(ベストエフォート)の両方を行う。
 * いかなる失敗も外へ throw しない。
 */
export function logLedgerEvent(dataDir: string, event: LedgerEvent, fields?: Record<string, unknown>): void {
  let line: string;
  try {
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      role: currentRole(),
      event,
      ...fields,
    };
    line = JSON.stringify(record);
  } catch {
    // fields に循環参照などがあり stringify できない場合は諦める。
    return;
  }

  try {
    console.warn(`[sigma:ledger] ${line}`);
  } catch {
    // 出力先が閉じている等は無視。
  }

  try {
    appendLine(dataDir, line);
  } catch {
    // ログの永続化に失敗しても本処理には影響させない。
  }
}
