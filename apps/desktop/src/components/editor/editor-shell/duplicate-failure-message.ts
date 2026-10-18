import type { Translate } from "@/lib/i18n";

/**
 * main が投げた失敗の理由。Electron は IPC の失敗に
 * `Error invoking remote method 'storage:duplicate-file': Error: ` を付けて renderer へ渡すので、それを外す。
 */
export function ipcFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/u, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/u, "")
    .trim();
}

const OFFLINE = /^(?:CATALOG_OFFLINE|NETWORK_UNAVAILABLE|HTTP_5\d\d|HTTP_429|RATE_LIMITED)$|fetch failed|network|timed? ?out|aborted|ECONN|ENOTFOUND|EAI_AGAIN/iu;

/**
 * 教材の複製に失敗した理由を、利用者が次に何をすればよいか分かる文にする (#250)。
 * 内部の呼び出し名やエラーコードだけの文は見せない。main がすでに日本語の理由を返した
 * (ローカル教材の「複製元の教材が見つかりません」など) ときは、それをそのまま見せる。
 */
export function duplicateFailureMessage(error: unknown, t: Translate<"editor">): string {
  const reason = ipcFailureReason(error);
  if (reason === "FORBIDDEN") return t("status.creationNotAllowed");
  // ここでの READ_ONLY は、権限を外された複製元のセッション。
  if (/^(?:TARGET_UNAVAILABLE|DOCUMENT_UNAVAILABLE|READ_ONLY|SHARED_SESSION_REQUIRED|SESSION_IDENTITY_MISMATCH)$/u.test(reason)) return t("status.duplicateSourceUnavailable");
  if (reason === "HIERARCHY_SHARE_IN_PROGRESS") return t("status.duplicateShareInProgress");
  if (/^(?:AUTH_REQUIRED|AUTH_EXPIRED|ACCOUNT_CHANGED)$/u.test(reason)) return t("status.duplicateSignInRequired");
  if (/^(?:MISSING_ASSET|INVALID_ASSET|ASSET_SOURCE_UNAVAILABLE)$/u.test(reason)) return t("status.duplicateImagesUnavailable");
  if (OFFLINE.test(reason)) return t("status.duplicateOffline");
  // ASCII だけの文はコードか英語の内部メッセージ。理由の手がかりとしてコードだけ添える。
  if (/^[A-Z][A-Z0-9_]{1,99}$/u.test(reason)) return t("status.duplicateFailedWithCode", { code: reason });
  if (reason && /[^\x20-\x7E]/u.test(reason)) return reason;
  return t("status.duplicateFailed");
}
