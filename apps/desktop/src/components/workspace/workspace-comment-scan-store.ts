import type { CommentScanRecord, CommentScanStore } from "./workspace-comment-scanner";

const KEY_PREFIX = "sigma-studio:workspace-comment-scan:v1:";

function isRecord(value: unknown): value is CommentScanRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CommentScanRecord>;
  return typeof record.stamp === "string"
    && typeof record.scannedAt === "number" && Number.isFinite(record.scannedAt)
    && Array.isArray(record.threads)
    && record.threads.every((thread) => typeof thread === "object" && thread !== null && typeof (thread as { threadId?: unknown }).threadId === "string");
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * コメント走査の結果を、サインイン中のユーザーごとに端末へ残す。共有教材の本文は端末に既に
 * 保存されているので、それを読んだ結果 (メンションの抜粋) も同じ端末内に留まる。別のユーザーの
 * 結果は、そのユーザーで入り直したときに取り除く。保存できない環境では何も残さず動く。
 */
export function createCommentScanStore(userId: string, storage: Storage | null = browserStorage()): CommentScanStore | undefined {
  if (!storage) return undefined;
  const key = `${KEY_PREFIX}${userId}`;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const other = storage.key(index);
      if (other && other.startsWith(KEY_PREFIX) && other !== key) storage.removeItem(other);
    }
  } catch {
    // 掃除に失敗しても走査には影響しない。
  }
  return {
    load() {
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isRecord(value)));
      } catch {
        return null;
      }
    },
    save(records) {
      try {
        storage.setItem(key, JSON.stringify(records));
      } catch {
        // 容量超過・保存禁止では、次の起動で読み直すだけ。
      }
    },
  };
}
