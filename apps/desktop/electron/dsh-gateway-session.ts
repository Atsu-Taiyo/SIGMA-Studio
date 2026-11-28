import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DshGatewayAccount {
  authorization(): Promise<string>;
  accountSignal(): AbortSignal;
}

/** 中継 (apps/web/ai-gateway) が要求を断った理由。`code` は中継の `error.code` (利用枠・プラン・回数制限)。 */
export interface DshGatewayRefusal {
  status: number;
  code: string | null;
  /** 利用枠が戻る時刻 (ISO 8601)。`USAGE_LIMIT_REACHED` のときだけ付く。 */
  resetsAt: string | null;
}

/**
 * この turn の中継のやり取りを main が見るための口。DSH は中継の応答を自分の言葉の
 * エラーに直してしまうので、止められた理由と使用量はここで読む。
 */
export interface DshGatewayObserver {
  onRefusal?(refusal: DshGatewayRefusal): void;
  /** モデルの応答ごとの使用量 (OpenAI Chat Completions 互換の `usage`)。 */
  onUsage?(usage: unknown): void;
}

// 断られた応答の本文と、使用量を探すために覚えておく行の上限。本文そのものは切らずに流す。
const MAX_REFUSAL_BODY_CHARS = 64 * 1024;
const MAX_USAGE_LINE_CHARS = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRefusal(status: number, text: string): DshGatewayRefusal {
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error;
    if (isRecord(error)) {
      return {
        status,
        code: typeof error.code === "string" ? error.code : null,
        resetsAt: typeof error.resetsAt === "string" ? error.resetsAt : null,
      };
    }
  } catch {
    // 中継以外 (経路上の別のサーバー) が返した本文。状態コードだけを伝える。
  }
  return { status, code: null, resetsAt: null };
}

/** 流れていく応答から `usage` を持つ行だけを読む。SSE の `data:` 行と、ストリームでない JSON 応答の両方。 */
function createUsageTap(onUsage: (usage: unknown) => void) {
  const decoder = new TextDecoder();
  let carry = "";
  // ストリームでない JSON 応答の全文。SSE と分かった時点で捨てる。
  let json: string | null = "";
  const report = (text: string) => {
    try {
      const usage = (JSON.parse(text) as { usage?: unknown }).usage;
      if (isRecord(usage)) onUsage(usage);
    } catch {
      // 壊れた行は使用量として読まない。応答そのものは加工せずに流れている。
    }
  };
  const inspect = (line: string) => {
    if (!line.startsWith("data:")) return;
    json = null;
    const data = line.slice(5).trim();
    if (data.includes("\"usage\"")) report(data);
  };
  const feed = (text: string) => {
    if (json !== null) json = json.length + text.length > MAX_USAGE_LINE_CHARS ? null : json + text;
    carry += text;
    let index = carry.indexOf("\n");
    while (index !== -1) {
      inspect(carry.slice(0, index));
      carry = carry.slice(index + 1);
      index = carry.indexOf("\n");
    }
    if (carry.length > MAX_USAGE_LINE_CHARS) carry = "";
  };
  return {
    push(chunk: Uint8Array) {
      feed(decoder.decode(chunk, { stream: true }));
    },
    end() {
      feed(decoder.decode());
      inspect(carry);
      carry = "";
      if (json !== null && json.trimStart().startsWith("{")) report(json);
    },
  };
}

/** Keep the SIGMA account credential in Electron main. DSH receives only a key for this local turn. */
export async function startDshGatewaySession(
  upstream: string,
  account: DshGatewayAccount,
  fetcher: typeof fetch = fetch,
  observer: DshGatewayObserver = {},
): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const accountSignal = account.accountSignal();
  const lifetime = new AbortController();
  const server = createServer(async (request, response) => {
    const presented = Buffer.from(request.headers.authorization ?? "");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      response.writeHead(401).end();
      return;
    }
    const chat = request.method === "POST" && request.url === "/v1/chat/completions";
    if (!chat && !(request.method === "GET" && request.url === "/v1/models")) {
      response.writeHead(404).end();
      return;
    }
    const connection = new AbortController();
    response.once("close", () => connection.abort());
    const signal = AbortSignal.any([lifetime.signal, accountSignal, connection.signal]);
    try {
      signal.throwIfAborted();
      const authorization = await account.authorization();
      signal.throwIfAborted();
      const result = await fetcher(`${upstream}/${chat ? "chat/completions" : "models"}`, {
        method: request.method,
        headers: { authorization, ...(chat ? { "content-type": "application/json" } : {}) },
        ...(chat ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
        redirect: "error",
        signal,
      });
      const type = result.headers.get("content-type") ?? "application/json";
      const retryAfter = result.headers.get("retry-after");
      const head = { "content-type": type, "cache-control": "no-store", ...(retryAfter ? { "retry-after": retryAfter } : {}) };
      if (!result.ok) {
        // 断られた応答は短い。理由を読んでから、同じ本文を DSH へ返す。
        const text = await result.text();
        try {
          observer.onRefusal?.(parseRefusal(result.status, text.slice(0, MAX_REFUSAL_BODY_CHARS)));
        } catch {
          // 見ている側の失敗で、応答を止めない。
        }
        response.writeHead(result.status, head).end(text);
        return;
      }
      response.writeHead(result.status, head);
      if (!result.body) {
        response.end();
        return;
      }
      const body = result.body as unknown as AsyncIterable<Uint8Array>;
      const tap = chat && observer.onUsage ? createUsageTap(observer.onUsage) : null;
      const tapped = tap
        ? (async function* () {
            for await (const chunk of body) {
              try { tap.push(chunk); } catch { /* 読み取りの失敗で、応答を止めない。 */ }
              yield chunk;
            }
            try { tap.end(); } catch { /* 同上。 */ }
          })()
        : body;
      await pipeline(Readable.from(tapped), response, { signal });
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(accountSignal.aborted ? 401 : 502).end();
    }
  });
  const close = () => {
    lifetime.abort();
    server.close();
    server.closeAllConnections();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    close();
    throw new Error("The local SIGMA AI gateway could not start.");
  }
  return { url: `http://127.0.0.1:${address.port}/v1`, token, close };
}
