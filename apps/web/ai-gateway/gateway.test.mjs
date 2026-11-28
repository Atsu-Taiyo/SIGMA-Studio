import { test } from "node:test";
import assert from "node:assert/strict";
import { AiUsageLedger, DEFAULT_ALLOWED_MODELS, handleGatewayRequest } from "./gateway.mjs";
import { UsageLedger, WEEK_MS, createUsageScanner, resolveAllowance, weeklyAllowanceMicroUsd } from "./usage-ledger.mjs";

const MODEL = DEFAULT_ALLOWED_MODELS[0];
const TOKEN = "fixture-user-access-token";
const USER = "892b2764-a58a-4c05-a085-b3e83f605070";
function authority(plan = "pro", extra = {}) {
  return { async fetch(incoming) {
    assert.equal(incoming.redirect, "manual");
    if (incoming.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
    const path = new URL(incoming.url).pathname;
    if (path === "/catalog/capabilities") return Response.json({ plan, ...extra });
    assert.equal(path, "/profile");
    return Response.json({ userId: USER });
  } };
}
function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async put(key, value) { values.set(key, structuredClone(value)); },
  };
}
/** Durable Object の名前空間の代わり。本物と同じクラスを、利用者ごとに 1 つ動かす。 */
function usageLedgers() {
  const objects = new Map();
  return {
    idFromName: name => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, new AiUsageLedger({ storage: memoryStorage() }));
      return { fetch: (input, init) => objects.get(id).fetch(new Request(input, init)) };
    },
  };
}
const env = {
  OPENROUTER_API_KEY: "fixture-upstream-key",
  COLLABORATION: authority(),
  AI_RATE_LIMIT: { async limit({ key }) { assert.ok(key === USER || key === `usage:${USER}`); return { success: true }; } },
  AI_USAGE: usageLedgers(),
};
/** 応答の後に走る使用量の記録を、テストが待てるようにする。 */
function executionContext() {
  const pending = [];
  return { waitUntil(promise) { pending.push(promise); }, settled: () => Promise.all(pending) };
}
const WEEKLY_PRO_MICRO_USD = weeklyAllowanceMicroUsd(5);
const sse = (...events) => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const chatBody = { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true };
async function usageOf(scope, options) {
  const response = await handleGatewayRequest(request("/v1/usage"), scope, neverFetch, undefined, options);
  assert.equal(response.status, 200);
  return response.json();
}
const origin = "https://gateway.example.test";

function request(path, { token = TOKEN, body, method = body ? "POST" : "GET" } = {}) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const neverFetch = async () => { throw new Error("upstream must not be called"); };

test("health needs no token and reveals nothing", async () => {
  const resource = new Request(`${origin}/health`);
  const missing = await handleGatewayRequest(resource, {}, neverFetch);
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { ok: false, protocol: 1 });
  const response = await handleGatewayRequest(resource, env, neverFetch);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, protocol: 1 });
  // 台帳が無い置き先を「準備できている」と答えない (配布ビルドの確認がここを見る)。
  assert.equal((await handleGatewayRequest(resource, { ...env, AI_USAGE: undefined }, neverFetch)).status, 503);
});

test("rejects a missing or wrong token before reaching the provider", async () => {
  for (const token of [null, "wrong", `${TOKEN}x`]) {
    const response = await handleGatewayRequest(
      request("/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } }), env, neverFetch);
    assert.equal(response.status, 401);
  }
});

test("fails closed when account verification, rate limiting or the usage ledger is unavailable", async () => {
  for (const binding of ["COLLABORATION", "AI_RATE_LIMIT", "AI_USAGE"]) {
    const response = await handleGatewayRequest(request("/v1/models"), { ...env, [binding]: undefined }, neverFetch);
    assert.equal(response.status, 503);
  }
  const down = await handleGatewayRequest(request("/v1/models"), {
    ...env, COLLABORATION: { async fetch() { return new Response(null, { status: 500 }); } },
  }, neverFetch);
  assert.equal(down.status, 503);
});

test("uses the current account's plan and rate limit before contacting the provider", async () => {
  const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
  const limited = { async limit({ key }) { assert.equal(key, USER); return { success: false }; } };
  for (const [plan, status] of [["free", 403], ["trial", 429], ["pro", 429]]) {
    const response = await handleGatewayRequest(request("/v1/chat/completions", { body }), {
      ...env, COLLABORATION: authority(plan), AI_RATE_LIMIT: limited,
    }, neverFetch);
    assert.equal(response.status, status);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "60");
  }
});

test("lists only the allowed models", async () => {
  const response = await handleGatewayRequest(request("/v1/models"), env, neverFetch);
  assert.deepEqual((await response.json()).data.map(model => model.id), [MODEL]);
  const custom = await handleGatewayRequest(request("/v1/models"), { ...env, ALLOWED_MODELS: "a/one, b/two" }, neverFetch);
  assert.deepEqual((await custom.json()).data.map(model => model.id), ["a/one", "b/two"]);
});

test("refuses models outside the allowlist", async () => {
  const response = await handleGatewayRequest(
    request("/v1/chat/completions", { body: { model: "openai/gpt-6", messages: [{ role: "user", content: "hi" }] } }), env, neverFetch);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "MODEL_NOT_ALLOWED");
});

