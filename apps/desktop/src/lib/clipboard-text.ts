/**
 * テキストをクリップボードへ書き込む。async Clipboard API は Electron/ブラウザの
 * 権限で拒否され得るので、copy イベント経由の同期パスへフォールバックする。
 */
export async function writeTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 権限で拒否された場合は下の copy イベントへ落ちる。
    }
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  let copied = false;
  const handleCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    copied = true;
  };

  document.addEventListener("copy", handleCopy, true);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", handleCopy, true);
  }
  return copied;
}
