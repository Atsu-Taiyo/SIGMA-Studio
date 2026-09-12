import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { toolActivityFileName } from "./ai-edit-run-context";

export type ToolActivityStatus = "started" | "completed" | "failed";

export interface ToolActivityEvent {
  callId: string;
  tool: string;
  runId?: string;
  status: ToolActivityStatus;
}

export interface ToolActivityWatcherOptions {
  /** Directory containing the run-context files (see ai-edit-run-context.ts's runContextDirPath). */
  runContextDir: string;
  runId: string;
  /** Test-only override for the poll interval (default 400ms). */
  pollIntervalMs?: number;
  onActivity: (event: ToolActivityEvent) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 400;

interface WatchedFile {
  path: string;
  offset: number;
  buffer: string;
}

// Antigravity CLI (`agy --print`) はツール呼び出しイベントを一切出力しない。共有MCPサーバー
// (mcp/tool-activity.ts) が自分で呼び出しをJSONLファイルへ記録するので、このwatcherはそのファイルを
// ポーリングして完了した行をパースし、UIの「ツール実行中...」イベントに変換する (gemini-edit.ts
// から使う)。監視対象は2つ: このrun専用のper-runファイル (runId単位、start前は存在しないので
// オフセット0から) と、複数runで共有される静的ファイル (start()時点のファイルサイズから読み始め、
// 過去runの残骸を今回のrunの活動として出さないようにする)。
export class ToolActivityWatcher {
  private readonly runId: string;
  private readonly pollIntervalMs: number;
  private readonly onActivity: (event: ToolActivityEvent) => void;
  private readonly perRunFile: WatchedFile;
  private readonly staticFile: WatchedFile;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(options: ToolActivityWatcherOptions) {
    this.runId = options.runId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onActivity = options.onActivity;
    const perRunPath = path.join(options.runContextDir, toolActivityFileName("antigravity", this.runId));
    const staticPath = path.join(options.runContextDir, toolActivityFileName("antigravity"));
    this.perRunFile = { path: perRunPath, offset: 0, buffer: "" };
    this.staticFile = { path: staticPath, offset: getFileSizeOrZero(staticPath), buffer: "" };
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 最終ドレイン: stop() 呼び出し直前に書かれた行を取りこぼさない。
    await this.poll();
    await fs.unlink(this.perRunFile.path).catch(() => {});
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.drainFile(this.perRunFile);
      await this.drainFile(this.staticFile);
    } finally {
      this.polling = false;
    }
  }

  private async drainFile(file: WatchedFile): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await fs.open(file.path, "r");
    } catch {
      // ファイルがまだ存在しない (ENOENT) 間は静かに待つ。他のエラーも同様にスキップする
      // (ツール実行表示の欠落はUXの劣化に留まり、AI編集そのものを止めてはならない)。
      return;
    }
    try {
      const stat = await handle.stat();
      if (stat.size <= file.offset) {
        return;
      }
      const length = stat.size - file.offset;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, file.offset);
      file.offset = stat.size;

      const text = file.buffer + chunk.toString("utf8");
      const lines = text.split("\n");
      file.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const event = parseToolActivityLine(line);
        if (event) {
          this.onActivity(event);
        }
      }
    } finally {
      await handle.close();
    }
  }
}

function parseToolActivityLine(line: string): ToolActivityEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.callId !== "string" || typeof parsed.tool !== "string") {
    return null;
  }
  if (parsed.status !== "started" && parsed.status !== "completed" && parsed.status !== "failed") {
    return null;
  }
  return {
    callId: parsed.callId,
    tool: parsed.tool,
    status: parsed.status,
    ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
  };
}

function getFileSizeOrZero(filePath: string): number {
  try {
    return fsSync.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
