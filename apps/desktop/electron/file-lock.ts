import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { tryLockFileDescriptor, unlockFileDescriptor } from "./file-lock-native";

const te = createCurrentLocaleTranslator("error");

// 排他権は削除しない .mutex inode の OS ロックに持たせ、返した handle の全生存期間で
// 保持する。JSON は診断用で、作成・回収・解放も同じ排他権の内側にある。
// Windows の byte-range lock は別 fd の I/O も拒むので、JSON と mutex は分離する。
// mutex を使わない旧クライアントとの同時稼働まで排他を保証することはできない。

export const FILE_LOCK_STALE_MS = 10_000;
export const FILE_LOCK_TIMEOUT_MS = 15_000;
export const FILE_LOCK_HEARTBEAT_MS = 2_000;

const LOCK_PAYLOAD_VERSION = 2;
const LEGACY_PAYLOAD_GRACE_MS = 250;

export interface FileLockOptions {
  /** このロックの取得理由(診断用)。省略時は "unknown"。 */
  op?: string;
  /** 旧呼出元との互換用。経過時間だけで生存中の所有者からロックを奪うことはない。 */
  staleMs?: number;
  /** ロック取得をあきらめてエラーを投げるまでの最大待機時間(ms)。 */
  timeoutMs?: number;
  /** 保持中に mtime を更新し続ける間隔(ms)。 */
  heartbeatMs?: number;
  /**
   * 所有者のいない診断用ロックファイルを回収(unlink)した直後に呼ばれる、診断用の
   * ベストエフォートなコールバック。呼び出し元が呼び出し側の台帳ログ等へ
   * 記録するためのフックであり、この関数自体の戻り値・例外はロック取得の
   * 成否に一切影響しない。
   */
  onStaleLockBroken?: (info: { staleOwnerPid: number | null; staleOwnerHost: string | null }) => void;
}

export interface FileLockHandle {
  /** このハンドルが生成したロックID。 */
  lockId: string;
  /**
   * ロックファイルを解放する。
   * 戻り値は「自分の lockId が一致していて実際に unlink した」場合に true、
   * 診断用ファイルが外部で削除・置換されていた場合は false。
   * JSON の照合・削除と、進行中の heartbeat の完了まで OS ロックを保持する。
   */
  release(): Promise<boolean>;
}

interface FileLockPayload {
  version?: unknown;
  lockId: string;
  pid: number;
  host: string;
  op: string;
  acquiredAt: string;
}

type LockMetadata = { kind: "missing" } | { kind: "present"; payload: FileLockPayload | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof (error as { code?: unknown }).code === "string";
}

function isFileLockPayload(value: unknown): value is FileLockPayload {
  return (
    isRecord(value) &&
    typeof value.lockId === "string" &&
    typeof value.pid === "number" &&
    typeof value.host === "string" &&
    typeof value.op === "string" &&
    typeof value.acquiredAt === "string"
  );
}

async function readLockPayload(lockPath: string): Promise<FileLockPayload | null> {
  try {
    const metadata = await readLockMetadata(lockPath);
    return metadata.kind === "present" ? metadata.payload : null;
  } catch {
    // ENOENT・JSON破損などはすべて「判定不能」として扱う。
    return null;
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return { kind: "present", payload: isFileLockPayload(parsed) ? parsed : null };
  } catch {
    return { kind: "present", payload: null };
  }
}

/** pid が生存しているか。ESRCH のみ「存在しない」と解釈する(EPERM 等は生存扱い)。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isErrnoException(error) && error.code === "ESRCH");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OS ロック保持中にだけ呼ぶ。v2 の残骸には生きた所有者がいない。
 * 旧 payload は mutex を使わないため、同一ホストで PID の死亡が確認できる場合
 * だけ回収する。別ホスト・生存 PID は mtime にかかわらず待つ。
 */
