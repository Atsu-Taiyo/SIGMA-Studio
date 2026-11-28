import { expect, it, vi } from "vitest";
import { startDshGatewaySession } from "./dsh-gateway-session";

it("forwards an image request with main's credential and stops forwarding after an account change", async () => {
  const account = new AbortController();
  const authorization = vi.fn(async () => "Bearer fixture-account-credential");
  const body = JSON.stringify({ messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
  ] }] });
  const upstream = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://gateway.example.test/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-account-credential");
    expect(await new Response(init?.body).text()).toBe(body);
    expect(init?.redirect).toBe("error");
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const session = await startDshGatewaySession("https://gateway.example.test/v1", {
    authorization, accountSignal: () => account.signal,
  }, upstream);
  try {
    const send = (path: string, token?: string) => fetch(session.url + path, {
      method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect((await send("/chat/completions")).status).toBe(401);
    expect((await send("/anything", session.token)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    const success = await send("/chat/completions", session.token);
    expect(success.headers.get("content-type")).toBe("text/event-stream");
    expect(await success.text()).toBe("data: [DONE]\n\n");
    expect(authorization).toHaveBeenCalledTimes(1);
    account.abort();
    expect((await send("/chat/completions", session.token)).status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
  } finally {
    session.close();
  }
});

function account() {
  return { authorization: async () => "Bearer fixture-account-credential", accountSignal: () => new AbortController().signal };
}

it("tells main why the gateway refused a request, and still hands DSH the same response", async () => {
  const refusals: unknown[] = [];
  const body = JSON.stringify({ error: { code: "USAGE_LIMIT_REACHED", message: "You have used this week's SIGMA AI allowance.", resetsAt: "2026-12-05T03:14:00.000Z" } });
  const session = await startDshGatewaySession("https://gateway.example.test/v1", account(),
    async () => new Response(body, { status: 402, headers: { "content-type": "application/json", "retry-after": "3600" } }),
    { onRefusal: refusal => refusals.push(refusal) });
  try {
    const response = await fetch(`${session.url}/chat/completions`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(402);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.text()).toBe(body);
    expect(refusals).toEqual([{ status: 402, code: "USAGE_LIMIT_REACHED", resetsAt: "2026-12-05T03:14:00.000Z" }]);
  } finally {
    session.close();
  }
});

it("reports a refusal it cannot read by its status alone", async () => {
  const refusals: unknown[] = [];
  const session = await startDshGatewaySession("https://gateway.example.test/v1", account(),
    // 上流 (OpenRouter) の残高不足も 402 だが、code は数値。利用者の利用枠と取り違えない。
    async (url) => String(url).endsWith("/models")
      ? new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
      : Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }),
    { onRefusal: refusal => refusals.push(refusal) });
  try {
    const headers = { authorization: `Bearer ${session.token}` };
    await (await fetch(`${session.url}/chat/completions`, { method: "POST", body: "{}", headers })).text();
    await (await fetch(`${session.url}/models`, { headers })).text();
    expect(refusals).toEqual([{ status: 402, code: null, resetsAt: null }, { status: 502, code: null, resetsAt: null }]);
  } finally {
    session.close();
  }
});

it("reads each response's usage without changing a byte of the stream", async () => {
  const usages: unknown[] = [];
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: { content: "a \"usage\" lookalike" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 78000, completion_tokens: 400, cost: 0.004 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const stream = events.join("");
  const session = await startDshGatewaySession("https://gateway.example.test/v1", account(), async (_url, init) => {
    await new Response(init?.body).text();
    // 行の途中で切れた塊として届いても、つないで読む。
    const bytes = encoder.encode(stream);
    return new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 11) controller.enqueue(bytes.slice(index, index + 11));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { onUsage: usage => usages.push(usage) });
  try {
    const headers = { authorization: `Bearer ${session.token}` };
    const response = await fetch(`${session.url}/chat/completions`, { method: "POST", body: "{}", headers });
    expect(await response.text()).toBe(stream);
    expect(usages).toEqual([{ prompt_tokens: 78000, completion_tokens: 400, cost: 0.004 }]);
  } finally {
    session.close();
  }
});

it("reads usage from a response that is not streamed, and survives an observer that throws", async () => {
  const usages: unknown[] = [];
  const body = JSON.stringify({ id: "gen-2", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const session = await startDshGatewaySession("https://gateway.example.test/v1", account(), async (_url, init) => {
    await new Response(init?.body).text();
    return new Response(body, { headers: { "content-type": "application/json" } });
  }, { onUsage: (usage) => { usages.push(usage); throw new Error("observer failed"); } });
  try {
    const response = await fetch(`${session.url}/chat/completions`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${session.token}` } });
    expect(await response.text()).toBe(body);
    expect(usages).toEqual([{ prompt_tokens: 10, completion_tokens: 2 }]);
  } finally {
    session.close();
  }
});