test("rejects malformed bodies", async () => {
  for (const body of ["not json", "[]", JSON.stringify({ model: MODEL, messages: [] })]) {
    const response = await handleGatewayRequest(request("/v1/chat/completions", { body }), env, neverFetch);
    assert.equal(response.status, 400);
  }
});

test("forwards known fields with the upstream key and drops everything else", async () => {
  let seen;
  const content = [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }];
  const response = await handleGatewayRequest(request("/v1/chat/completions", {
    body: {
      model: MODEL,
      messages: [{ role: "user", content }],
      tools: [{ type: "function", function: { name: "t", parameters: {} } }],
      stream: true,
      max_tokens: 10_000_000,
      provider: { only: ["somewhere"] },
      models: ["openai/gpt-6"],
      store: false,
    },
  }), env, async (url, options) => {
    seen = { url, headers: new Headers(options.headers), body: JSON.parse(options.body) };
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-ratelimit-remaining": "9", "set-cookie": "a=b" },
    });
  });

  assert.equal(seen.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen.headers.get("authorization"), `Bearer ${env.OPENROUTER_API_KEY}`);
  assert.deepEqual(Object.keys(seen.body).sort(), ["max_tokens", "messages", "model", "stream", "tools"]);
  assert.equal(seen.body.max_tokens, 32_768);
  assert.deepEqual(seen.body.messages[0].content, content);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-ratelimit-remaining"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await response.text(), "data: [DONE]\n\n");
});

test("does not follow or forward redirects from the account or model service", async () => {
  const redirect = () => Response.redirect("https://redirect.example.test", 302);
  const denied = await handleGatewayRequest(request("/v1/models"), {
    ...env, COLLABORATION: { async fetch() { return redirect(); } },
  }, neverFetch);
  assert.equal(denied.status, 503);

  const response = await handleGatewayRequest(request("/v1/chat/completions", {
    body: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
  }), env, async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return redirect();
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
});

test("never echoes the caller's token or the upstream key", async () => {
  const response = await handleGatewayRequest(request("/v1/chat/completions", {
    body: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
  }), env, async () => Response.json({ error: { message: "upstream said no" } }, { status: 429 }));
  assert.equal(response.status, 429);
  const text = await response.text();
  assert.ok(!text.includes(env.OPENROUTER_API_KEY));
  assert.ok(!text.includes(TOKEN));
});

test("routes through a configured https upstream and refuses plain http", async () => {
  let url;
  await handleGatewayRequest(request("/v1/chat/completions", { body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } }),
    { ...env, OPENROUTER_BASE_URL: "https://gateway.ai.example.test/v1/acct/sigma/openrouter/" }, async (target) => { url = target; return Response.json({}); });
  assert.equal(url, "https://gateway.ai.example.test/v1/acct/sigma/openrouter/chat/completions");

  const response = await handleGatewayRequest(request("/v1/chat/completions", { body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } }),
    { ...env, OPENROUTER_BASE_URL: "http://insecure.example.test/v1" }, neverFetch);
  assert.equal(response.status, 500);
});

test("reports an unreachable provider and a missing upstream key", async () => {
  const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
  const unreachable = await handleGatewayRequest(request("/v1/chat/completions", { body }), env, async () => { throw new Error("network"); });
  assert.equal(unreachable.status, 502);
  const unconfigured = await handleGatewayRequest(request("/v1/chat/completions", { body }), { ...env, OPENROUTER_API_KEY: "" }, neverFetch);
  assert.equal(unconfigured.status, 503);
});

