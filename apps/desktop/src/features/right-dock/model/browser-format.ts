import type { InAppBrowserDownload, InAppBrowserTab } from "@/lib/browser/in-app-browser-contract";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** ダウンロードの大きさ表示 (1024 進)。小数は 1 桁までで、B は整数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}

/** アドレスバーに出す URL。プロトコルと末尾のスラッシュは省き、ページの場所だけを見せる。 */
export function displayAddress(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.protocol === "http:" ? "http://" : ""}${parsed.host}${rest}`;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** タブに出す名前。題名が無ければドメイン、何も開いていなければ空。 */
export function tabLabel(tab: Pick<InAppBrowserTab, "title" | "url">): string {
  return tab.title.trim() || hostOf(tab.url);
}

export function downloadFraction(download: Pick<InAppBrowserDownload, "receivedBytes" | "totalBytes">): number | null {
  return download.totalBytes > 0 ? Math.min(1, download.receivedBytes / download.totalBytes) : null;
}

export function activeDownloadCount(downloads: readonly Pick<InAppBrowserDownload, "state">[]): number {
  return downloads.filter((download) => download.state === "progressing" || download.state === "interrupted").length;
}

/** -1 (入力欄そのもの) を含めて循環させる: 入力欄 → 候補1 → … → 最後 → 入力欄。 */
export function nextHighlight(current: number, step: 1 | -1, count: number): number {
  const slots = count + 1;
  return ((current + 1 + step + slots) % slots) - 1;
}
