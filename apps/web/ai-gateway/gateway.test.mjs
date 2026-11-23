import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALLOWED_MODELS, handleGatewayRequest } from "./gateway.mjs";

const MODEL = DEFAULT_ALLOWED_MODELS[0];
const TOKEN = "fixture-user-access-token";
const USER = "892b2764-a58a-4c05-a085-b3e83f605070";
function authority(plan = "pro") {
  return { async fetch(incoming) {
    assert.equal(incoming.redirect, "manual");
    if (incoming.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
    const path = new URL(incoming.url).pathname;
    if (path === "/catalog/capabilities") return Response.json({ plan });
    assert.equal(path, "/profile");
    return Response.json({ userId: USER });
  } };
}
const env = {
  OPENROUTER_API_KEY: "fixture-upstream-key",
  COLLABORATION: authority(),
  AI_RATE_LIMIT: { async limit({ key }) { assert.equal(key, USER); return { success: true }; } },
};
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
});

test("rejects a missing or wrong token before reaching the provider", async () => {
  for (const token of [null, "wrong", `${TOKEN}x`]) {
    const response = await handleGatewayRequest(
      request("/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } }), env, neverFetch);
    assert.equal(response.status, 401);
  }
});

test("fails closed when account verification or rate limiting is unavailable", async () => {
  for (const binding of ["COLLABORATION", "AI_RATE_LIMIT"]) {
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
