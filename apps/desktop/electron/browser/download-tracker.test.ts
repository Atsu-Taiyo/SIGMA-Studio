import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InAppBrowserDownload } from "@/lib/browser/in-app-browser-contract";
import { DownloadTracker, safeFilename, type DownloadItemLike } from "./download-tracker";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeItem extends EventEmitter implements DownloadItemLike {
  received = 0;
  total = 100;
  savePath: string | null = null;
  cancelled = false;
  constructor(private readonly name: string, private readonly url = "https://example.com/file") {
    super();
  }
  getFilename() { return this.name; }
  getURL() { return this.url; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  setSavePath(savePath: string) { this.savePath = savePath; }
  cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); }
}

function setup(options: { throttleMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "download-tracker-"));
  dirs.push(dir);
  const changes: InAppBrowserDownload[][] = [];
  const completed: InAppBrowserDownload[] = [];
  const progress: Array<number | null> = [];
  const tracker = new DownloadTracker({
    downloadsDir: () => dir,
    onChange: (downloads) => changes.push(downloads),
    onCompleted: (download) => completed.push(download),
    onProgress: (fraction) => progress.push(fraction),
    throttleMs: options.throttleMs ?? 0,
  });
  return { dir, tracker, changes, completed, progress };
}

describe("DownloadTracker", () => {
  it("saves straight into the downloads folder without asking, tracking progress to completion", () => {
    const { dir, tracker, changes, completed, progress } = setup();
    const item = new FakeItem("worksheet.pdf");

    const download = tracker.track(item);
    expect(item.savePath).toBe(path.join(dir, "worksheet.pdf"));
    expect(download).toMatchObject({ filename: "worksheet.pdf", state: "progressing", sourceUrl: "https://example.com/file" });

    item.received = 40;
    item.emit("updated", {}, "progressing");
    expect(tracker.list()[0]).toMatchObject({ receivedBytes: 40, totalBytes: 100, state: "progressing" });
    expect(progress.at(-1)).toBeCloseTo(0.4);

    item.received = 100;
    item.emit("done", {}, "completed");
    expect(tracker.list()[0].state).toBe("completed");
    expect(completed).toHaveLength(1);
    expect(progress.at(-1)).toBeNull();
    expect(tracker.completedPath(download.id)).toBe(path.join(dir, "worksheet.pdf"));
    expect(changes.length).toBeGreaterThan(2);
  });

  it("never overwrites an existing file, appending a number instead", () => {
    const { dir, tracker } = setup();
    writeFileSync(path.join(dir, "figure.png"), "x");
    const item = new FakeItem("figure.png");

    tracker.track(item);

    expect(item.savePath).toBe(path.join(dir, "figure (1).png"));
    expect(tracker.list()[0].filename).toBe("figure (1).png");
  });

  it("cancels an in-flight download and refuses to hand out a path for anything unfinished", () => {
    const { tracker } = setup();
    const item = new FakeItem("big.zip");
    const { id } = tracker.track(item);

    expect(tracker.completedPath(id)).toBeNull();
    tracker.cancel(id);

    expect(item.cancelled).toBe(true);
    expect(tracker.list()[0].state).toBe("cancelled");
    expect(tracker.completedPath(id)).toBeNull();
    expect(tracker.completedPath("not-a-tracked-id")).toBeNull();
  });

  it("keeps an interrupted download in the active set so it can resume", () => {
    const { tracker, progress } = setup();
    const item = new FakeItem("a.bin");
    tracker.track(item);

    item.received = 10;
    item.emit("updated", {}, "interrupted");

    expect(tracker.list()[0].state).toBe("interrupted");
    expect(progress.at(-1)).toBeCloseTo(0.1);
    tracker.clearFinished();
    expect(tracker.list()).toHaveLength(1);
  });

  it("clears finished downloads but keeps the ones still running", () => {
    const { tracker } = setup();
    const done = new FakeItem("done.txt");
    const running = new FakeItem("running.txt");
    tracker.track(done);
    tracker.track(running);
    done.emit("done", {}, "completed");

    tracker.clearFinished();

    expect(tracker.list().map((download) => download.filename)).toEqual(["running.txt"]);
  });

  it("reports indeterminate progress when the size is unknown", () => {
    const { tracker, progress } = setup();
    const item = new FakeItem("stream.bin");
    item.total = 0;
    tracker.track(item);

    item.received = 5;
    item.emit("updated", {}, "progressing");

    expect(progress.at(-1)).toBe(2);
  });

  it("throttles rapid progress updates but always delivers completion", () => {
    vi.useFakeTimers();
    try {
      const { tracker, changes } = setup({ throttleMs: 100 });
      const item = new FakeItem("t.bin");
      tracker.track(item);
      const before = changes.length;
      for (let received = 1; received <= 10; received += 1) {
        item.received = received;
        item.emit("updated", {}, "progressing");
      }
      expect(changes.length - before).toBeLessThanOrEqual(1);
      item.emit("done", {}, "completed");
      expect(changes.at(-1)?.[0].state).toBe("completed");
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("safeFilename", () => {
  it("reduces a suggested name to a single safe path segment", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("a\\b\\c.txt")).toBe("c.txt");
    expect(safeFilename("bad:na?me*.pdf")).toBe("bad_na_me_.pdf");
    expect(safeFilename("..")).toBe("download");
    expect(safeFilename("   ")).toBe("download");
    expect(safeFilename("日本語 の 資料.pdf")).toBe("日本語 の 資料.pdf");
  });
});