test("unknown routes are 404", async () => {
  assert.equal((await handleGatewayRequest(request("/v1/embeddings", { body: {} }), env, neverFetch)).status, 404);
});

test("a gateway mounted under a function name routes as if it were at the root", async () => {
  const { stripMountPath } = await import("./gateway.mjs");
  assert.equal(stripMountPath("/functions/v1/sigma-ai-gateway/v1/chat/completions", "/sigma-ai-gateway"), "/v1/chat/completions");
  assert.equal(stripMountPath("/sigma-ai-gateway/v1/models", "/sigma-ai-gateway"), "/v1/models");
  assert.equal(stripMountPath("/sigma-ai-gateway", "/sigma-ai-gateway"), "/");
  assert.equal(stripMountPath("/sigma-ai-gateway-other/v1/models", "/sigma-ai-gateway"), "/sigma-ai-gateway-other/v1/models");
  assert.equal(stripMountPath("/v1/models", "/sigma-ai-gateway"), "/v1/models");
  assert.equal(stripMountPath("/v1/models", undefined), "/v1/models");
  assert.equal(stripMountPath("/v1/models", "v1"), "/v1/models");

  const mounted = { ...env, MOUNT_PATH: "/sigma-ai-gateway" };
  assert.equal((await handleGatewayRequest(new Request("https://host.example.test/functions/v1/sigma-ai-gateway/health"), mounted, neverFetch)).status, 200);
  const models = await handleGatewayRequest(request("/functions/v1/sigma-ai-gateway/v1/models"), mounted, neverFetch);
  assert.equal(models.status, 200);
});

test("provider routing comes from the deployment, never from the caller", async () => {
  const body = { model: MODEL, messages: [{ role: "user", content: "hi" }], provider: { order: ["Expensive"] } };
  const sent = async (extra) => {
    let upstream;
    const response = await handleGatewayRequest(request("/v1/chat/completions", { body }), { ...env, ...extra },
      async (_url, init) => { upstream = JSON.parse(init.body); return Response.json({}); });
    return { status: response.status, provider: upstream?.provider };
  };
  assert.deepEqual(await sent({}), { status: 200, provider: undefined });
  assert.deepEqual(await sent({ PROVIDER_ROUTING: '{"order":["Morph","DigitalOcean"],"allow_fallbacks":true}' }),
    { status: 200, provider: { order: ["Morph", "DigitalOcean"], allow_fallbacks: true } });
  assert.deepEqual(await sent({ PROVIDER_ROUTING: '{"sort":"throughput"}' }), { status: 200, provider: { sort: "throughput" } });
  for (const bad of ["{", '"Morph"', '{"sort":"fastest"}', '{"order":[]}', '{"order":["a\\nb"]}', '{"max_price":{"prompt":1}}']) {
    assert.equal((await sent({ PROVIDER_ROUTING: bad })).status, 500, bad);
  }
});

test("the weekly allowance is the monthly budget spread over 52 weeks", () => {
  assert.equal(weeklyAllowanceMicroUsd(5), 1_153_846);
  assert.deepEqual(resolveAllowance({ plan: "pro" }, {}), { plan: "pro", weeklyLimitMicroUsd: 1_153_846 });
  assert.deepEqual(resolveAllowance({ plan: "trial" }, {}), { plan: "trial", weeklyLimitMicroUsd: 1_153_846 });
  assert.equal(resolveAllowance({ plan: "free" }, {}), null);
  assert.equal(resolveAllowance({}, {}), null);
  // 上位プランは、表に行を足すだけで増やせる。
  const tiers = { AI_PLAN_MONTHLY_BUDGET_USD: '{"trial":5,"pro":5,"max":25}' };
  assert.equal(resolveAllowance({ plan: "max" }, tiers).weeklyLimitMicroUsd, weeklyAllowanceMicroUsd(25));
  assert.equal(resolveAllowance({ plan: "max" }, {}), null);
  // 共有サービスが個別の予算を返したら、表より優先する。
  assert.equal(resolveAllowance({ plan: "pro", aiMonthlyBudgetUsd: 10 }, {}).weeklyLimitMicroUsd, weeklyAllowanceMicroUsd(10));
  assert.equal(resolveAllowance({ plan: "pro", aiMonthlyBudgetUsd: 0 }, {}), null);
  for (const bad of ["{", "[]", '{"pro":-1}', '{"pro":"5"}', '{"Pro Max":5}']) {
    assert.throws(() => resolveAllowance({ plan: "pro" }, { AI_PLAN_MONTHLY_BUDGET_USD: bad }), /INVALID_CONFIGURATION/, bad);
  }
});

