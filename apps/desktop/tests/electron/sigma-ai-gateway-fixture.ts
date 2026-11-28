import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 内蔵AIの中継 (apps/web/ai-gateway) の代役。OpenAI Chat Completions 互換の SSE を返す。
 *
 * モデルの応答は台本 (`script`) で決める。台本は届いたリクエストを見て「ツールを呼ぶ」か
 * 「本文で答える」かを返すので、教材を読んでから書く流れを本物の MCP サーバーに対して
 * 再現できる (モデルだけが偽物で、dsh・MCP・提案の記録・承認は本物)。
 */
export interface GatewayRequest {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
}

export type GatewayReply =
  | { text: string }
  | { say?: string; tool: string; arguments: Record<string, unknown> };

/** 中継の `GET /v1/usage` が返す、利用枠の状態 (本物の中継と同じ形)。 */
export interface GatewayAllowance {
  plan: string;
  included: boolean;
  weekly: { usedRatio: number; resetsAt: string | null; reached: boolean } | null;
}

export interface GatewayFixture {
  url: string;
  token: string;
  /** 届いたリクエスト (認証を通ったもの)。 */
  requests: GatewayRequest[];
  /** トークン無し・不一致で弾いた回数。 */
  rejected: number;
  /**
   * この利用者の利用枠。テストが書き換える。`weekly.reached` の間は、本物の中継と同じく
   * モデルへ送らずに 402 `USAGE_LIMIT_REACHED` を返す。
   */
  allowance: GatewayAllowance;
  /** 利用枠で断った回数。 */
  refused: number;
  close(): Promise<void>;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .join("\n");
}

/** これまでのツール結果 (新しい順)。 */
export function toolResults(request: GatewayRequest): string[] {
  return request.messages.filter((message) => message.role === "tool").map((message) => textOf(message.content)).reverse();
}

/** 最初の利用者メッセージ (アプリが組んだプロンプト)。 */
export function promptOf(request: GatewayRequest): string {
  return request.messages.filter((message) => message.role === "user").map((message) => textOf(message.content)).join("\n");
}

export async function startGatewayFixture(
  script: (request: GatewayRequest, index: number) => GatewayReply | Promise<GatewayReply>,
  options: { delayMs?: number } = {},
): Promise<GatewayFixture> {
  const token = "fixture-gateway-token-32-bytes-minimum-length";
  const fixture: GatewayFixture = {
    url: "", token, requests: [], rejected: 0, refused: 0, close: async () => {},
    allowance: { plan: "pro", included: true, weekly: { usedRatio: 0, resetsAt: null, reached: false } },
  };
  const server: Server = createServer((incoming, response) => {
    let raw = "";
    incoming.on("data", (chunk) => { raw += chunk; });
    incoming.on("end", async () => {
      if (incoming.headers.authorization !== `Bearer ${token}`) {
        fixture.rejected += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "A valid gateway token is required." } }));
        return;
      }
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const route = new URL(incoming.url ?? "/", "http://fixture").pathname;
      if (incoming.method === "GET") {
        if (route === "/v1/usage") json(200, fixture.allowance);
        else if (route === "/v1/models") json(200, { object: "list", data: [] });
        else json(404, { error: { code: "NOT_FOUND", message: "Unknown route." } });
        return;
      }
      if (fixture.allowance.weekly?.reached) {
        fixture.refused += 1;
        json(402, { error: { code: "USAGE_LIMIT_REACHED", message: "You have used this week's SIGMA AI allowance.", resetsAt: fixture.allowance.weekly.resetsAt } });
        return;
      }
      const request = JSON.parse(raw) as GatewayRequest;
      const index = fixture.requests.push(request) - 1;
      const reply = await script(request, index);
      const base = { id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1, model: request.model };
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      const finish = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if ("tool" in reply) {
          send({ ...base, choices: [{ index: 0, delta: {
            role: "assistant",
            content: reply.say ?? null,
            tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) } }],
          }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        } else {
          send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        }
        response.end("data: [DONE]\n\n");
      };
      if (options.delayMs) setTimeout(finish, options.delayMs);
      else finish();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fixture;
}
