#!/usr/bin/env node
// SIGMA Studio ⇄ DeepSeek Harness (dsh) の橋渡し。
//
// dsh は Node の内部モジュールへ触るネイティブ部品を持ち、Electron 内蔵の Node では
// 起動できない (対応する実行環境が固定されている)。そこでアプリ (Electron main) は
// このファイルを**本物の Node**で起動し、JSON 行でやり取りする。dsh の起動と制御は
// 公式 SDK (@deepseek-ai/dsh-sdk-client) の公開 API だけで行う。
//
// stdin : 1 行目に実行依頼 (JSON)。閉じられたら中断として扱う。
// stdout: 1 行 1 イベント (JSON)。dsh の session.event はここで必要な形へ絞る
//         (システムプロンプトやツール定義の全文を main へ流さない)。
//
//   {type:"session", sessionId}
//   {type:"text", text} / {type:"reasoning", text}
//   {type:"tool-call", id, name, arguments}
//   {type:"tool-result", id, isError, text, images:[{mimeType, data}]}
//   {type:"result", sessionId, finalResponse, endReason}
//   {type:"error", code, message}
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

const MAX_TOOL_RESULT_TEXT = 2_000;
const MAX_RESULT_IMAGES = 4;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * 最後のイベントを書き切ってから終わる。`process.exit` は書きかけのパイプを待たないので、
 * 長い最終応答が途中で切れ、受け取る側が壊れた行として捨ててしまう。
 * 受け取る側が先に閉じていても (EPIPE) 終了処理へ進めるよう、失敗でも解決する。
 */
function emitFinal(event) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify(event)}\n`, () => resolve());
    } catch {
      resolve();
    }
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeFailure(error) {
  if (!isRecord(error)) return String(error ?? "unknown error");
  const parts = [error.code, error.status, error.message].filter(value => typeof value === "string" || typeof value === "number");
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(error).slice(0, 500);
}

/** dsh の 1 イベントを、main が表示に使う最小のイベントへ写す。 */
export function projectSessionEvent(event) {
  if (!isRecord(event) || !isRecord(event.data)) return [];
  const data = event.data;
  if (event.type === "assistant/message" && isRecord(data.message) && Array.isArray(data.message.content)) {
    return data.message.content.flatMap((block) => {
      if (!isRecord(block) || typeof block.text !== "string" || block.text.length === 0) return [];
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "reasoning") return [{ type: "reasoning", text: block.text }];
      return [];
    });
  }
  if (event.type === "tool/call" && typeof data.name === "string") {
    return [{ type: "tool-call", id: String(data.callId ?? ""), name: data.name, arguments: typeof data.arguments === "string" ? data.arguments : "" }];
  }
  if (event.type === "tool/result" && isRecord(data.message)) {
    const content = Array.isArray(data.message.content) ? data.message.content : [];
    const text = content
      .flatMap(block => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])
      .join("\n")
      .slice(0, MAX_TOOL_RESULT_TEXT);
    const images = content
      .flatMap(block => isRecord(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
        ? [{ mimeType: block.mimeType, data: block.data }]
        : [])
      .slice(0, MAX_RESULT_IMAGES);
    return [{
      type: "tool-result",
      id: String(data.message.toolCallId ?? ""),
      isError: data.message.isError === true || isRecord(data.error),
      text,
      images,
    }];
  }
  return [];
}

/** 最後の turn/end の理由を、main が分岐できる形で返す。 */
export function describeTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isRecord(event) && event.type === "turn/end" && isRecord(event.data) && isRecord(event.data.reason)) {
      const reason = event.data.reason;
      return {
        kind: typeof reason.kind === "string" ? reason.kind : "unknown",
        ...(reason.kind === "error" ? { message: describeFailure(reason.error) } : {}),
      };
    }
  }
  return { kind: "unknown" };
}

async function readRequest(lines) {
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    return JSON.parse(line);
  }
  return null;
}

async function main() {
  const lines = createInterface({ input: process.stdin });
  const request = await readRequest(lines[Symbol.asyncIterator]());
  if (!isRecord(request)) {
    emit({ type: "error", code: "BAD_REQUEST", message: "The bridge received no run request." });
    process.exitCode = 2;
    return;
  }

  const harness = new DeepSeekHarness({
    profile: request.profile,
    patches: request.patches,
    dshHome: request.dshHome,
    cwd: request.cwd,
    processCwd: request.cwd,
    provider: request.provider,
    model: request.model,
    ...(typeof request.reasoningEffort === "string" ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(Number.isInteger(request.maxTokens) ? { maxTokens: request.maxTokens } : {}),
    initializeTimeoutMs: Number.isInteger(request.initializeTimeoutMs) ? request.initializeTimeoutMs : 60_000,
  });

  // 中断: main が stdin を閉じるか SIGTERM を送る。dsh には turn 単位の中断が無いので、
  // ランタイムごと閉じる (SDK が子プロセスの終了まで面倒を見る)。
  let closing = null;
  const shutdown = (code) => {
    closing ??= harness.close().catch(() => {}).finally(() => process.exit(code));
    return closing;
  };
  process.stdin.on("end", () => void shutdown(130));
  // 受け取る側 (アプリ) が先に閉じたら、書き込みの失敗で落ちずに dsh を畳む。
  process.stdout.on("error", () => void shutdown(141));
  process.on("SIGTERM", () => void shutdown(143));
  process.on("SIGINT", () => void shutdown(130));

  try {
    let session;
    if (typeof request.sessionId === "string" && request.sessionId.length > 0) {
      try {
        session = await harness.resumeSession(request.sessionId);
      } catch (error) {
        // 黙って新しい会話にしない。続きの依頼は短い指示だけなので、履歴も基本の指示も無い
        // まま走ってしまう。呼び出し側が全文の指示で新しい会話としてやり直す。
        await emitFinal({ type: "error", code: "RESUME_FAILED", message: error instanceof Error ? error.message : String(error) });
        await harness.close().catch(() => {});
        process.exit(1);
      }
    } else {
      session = harness.session();
    }
    emit({ type: "session", sessionId: session.id });
    const result = await session.run(request.content, {
      onNotification: (notification) => {
        if (notification.method !== "session.event" || notification.params.sessionId !== session.id) return;
        for (const projected of projectSessionEvent(notification.params.event)) emit(projected);
      },
    });
    await emitFinal({ type: "result", sessionId: result.sessionId, finalResponse: result.finalResponse, endReason: describeTurnEnd(result.events) });
    await harness.close();
    process.exit(0);
  } catch (error) {
    if (closing) return;
    await emitFinal({ type: "error", code: error?.name ?? "ERROR", message: error instanceof Error ? error.message : String(error) });
    await harness.close().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