test("a plan outside the budget table cannot use the gateway, and a new tier only needs a row", async () => {
  const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
  const max = { ...env, AI_USAGE: usageLedgers(), COLLABORATION: authority("max") };
  const refused = await handleGatewayRequest(request("/v1/chat/completions", { body }), max, neverFetch);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "PRO_REQUIRED");
  const served = await handleGatewayRequest(request("/v1/chat/completions", { body }),
    { ...max, AI_PLAN_MONTHLY_BUDGET_USD: '{"pro":5,"max":25}' }, async () => Response.json({ id: "gen-1", usage: { cost: 0.01 } }));
  assert.equal(served.status, 200);
  const broken = await handleGatewayRequest(request("/v1/chat/completions", { body }), { ...max, AI_PLAN_MONTHLY_BUDGET_USD: "{" }, neverFetch);
  assert.equal(broken.status, 500);
});

test("records what a streamed response cost and reports it as a share of the week", async () => {
  const scope = { ...env, AI_USAGE: usageLedgers() };
  assert.deepEqual(await usageOf(scope), { plan: "pro", included: true, weekly: { usedRatio: 0, resetsAt: null, reached: false } });

  const context = executionContext();
  const started = 1_800_000_000_000;
  const stream = sse(
    { id: "gen-abc", choices: [{ index: 0, delta: { content: "hel" } }] },
    { id: "gen-abc", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
    { id: "gen-abc", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 78_000, completion_tokens: 400, cost: 0.25, prompt_tokens_details: { cached_tokens: 70_000 } } },
    "[DONE]",
  );
  const response = await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope,
    async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }), context, { now: () => started });
  // 本文は 1 バイトも変えずに流す。
  assert.equal(await response.text(), stream);
  await context.settled();

  const usage = await usageOf(scope, { now: () => started + 60_000 });
  assert.equal(usage.weekly.usedRatio, Math.round(250_000 / WEEKLY_PRO_MICRO_USD * 10_000) / 10_000);
  assert.equal(usage.weekly.resetsAt, new Date(started + WEEK_MS).toISOString());
  assert.equal(usage.weekly.reached, false);
  // 金額は利用者へ返さない。
  assert.ok(!JSON.stringify(usage).includes("MicroUsd"));
});

test("stops before the provider once the week's allowance is used, and opens again after the reset", async () => {
  const scope = { ...env, AI_USAGE: usageLedgers() };
  const started = 1_800_000_000_000;
  const spend = async (cost, at) => {
    const context = executionContext();
    const response = await handleGatewayRequest(request("/v1/chat/completions", { body: { ...chatBody, stream: false } }), scope,
      async () => Response.json({ id: "gen-1", usage: { cost } }), context, { now: () => at });
    await response.text();
    await context.settled();
    return response.status;
  };
  assert.equal(await spend(1.0, started), 200);
  // 枠の手前なら通す。最後の 1 回は枠を少し越えてよい。
  assert.equal(await spend(0.2, started + 1_000), 200);

  const blocked = await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope, neverFetch, undefined, { now: () => started + 2_000 });
  // 429 ではない: 利用者側の SDK に、待って送り直させない。
  assert.equal(blocked.status, 402);
  assert.equal(blocked.headers.get("retry-after"), String((WEEK_MS - 2_000) / 1000));
  assert.deepEqual((await blocked.json()).error, {
    code: "USAGE_LIMIT_REACHED",
    message: "You have used this week's SIGMA AI allowance.",
    resetsAt: new Date(started + WEEK_MS).toISOString(),
  });
  assert.deepEqual((await usageOf(scope, { now: () => started + 3_000 })).weekly, {
    usedRatio: 1, resetsAt: new Date(started + WEEK_MS).toISOString(), reached: true,
  });

  // 最初に使った時刻から 7 日で戻る。次の窓は、次に使った時刻から始まる。
  const later = started + WEEK_MS + 5_000;
  assert.deepEqual((await usageOf(scope, { now: () => later })).weekly, { usedRatio: 0, resetsAt: null, reached: false });
  assert.equal(await spend(0.1, later), 200);
  assert.equal((await usageOf(scope, { now: () => later + 1 })).weekly.resetsAt, new Date(later + WEEK_MS).toISOString());

  // 上位プランへ移ると、同じ週の使用量のまま枠だけが広がる。
  const upgraded = { ...scope, COLLABORATION: authority("max"), AI_PLAN_MONTHLY_BUDGET_USD: '{"pro":5,"max":25}' };
  assert.equal((await usageOf(upgraded, { now: () => later + 2 })).weekly.usedRatio, Math.round(100_000 / weeklyAllowanceMicroUsd(25) * 10_000) / 10_000);
});