async function prepareLockMetadata(
  lockPath: string,
  onStaleLockBroken?: FileLockOptions["onStaleLockBroken"],
): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata.kind === "missing") return true;
  const { payload } = metadata;
  if (payload && payload.version !== LOCK_PAYLOAD_VERSION
    && (payload.host !== os.hostname() || isProcessAlive(payload.pid))) {
    return false;
  }
  if (!payload) {
    // 旧クライアントが作成した直後の空 JSON を直ちに破損と判定しない。
    // これは移行時の猶予であり、旧クライアントの排他を保証するものではない。
    const stats = await fs.stat(lockPath).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) return true;
    if (Date.now() - stats.mtimeMs < LEGACY_PAYLOAD_GRACE_MS) return false;
  }
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return true;
    throw error;
  }
  try {
    onStaleLockBroken?.({ staleOwnerPid: payload?.pid ?? null, staleOwnerHost: payload?.host ?? null });
  } catch {
    // 診断用コールバックの失敗はロック取得の成否に影響させない。
  }
  return true;
}

async function removeFailedPublication(lockPath: string, lockId: string): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata.kind === "missing" || (metadata.payload && metadata.payload.lockId !== lockId)) return;
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

async function closeMutexFile(file: FileHandle, locked: boolean): Promise<void> {
  const errors: unknown[] = [];
  if (locked) {
    try {
      unlockFileDescriptor(file.fd);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await file.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Failed to unlock and close the file mutex.");
}

export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? FILE_LOCK_HEARTBEAT_MS;
  const op = options.op ?? "unknown";

  const lockId = randomUUID();
  const payload: FileLockPayload = {
    version: LOCK_PAYLOAD_VERSION,
    lockId,
    pid: process.pid,
    host: os.hostname(),
    op,
    acquiredAt: new Date().toISOString(),
  };
  const data = JSON.stringify(payload);

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  const mutexFile = await fs.open(`${lockPath}.mutex`, "a+");
  let mutexLocked = false;
  let publicationAttempted = false;
  let attempt = 0;
  try {
    for (;;) {
      mutexLocked = tryLockFileDescriptor(mutexFile.fd);
      if (mutexLocked) {
        if (await prepareLockMetadata(lockPath, options.onStaleLockBroken)) {
          publicationAttempted = true;
          try {
            await fs.writeFile(lockPath, data, { encoding: "utf8", flag: "wx" });
            break;
          } catch (error) {
            if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
            // mutex を使わない旧クライアントによる作成は上書きしない。
            publicationAttempted = false;
          }
        }
        mutexLocked = false;
        unlockFileDescriptor(mutexFile.fd);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const holder = await readLockPayload(lockPath);
        const pidLabel = holder ? String(holder.pid) : te("electron.lock.unknownPid");
        throw new Error(te("electron.lock.timeout", { pid: pidLabel, path: lockPath }));
      }

      const backoff = Math.min(5 * 2 ** attempt, 100);
      const jitter = Math.floor(Math.random() * 5);
      attempt += 1;
      await sleep(backoff + jitter);
    }
  } catch (error) {
    const errors = [error];
    if (mutexLocked && publicationAttempted) {
      await removeFailedPublication(lockPath, lockId).catch((cleanupError: unknown) => { errors.push(cleanupError); });
    }
    await closeMutexFile(mutexFile, mutexLocked).catch((closeError: unknown) => { errors.push(closeError); });
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, "Failed to acquire and clean up the file mutex.");
  }

  const pendingHeartbeats = new Set<Promise<void>>();
  const heartbeat = setInterval(() => {
    const now = new Date();
    const update = fs.utimes(lockPath, now, now).catch(() => {
      // ロックが既に消えている等は無視。次回リリース時の再読込で判明する。
    }).finally(() => {
      pendingHeartbeats.delete(update);
    });
    pendingHeartbeats.add(update);
  }, heartbeatMs);
  heartbeat.unref();

  let released = false;
  return {
    lockId,
    async release(): Promise<boolean> {
      if (released) {
        return false;
      }
      released = true;
      clearInterval(heartbeat);
      try {
        await Promise.all(pendingHeartbeats);
        const current = await readLockPayload(lockPath);
        if (!current || current.lockId !== lockId) return false;
        try {
          await fs.unlink(lockPath);
        } catch (error) {
          if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
        }
        return true;
      } finally {
        await closeMutexFile(mutexFile, true);
      }
    },
  };
}
