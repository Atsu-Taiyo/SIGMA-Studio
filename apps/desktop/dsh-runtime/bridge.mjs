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
//
// サブエージェント (依頼の subagentToolName があるとき): 子のセッションのツール呼び出しも
// tool-call / tool-result として流す (本文と思考は流さない)。子を起動したツールの結果は、
// 起動した時点ではなく、その子が終わった時点で流す。
import { createInterface } from "node:readline";

const MAX_TOOL_RESULT_TEXT = 2_000;
const MAX_RESULT_IMAGES = 4;
// サブエージェントを使った実行で、全体が止まって見えてから終わりと決めるまでの待ち時間。
// 子が終わってから親へ完了の知らせが届くまでに、どのセッションも idle に見える短い間がある
// (dsh 0.2.1-rc.5 の実測で約 10 ミリ秒)。その間に終わりと決めないための余裕。
const SUBAGENT_SETTLE_GRACE_MS = 1_500;
// 受信箱に未読が残って見えるのに、どのセッションも動かないまま待つ上限。数え違いで
// 実行が終わらなくなるのを防ぐ (通常は完了の知らせがすぐ親を動かすので、ここまで待たない)。
const SUBAGENT_STALLED_INBOX_MS = 10_000;

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

/**
 * 1 つの依頼が動かすセッションの木 (親と、その子孫のサブエージェント) が、すべて終わったかを追う。
 *
 * SDK の `session.run` は親が最初に idle になった時点で終わる。サブエージェントは裏で動き、
 * 終わると親へ完了の知らせが届いて親がもう 1 ターン動くので、そこで畳むと子の作業と親の
 * 最終報告を捨ててしまう。次がすべて成り立つときだけ「終わった」とみなす:
 *   - 依頼を受け取った後で、親が idle
 *   - 起動した子がすべて終わっている (`subagent.started` に対する `subagent.finished`)
 *   - どのセッションも idle で、まだ読んでいない受信箱の内容が無い (完了の知らせを含む)
 */
export function createSessionTreeTracker(rootSessionId) {
  const statuses = new Map();
  const inboxes = new Map();
  const runningChildren = new Set();
  let usedSubagents = false;
  return {
    observe(notification) {
      if (!isRecord(notification) || !isRecord(notification.params)) return;
      const params = notification.params;
      if (notification.method === "subagent.started" && typeof params.childSessionId === "string") {
        usedSubagents = true;
        runningChildren.add(params.childSessionId);
        return;
      }
      if (notification.method === "subagent.finished" && typeof params.childSessionId === "string") {
        runningChildren.delete(params.childSessionId);
        return;
      }
      if (typeof params.sessionId !== "string") return;
      if (notification.method === "session.status" && typeof params.status === "string") {
        statuses.set(params.sessionId, params.status);
        return;
      }
      if (notification.method === "session.event" && isRecord(params.event)
        && params.event.type === "agent/inbox/spliced" && isRecord(params.event.data)) {
        const data = params.event.data;
        const inserted = Array.isArray(data.inserted) ? data.inserted.length : 0;
        const removed = Number.isInteger(data.removedCount) ? data.removedCount : 0;
        inboxes.set(params.sessionId, Math.max(0, (inboxes.get(params.sessionId) ?? 0) + inserted - removed));
      }
    },
    /** 親が idle か (サブエージェントを使わない実行は、これだけで終わりと決める)。 */
    isRootIdle: () => statuses.get(rootSessionId) === "idle",
    /** 親も子孫も動いておらず、起動した子がすべて終わっているか。 */
    isQuiet() {
      if (statuses.get(rootSessionId) !== "idle" || runningChildren.size > 0) return false;
      for (const status of statuses.values()) if (status !== "idle") return false;
      return true;
    },
    /** まだ読まれていない受信箱の内容 (子の完了の知らせなど) が残っているか。 */
    hasUnreadInbox() {
      for (const pending of inboxes.values()) if (pending > 0) return true;
      return false;
    },
    isSettled() {
      return this.isQuiet() && !this.hasUnreadInbox();
    },
    usedSubagents: () => usedSubagents,
  };
}

/** `subagent` ツールの結果 ("started subagent <id>") から、起動した子のセッション ID を取り出す。 */
export function parseStartedSubagentId(text) {
  return /^started subagent (\S+)/u.exec(typeof text === "string" ? text.trim() : "")?.[1] ?? null;
}

/**
 * サブエージェントを起動するツールの結果を、子が終わるまで預かる。
 *
 * dsh の `subagent` ツールは子の ID をすぐ返す (起動しただけ)。そのまま流すと進行表示の行が
 * すぐ完了になるので、起動に成功した結果は預かり、`subagent.finished` で流す。起動に失敗した
 * 結果 (深さや数の上限) はそのまま流す。
 */