test("a response cut off before its usage is charged from the provider's own record", async () => {
  const scope = { ...env, AI_USAGE: usageLedgers(), ADMIN_TOKEN: "a".repeat(40) };
  const context = executionContext();
  const lookups = [];
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse({ id: "gen-cut", choices: [{ index: 0, delta: { content: "partial" } }] })));
    },
  });
  const response = await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope, async (url) => {
    if (String(url).includes("/generation")) {
      lookups.push(String(url));
      return Response.json({ data: { total_cost: 0.03 } });
    }
    return new Response(upstream, { headers: { "content-type": "text/event-stream", "x-generation-id": "gen-cut" } });
  }, context, { generationLookupDelaysMs: [0] });
  const reader = response.body.getReader();
  await reader.read();
  // 受け取る側が途中で閉じる (利用者の中断・切断)。
  await reader.cancel();
  await context.settled();

  assert.deepEqual(lookups, ["https://openrouter.ai/api/v1/generation?id=gen-cut"]);
  const record = await (await handleGatewayRequest(new Request(`${origin}/admin/usage?user=${USER}`, { headers: { authorization: `Bearer ${scope.ADMIN_TOKEN}` } }), scope, neverFetch)).json();
  assert.equal(record.window.costMicroUsd, 30_000);
  assert.equal(record.window.requests, 1);
  assert.equal(record.window.unmetered, 0);
  assert.equal(record.holds, 0);
});

test("a request that never reports its end is charged later from the provider's record, once", async () => {
  const scope = { ...env, AI_USAGE: usageLedgers(), ADMIN_TOKEN: "a".repeat(40) };
  const inspect = async (at) => (await handleGatewayRequest(new Request(`${origin}/admin/usage?user=${USER}`, { headers: { authorization: `Bearer ${scope.ADMIN_TOKEN}` } }), scope, neverFetch, undefined, { now: () => at })).json();
  const started = 1_800_000_000_000;
  const lookups = [];
  const provider = async (url) => {
    if (String(url).includes("/generation")) {
      lookups.push(String(url));
      return Response.json({ data: { total_cost: 0.5 } });
    }
    // 応答は始まるが、終わりも中断も届かない (応答の途中で、中継の実行ごと畳まれた)。
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream", "x-generation-id": "gen-lost" } });
  };
  await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope, provider, executionContext(), { now: () => started });
  await new Promise(resolve => setTimeout(resolve, 20));
  // その間は押さえとして数える (何本も投げっぱなしにして、枠を越えて使えない)。
  const held = await inspect(started + 1_000);
  assert.equal(held.holds, 1);
  assert.equal(held.window.costMicroUsd, 0);

  // 押さえの時間が切れた後の、次の問い合わせ。応答の後で上流の記録から数え直す。
  const later = started + 16 * 60 * 1000;
  const context = executionContext();
  const before = await handleGatewayRequest(request("/v1/usage"), scope, provider, context, { now: () => later, generationLookupDelaysMs: [0] });
  assert.equal((await before.json()).weekly.reached, false);
  await context.settled();
  assert.deepEqual(lookups, ["https://openrouter.ai/api/v1/generation?id=gen-lost"]);
  const record = await inspect(later + 1);
  assert.equal(record.window.costMicroUsd, 500_000);
  assert.equal(record.window.requests, 1);
  assert.equal(record.holds, 0);
  assert.equal(record.unreconciled, 0);
  // 1 度だけ数える。
  const again = executionContext();
  await handleGatewayRequest(request("/v1/usage"), scope, provider, again, { now: () => later + 2, generationLookupDelaysMs: [0] });
  await again.settled();
  assert.equal(lookups.length, 1);
  assert.equal((await inspect(later + 3)).window.costMicroUsd, 500_000);
});

