import { randomUUID } from "node:crypto";
import path from "node:path";
import { unusedFilenameSync } from "unused-filename";

import type { InAppBrowserDownload } from "@/lib/browser/in-app-browser-contract";

/** DownloadItem のうち追跡に使う部分。テストで EventEmitter に置き換えられる。 */
export interface DownloadItemLike {
  getFilename(): string;
  getURL(): string;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  setSavePath(savePath: string): void;
  cancel(): void;
  on(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  on(event: "done", listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void): unknown;
}

export interface DownloadTrackerOptions {
  /** 保存先フォルダ。ダイアログは出さず、ここへ直接保存する。 */
  downloadsDir(): string;
  onChange(downloads: InAppBrowserDownload[]): void;
  /** 完了したときの通知 (Dockのバウンドなど)。 */
  onCompleted?(download: InAppBrowserDownload): void;
  /** 進行中の合計進捗 0..1、無ければ null。タスクバー/Dockの進捗表示用。 */
  onProgress?(fraction: number | null): void;
  now?(): number;
  /** 連続する updated を間引く間隔 (ms)。 */
  throttleMs?: number;
}

const MAX_HISTORY = 50;

/**
 * ブラウザのダウンロードを、確認ダイアログなしで「ダウンロード」フォルダへ保存して追跡する。
 * 同名ファイルは上書きせず連番にする (unused-filename)。ファイルを開く・フォルダで表示する
 * などの操作は、追跡している ID からだけ受け付け、レンダラから任意のパスを受け取らない。
 */
export class DownloadTracker {
  private readonly downloads: InAppBrowserDownload[] = [];
  private readonly items = new Map<string, DownloadItemLike>();
  private readonly now: () => number;
  private readonly throttleMs: number;
  private lastEmit = 0;
  private pendingEmit: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DownloadTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.throttleMs = options.throttleMs ?? 120;
  }

  list(): InAppBrowserDownload[] {
    return this.downloads.map((download) => ({ ...download }));
  }

  track(item: DownloadItemLike): InAppBrowserDownload {
    const id = randomUUID();
    const filename = safeFilename(item.getFilename());
    const savePath = unusedFilenameSync(path.join(this.options.downloadsDir(), filename));
    item.setSavePath(savePath);
    const download: InAppBrowserDownload = {
      id,
      filename: path.basename(savePath),
      sourceUrl: item.getURL(),
      savePath,
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: this.now(),
    };
    this.downloads.unshift(download);
    this.items.set(id, item);
    this.trim();

    item.on("updated", (_event, state) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      // 中断は再開されるかもしれないので、終わりとは扱わない。
      download.state = state === "interrupted" ? "interrupted" : "progressing";
      this.emit(false);
    });
    item.on("done", (_event, state) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes() || download.receivedBytes;
      download.state = state;
      this.items.delete(id);
      this.emit(true);
      if (state === "completed") this.options.onCompleted?.({ ...download });
    });
    this.emit(true);
    return download;
  }

  cancel(id: string): void {
    this.items.get(id)?.cancel();
  }

  /** 完了したダウンロードの保存先。追跡していない ID や未完了は null。 */
  completedPath(id: string): string | null {
    const download = this.downloads.find((candidate) => candidate.id === id);
    return download?.state === "completed" ? download.savePath : null;
  }

  /** 履歴から終わったものを消す。進行中は残す。 */
  clearFinished(): void {
    for (let index = this.downloads.length - 1; index >= 0; index -= 1) {
      if (this.downloads[index].state !== "progressing" && this.downloads[index].state !== "interrupted") {
        this.downloads.splice(index, 1);
      }
    }
    this.emit(true);
  }

  cancelAll(): void {
    for (const item of this.items.values()) item.cancel();
  }

  dispose(): void {
    if (this.pendingEmit) clearTimeout(this.pendingEmit);
    this.pendingEmit = null;
    this.cancelAll();
  }

  private trim(): void {
    while (this.downloads.length > MAX_HISTORY) {
      const oldest = this.downloads[this.downloads.length - 1];
      if (oldest.state === "progressing") break;
      this.downloads.pop();
    }
  }

  private emit(immediate: boolean): void {
    const send = () => {
      this.pendingEmit = null;
      this.lastEmit = this.now();
      this.options.onChange(this.list());
      this.options.onProgress?.(this.totalProgress());
    };
    if (immediate) {
      if (this.pendingEmit) clearTimeout(this.pendingEmit);
      send();
      return;
    }
    const wait = this.throttleMs - (this.now() - this.lastEmit);
    if (wait <= 0) send();
    else if (!this.pendingEmit) this.pendingEmit = setTimeout(send, wait);
  }

  private totalProgress(): number | null {
    const active = this.downloads.filter((download) => download.state === "progressing" || download.state === "interrupted");
    if (active.length === 0) return null;
    const total = active.reduce((sum, download) => sum + download.totalBytes, 0);
    if (total <= 0) return 2; // 総量が不明: 不確定進捗 (Electron の setProgressBar は >1 で indeterminate)
    return Math.min(1, active.reduce((sum, download) => sum + download.receivedBytes, 0) / total);
  }
}

/** Chromium が付けた名前でも、パス区切りや制御文字を含まない単一のファイル名に整える。 */
export function safeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 200) : "download";
}
