/**
 * main が投げた失敗の理由。Electron は IPC の失敗に
 * `Error invoking remote method 'storage:duplicate-file': Error: ` を付けて renderer へ渡すので、それを外す。
 * 利用者に見せる文に、内部の呼び出し名を混ぜないために使う。
 */
export function ipcFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/u, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/u, "")
    .trim();
}
