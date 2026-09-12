import fs from "node:fs/promises";
import path from "node:path";

import { SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV, toolActivityFileName } from "../electron/ai-edit-run-context";
import { SIGMA_STUDIO_MCP_PROVIDER_ENV } from "../electron/sigma-studio-mcp-launch";

export type ToolActivityStatus = "started" | "completed" | "failed";

export interface ToolActivityEvent {
  callId: string;
  tool: string;
  runId?: string;
  status: ToolActivityStatus;
}

export type ToolActivityLogger = (event: ToolActivityEvent) => void;

// Claude / Codex はプロトコル上 tool_use イベントが流れるためUIのツール実行表示を作れるが、
// Antigravity CLI (`agy --print`) のprintモードは最終応答のプレーンテキストのみを出力し、
// ツール呼び出しイベントを一切流さない (実機確認済み)。そのためツール呼び出しの検知は
// 共有MCPサーバー自身の責務にし、呼び出しをJSONLファイル (<provider>[-<runId>].tool-activity.jsonl、
// run-contextファイルと同じディレクトリ) へ記録する。デスクトップ側 (electron/
// gemini-tool-activity-watcher.ts) がこのファイルをポーリングし、UIの「ツール実行中...」表示へ
// 変換する。Antigravity以外のプロバイダでは常にnoopを返す (env未設定/provider不一致)。
export function createToolActivityLogger(env: Record<string, string | undefined>): ToolActivityLogger {
  const provider = env[SIGMA_STUDIO_MCP_PROVIDER_ENV];
  const runContextFile = env[SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]?.trim();
  if (provider !== "antigravity" || !runContextFile) {
    return () => {};
  }

  const dir = path.dirname(runContextFile);
  // ファイルパスごとに直前の書き込みPromiseを保持し、追記を直列化する。fs.appendFileを
  // 都度await無しで呼ぶと (start→completedのような同一ツールの連続イベントで) OS側の
  // 書き込み順序が入れ替わり、JSONLの行順がイベント発生順と一致しなくなる (実際にテストで
  // 再現した)。ツール実行自体は待たせない (fire-and-forget) が、ファイルへの追記だけは
  // 前の書き込み完了後に行う。
  const pendingWrites = new Map<string, Promise<void>>();

  return (event) => {
    const filePath = path.join(dir, toolActivityFileName("antigravity", event.runId));
    const record: Record<string, unknown> = {
      ts: Date.now(),
      callId: event.callId,
      tool: event.tool,
      status: event.status,
    };
    if (event.runId) {
      record.runId = event.runId;
    }
    const line = `${JSON.stringify(record)}\n`;
    const previous = pendingWrites.get(filePath) ?? Promise.resolve();
    // fire-and-forget: 記録の失敗でツール実行そのものを阻害してはならない。
    const next = previous.then(() => fs.appendFile(filePath, line, "utf8")).catch(() => {});
    pendingWrites.set(filePath, next);
  };
}