test("a request whose cost cannot be learned is charged the hold and counted", async () => {
  const scope = { ...env, AI_USAGE: usageLedgers(), ADMIN_TOKEN: "a".repeat(40), AI_REQUEST_HOLD_MICRO_USD: "20000" };
  const context = executionContext();
  const response = await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope, async (url) => {
    if (String(url).includes("/generation")) return new Response(null, { status: 404 });
    return new Response(sse({ id: "gen-nocost", choices: [{ index: 0, delta: { content: "x" } }] }, "[DONE]"), { headers: { "content-type": "text/event-stream" } });
  }, context, { generationLookupDelaysMs: [0, 0] });
  await response.text();
  await context.settled();
  const record = await (await handleGatewayRequest(new Request(`${origin}/admin/usage?user=${USER}`, { headers: { authorization: `Bearer ${scope.ADMIN_TOKEN}` } }), scope, neverFetch)).json();
  assert.equal(record.window.costMicroUsd, 20_000);
  assert.equal(record.window.unmetered, 1);
});

test("a request the provider refused or never received costs nothing and releases its hold", async () => {
  const scope = { ...env, AI_USAGE: usageLedgers(), ADMIN_TOKEN: "a".repeat(40) };
  const inspect = async () => (await handleGatewayRequest(new Request(`${origin}/admin/usage?user=${USER}`, { headers: { authorization: `Bearer ${scope.ADMIN_TOKEN}` } }), scope, neverFetch)).json();
  const refused = await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope,
    async () => Response.json({ error: { code: 429, message: "Rate limit exceeded" } }, { status: 429 }), executionContext());
  assert.equal(refused.status, 429);
  const unreachable = await handleGatewayRequest(request("/v1/chat/completions", { body: chatBody }), scope, async () => { throw new Error("network"); }, executionContext());
  assert.equal(unreachable.status, 502);
  const record = await inspect();
  assert.equal(record.window.costMicroUsd, 0);
  assert.equal(record.window.requests, 0);
  assert.equal(record.holds, 0);
  // 形の合わない要求は、台帳に触れる前に断る。
  const invalid = await handleGatewayRequest(request("/v1/chat/completions", { body: { model: "other/model", messages: [{ role: "user", content: "hi" }] } }), scope, neverFetch);
  assert.equal(invalid.status, 400);
  assert.equal((await inspect()).holds, 0);
});

test("requests in flight count toward the allowance, so parallel sends cannot run far past it", async () => {
  const ledger = new UsageLedger(memoryStorage());
  const limit = 25_000;
  const first = await ledger.begin({ now: 0, limitMicroUsd: limit, holdMicroUsd: 10_000 });
  const second = await ledger.begin({ now: 1, limitMicroUsd: limit, holdMicroUsd: 10_000 });
  const third = await ledger.begin({ now: 2, limitMicroUsd: limit, holdMicroUsd: 10_000 });
  assert.deepEqual([first.allowed, second.allowed, third.allowed], [true, true, true]);
  assert.equal((await ledger.begin({ now: 3, limitMicroUsd: limit, holdMicroUsd: 10_000 })).allowed, false);
  // 終わった要求の押さえは、実際の料金に置き換わる。
  await ledger.settle({ now: 4, reservationId: first.reservationId, costMicroUsd: 1_000, limitMicroUsd: limit });
  assert.equal((await ledger.begin({ now: 5, limitMicroUsd: limit, holdMicroUsd: 10_000 })).allowed, true);
  // 終わりの報告が来ない押さえは時間切れで外し、数だけ残す (枠を塞ぎ続けない)。
  const stale = await ledger.inspect({ now: 16 * 60 * 1000 });
  assert.equal(stale.holds, 0);
  assert.equal(stale.window.unsettled, 3);
  assert.equal(stale.window.costMicroUsd, 1_000);
  // 時間切れの後に届いた報告も、実際の料金で数える。
  await ledger.settle({ now: 17 * 60 * 1000, reservationId: second.reservationId, costMicroUsd: 2_000, limitMicroUsd: limit });
  assert.equal((await ledger.inspect({ now: 17 * 60 * 1000 })).window.costMicroUsd, 3_000);
  // 閉じた窓は履歴に残る。
  const closed = await ledger.inspect({ now: WEEK_MS + 1 });
  assert.equal(closed.window, null);
  assert.equal(closed.history[0].costMicroUsd, 3_000);
});