export function createSubagentResultHold(subagentToolName) {
  const launchCallIds = new Set();
  const heldByChildId = new Map();
  return {
    /** 流してよいイベントを返す (預かったら空)。 */
    filter(projected) {
      if (!subagentToolName) return [projected];
      if (projected.type === "tool-call" && projected.name === subagentToolName) {
        launchCallIds.add(projected.id);
        return [projected];
      }
      if (projected.type === "tool-result" && launchCallIds.delete(projected.id)) {
        const childId = projected.isError ? null : parseStartedSubagentId(projected.text);
        if (childId) {
          heldByChildId.set(childId, projected);
          return [];
        }
      }
      return [projected];
    },
    /** 子が終わったときに、預かっていた結果を返す。 */
    release(notification) {
      if (!isRecord(notification) || notification.method !== "subagent.finished" || !isRecord(notification.params)) return [];
      const held = heldByChildId.get(notification.params.childSessionId);
      if (!held) return [];
      heldByChildId.delete(notification.params.childSessionId);
      return [{ ...held, isError: notification.params.status !== "ok", text: "" }];
    },
  };
}

/** 親の受信箱に、送った依頼 (messageId) が入ったことを知らせるイベントか。 */
function isInboxReceipt(event, messageId) {
  if (!isRecord(event) || event.type !== "agent/inbox/spliced" || !isRecord(event.data)) return false;
  const inserted = event.data.inserted;
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId);
}

/** 親の最後の応答の本文 (SDK の `finalResponse` と同じ決め方)。 */
export function finalResponseOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.type !== "assistant/message" || !isRecord(event.data) || !isRecord(event.data.message)) continue;
    const content = Array.isArray(event.data.message.content) ? event.data.message.content : [];
    return content.flatMap(block => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
  }
  return "";
}

/**
 * 依頼を 1 つ送り、セッションの木がすべて終わるまで見届ける。
 *
 * サブエージェントを使わない実行は、SDK の `session.run` と同じく親が idle になった時点で終わる。
 */
async function runUntilTreeSettles(client, sessionId, content, subagentToolName) {
  const tracker = createSessionTreeTracker(sessionId);
  const hold = createSubagentResultHold(subagentToolName);
  const rootEvents = [];
  const subscription = client.subscribeSessionTree(sessionId);
  try {
    const messageId = await client.prompt(sessionId, content);
    let received = false;
    let next = subscription.next();
    while (true) {
      let notification;
      // サブエージェントを使わない実行は、SDK の `session.run` と同じく親が idle になったら終わる。
      if (received && !tracker.usedSubagents() && tracker.isRootIdle()) break;
      if (received && tracker.isQuiet()) {
        // 誰も動いていない。少し待って何も届かなければ終わりと決める (届けば見届けを続ける)。
        let timer;
        const timedOut = Symbol("settled");
        const waitMs = tracker.hasUnreadInbox() ? SUBAGENT_STALLED_INBOX_MS : SUBAGENT_SETTLE_GRACE_MS;
        const winner = await Promise.race([
          next,
          new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), waitMs); }),
        ]);
        clearTimeout(timer);
        if (winner === timedOut) {
          // 見届け終えた。待たせたままの next() は、購読を閉じたときの失敗で終わる。
          next.catch(() => {});
          break;
        }
        notification = winner;
      } else {
        notification = await next;
      }
      next = subscription.next();
      const params = isRecord(notification.params) ? notification.params : {};
      const fromRoot = params.sessionId === sessionId;
      if (!received) {
        if (notification.method !== "session.event" || !fromRoot || !isInboxReceipt(params.event, messageId)) continue;
        received = true;
      }
      tracker.observe(notification);
      for (const released of hold.release(notification)) emit(released);
      if (notification.method !== "session.event") continue;
      if (fromRoot) rootEvents.push(params.event);
      for (const projected of projectSessionEvent(params.event)) {
        // 子の本文と思考は親の応答に混ぜない。ツールの動きだけを進行表示と編集案の数え上げに使う。
        if (!fromRoot && projected.type !== "tool-call" && projected.type !== "tool-result") continue;
        for (const event of hold.filter(projected)) emit(event);
      }
    }
  } finally {
    subscription.close();
  }
  return { sessionId, finalResponse: finalResponseOf(rootEvents), events: rootEvents };
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

  // 純粋な関数 (上の projectSessionEvent など) を、dsh の実行環境が無い場所からも読めるよう、
  // SDK はここで読み込む。
  const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");
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
    await harness.start();
    const result = await runUntilTreeSettles(
      harness.client,
      session.id,
      request.content,
      typeof request.subagentToolName === "string" && request.subagentToolName.length > 0 ? request.subagentToolName : null,
    );
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

if (import.meta.main) {
  await main();
}