test("the usage scanner reads usage across chunk boundaries without parsing content deltas", () => {
  const scanner = createUsageScanner();
  const text = sse(
    { id: "gen-1", choices: [{ delta: { content: 'a "usage" lookalike' } }] },
    { id: "gen-1", choices: [{ delta: {} }], usage: { cost: 0.5, prompt_tokens: 10 } },
    "[DONE]",
  );
  const bytes = new TextEncoder().encode(text);
  for (let index = 0; index < bytes.length; index += 7) scanner.push(bytes.slice(index, index + 7));
  assert.deepEqual(scanner.end(), { usage: { cost: 0.5, prompt_tokens: 10 }, generationId: "gen-1" });
  const empty = createUsageScanner();
  empty.push(new TextEncoder().encode(": keep-alive\n\ndata: not json\n\n"));
  assert.deepEqual(empty.end(), { usage: null, generationId: null });
});

test("reports a plan without SIGMA AI as not included instead of failing", async () => {
  const free = { ...env, AI_USAGE: usageLedgers(), COLLABORATION: authority("free") };
  assert.deepEqual(await usageOf(free), { plan: "free", included: false, weekly: null });
  const limited = await handleGatewayRequest(request("/v1/usage"), { ...free, AI_RATE_LIMIT: { async limit() { return { success: false }; } } }, neverFetch);
  assert.equal(limited.status, 429);
  assert.equal((await handleGatewayRequest(request("/v1/usage", { token: "wrong" }), free, neverFetch)).status, 401);
});

test("the operator route exists only with an admin token and never accepts a user's sign-in", async () => {
  const path = `/admin/usage?user=${USER}`;
  assert.equal((await handleGatewayRequest(request(path), env, neverFetch)).status, 404);
  const scope = { ...env, AI_USAGE: usageLedgers(), ADMIN_TOKEN: "b".repeat(40) };
  assert.equal((await handleGatewayRequest(request(path), scope, neverFetch)).status, 401);
  assert.equal((await handleGatewayRequest(request("/admin/usage?user=nobody", { token: scope.ADMIN_TOKEN }), scope, neverFetch)).status, 400);

  const context = executionContext();
  await (await handleGatewayRequest(request("/v1/chat/completions", { body: { ...chatBody, stream: false } }), scope,
    async () => Response.json({ id: "gen-1", usage: { cost: 2 } }), context)).text();
  await context.settled();
  assert.equal((await usageOf(scope)).weekly.reached, true);
  // 問い合わせへの対応: いまの窓を閉じて枠を戻す。使った記録は履歴に残る。
  const reset = await handleGatewayRequest(request(path, { token: scope.ADMIN_TOKEN, method: "DELETE" }), scope, neverFetch);
  assert.deepEqual(await reset.json(), { ok: true });
  assert.deepEqual((await usageOf(scope)).weekly, { usedRatio: 0, resetsAt: null, reached: false });
  const record = await (await handleGatewayRequest(request(path, { token: scope.ADMIN_TOKEN }), scope, neverFetch)).json();
  assert.equal(record.history[0].costMicroUsd, 2_000_000);
});

test("tells the provider who is asking only when the deployment opts in, and never by account id", async () => {
  const sent = async (extra) => {
    let upstream;
    await handleGatewayRequest(request("/v1/chat/completions", { body: { ...chatBody, stream: false, user: "spoofed" } }),
      { ...env, AI_USAGE: usageLedgers(), ...extra }, async (_url, init) => { upstream = JSON.parse(init.body); return Response.json({}); });
    return upstream.user;
  };
  assert.equal(await sent({}), undefined);
  const hashed = await sent({ OPENROUTER_USER_ATTRIBUTION: "hashed" });
  assert.match(hashed, /^u_[0-9a-f]{32}$/);
  assert.ok(!hashed.includes(USER.slice(0, 8)));
  assert.equal(await sent({ OPENROUTER_USER_ATTRIBUTION: "hashed" }), hashed);
});
