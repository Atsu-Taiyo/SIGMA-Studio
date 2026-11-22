// SIGMA Studio 内蔵AIの中継 (Cloudflare Worker)。
//
// デスクトップアプリは OpenRouter の鍵を持たない。アプリ (DeepSeek Harness) は
// OpenAI Chat Completions 互換のこの中継へ投げ、鍵はここでだけ付ける。
// - 認証: 共有サービスで利用者のサインインとPro資格を要求ごとに確認する。
// - モデル: 許可リストにあるものだけ。それ以外は 400 (鍵を汎用の中継にしない)。
// - 本文: 既知のフィールドだけを上流へ渡す。プロバイダの経路指定などは受け取らない。
// 応答 (SSE を含む) は加工せずに流す。
//
// handleGatewayRequest は Web 標準の Request/Response だけで書いてあるので、
// Workers 以外 (Deno など) でも同じ関数を呼べる。

export const DEFAULT_ALLOWED_MODELS = ["deepseek/deepseek-v4.1-flash-1017"];
const DEFAULT_UPSTREAM = "https://openrouter.ai/api/v1";
// 画像の添付 (base64) を含むので大きめ。Workers の本文上限よりは十分小さい。
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 32_768;
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

// 上流へ渡してよいフィールド。`model` は検証後に付け直し、出力上限は切り詰める。
const PASSTHROUGH_FIELDS = [
  "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options",
  "temperature", "top_p", "stop", "seed", "response_format",
  "reasoning", "reasoning_effort", "thinking",
];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function fail(status, code, message) {
  return json({ error: { code, message } }, status);
}

function allowedModels(env) {
  const configured = typeof env.ALLOWED_MODELS === "string"
    ? env.ALLOWED_MODELS.split(",").map(value => value.trim()).filter(Boolean)
    : [];
  return configured.length > 0 ? configured : DEFAULT_ALLOWED_MODELS;
}

function upstreamBase(env) {
  const value = typeof env.OPENROUTER_BASE_URL === "string" && env.OPENROUTER_BASE_URL.trim()
    ? env.OPENROUTER_BASE_URL.trim()
    : DEFAULT_UPSTREAM;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("INVALID_CONFIGURATION");
  return url.href.replace(/\/+$/, "");
}

async function authorize(request, env) {
  if (!env.COLLABORATION?.fetch || !env.AI_RATE_LIMIT?.limit) {
    return { error: fail(503, "GATEWAY_UNCONFIGURED", "The gateway has no account authority or rate limiter.") };
  }
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s,]{1,8192}$/.test(authorization)) {
    return { error: fail(401, "UNAUTHORIZED", "Sign in to SIGMA Studio.") };
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const init = { headers: { authorization }, signal, redirect: "error" };
    const [capabilities, profile] = await Promise.all(["/catalog/capabilities", "/profile"]
      .map(path => env.COLLABORATION.fetch(new Request("https://collaboration.internal" + path, init))));
    if ([capabilities, profile].some(response => response.status === 401 || response.status === 403)) {
      return { error: fail(401, "UNAUTHORIZED", "Sign in to SIGMA Studio.") };
    }
    if (!capabilities.ok || !profile.ok) throw new Error("Account authority unavailable");
    const [{ plan }, { userId }] = await Promise.all([capabilities.json(), profile.json()]);
    if (typeof userId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)) {
      throw new Error("Invalid account authority response");
    }
    if (plan !== "pro" && plan !== "trial") {
      return { error: fail(403, "PRO_REQUIRED", "SIGMA AI requires Pro or an active trial.") };
    }
    return { userId: userId.toLowerCase() };
  } catch {
    return { error: fail(503, "AUTHORITY_UNAVAILABLE", "Could not verify your SIGMA account.") };
  }
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { error: fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.") };
  if (!request.body) return { error: fail(400, "INVALID_JSON", "Request body must be a JSON object.") };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.") };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const parsed = JSON.parse(chunks.join(""));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return { body: parsed };
  } catch {
    return { error: fail(400, "INVALID_JSON", "Request body must be a JSON object.") };
  } finally {
    reader.releaseLock();
  }
}

// 上流 (OpenRouter) の事業者の選び方。利用者には決めさせず、置き先の設定 `PROVIDER_ROUTING` (JSON) で決める。
// 何も決めないと要求ごとに別の事業者へ振られ、毎ステップ送る大きな入力 (ツール定義) のキャッシュが
// 効かず、最初の応答までが 1 秒から 9 秒までばらつく。速くてキャッシュの効く事業者を先頭に並べる。
const ROUTING_FIELDS = {
  order: "names", only: "names", ignore: "names",
  sort: ["price", "throughput", "latency"],
  allow_fallbacks: "boolean",
  data_collection: ["allow", "deny"],
  zdr: "boolean",
};

export function providerRouting(env) {
  if (typeof env.PROVIDER_ROUTING !== "string" || !env.PROVIDER_ROUTING.trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(env.PROVIDER_ROUTING);
  } catch {
    throw new Error("INVALID_CONFIGURATION");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_CONFIGURATION");
  const routing = {};
  for (const [field, value] of Object.entries(parsed)) {
    const kind = ROUTING_FIELDS[field];
    const valid = kind === "names"
      ? Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(name => typeof name === "string" && /^[\w .\/-]{1,64}$/.test(name))
      : kind === "boolean" ? typeof value === "boolean"
      : Array.isArray(kind) && kind.includes(value);
    // 知らない項目や形の違う値は、黙って捨てずに設定の誤りとして止める。
    if (!valid) throw new Error("INVALID_CONFIGURATION");
    routing[field] = value;
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}

function outputLimit(body) {
  const requested = [body.max_tokens, body.max_completion_tokens].find(value => Number.isInteger(value) && value > 0);
  return Math.min(requested ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
}

async function chatCompletions(request, env, fetcher) {
  if (typeof env.OPENROUTER_API_KEY !== "string" || !env.OPENROUTER_API_KEY.trim()) {
    return fail(503, "GATEWAY_UNCONFIGURED", "The gateway has no upstream credential.");
  }
  const { body, error } = await readBody(request);
  if (error) return error;
  if (typeof body.model !== "string" || !allowedModels(env).includes(body.model)) {
    return fail(400, "MODEL_NOT_ALLOWED", "This gateway does not serve the requested model.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return fail(400, "INVALID_REQUEST", "messages must be a non-empty array.");
  }

  const upstreamBody = { model: body.model, max_tokens: outputLimit(body) };
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) upstreamBody[field] = body[field];
  }

  // 設定の誤り (https でない上流・事業者の選び方) は、通信の失敗と区別して 500 にする。
  const base = upstreamBase(env);
  const routing = providerRouting(env);
  if (routing) upstreamBody.provider = routing;
  // 応答ヘッダーが返るまでだけ時間を切る。本文 (SSE) は長く続くので切らない。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetcher(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": typeof env.SITE_URL === "string" && env.SITE_URL ? env.SITE_URL : "https://github.com/Atsu-Taiyo/SIGMA-Studio",
        "X-Title": "SIGMA Studio",
      },
      body: JSON.stringify(upstreamBody),
      redirect: "error",
      signal: AbortSignal.any([controller.signal, request.signal]),
    });
  } catch {
    return fail(502, "UPSTREAM_UNREACHABLE", "The model provider could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  // 上流のヘッダーは持ち帰らない (レート制限や課金の識別子を利用者へ出さない)。
  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * 関数名つきの経路に置かれたとき (`/functions/v1/<名前>/v1/...` や `/<名前>/v1/...`) に、
 * 中継の経路 (`/v1/...`) へ戻す。`mount` は `/<名前>`。一致しなければそのまま返す。
 */
export function stripMountPath(pathname, mount) {
  if (typeof mount !== "string" || !/^\/[A-Za-z0-9_-]+$/.test(mount)) return pathname;
  const index = pathname.indexOf(mount);
  if (index === -1) return pathname;
  const rest = pathname.slice(index + mount.length);
  return rest.startsWith("/") ? rest : rest === "" ? "/" : pathname;
}

export async function handleGatewayRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  url.pathname = stripMountPath(url.pathname, env.MOUNT_PATH);
  if (request.method === "GET" && url.pathname === "/health") {
    const ready = Boolean(env.COLLABORATION?.fetch && env.AI_RATE_LIMIT?.limit && env.OPENROUTER_API_KEY);
    return json({ ok: ready, protocol: 1 }, ready ? 200 : 503);
  }

  const models = request.method === "GET" && url.pathname === "/v1/models";
  const chat = request.method === "POST" && url.pathname === "/v1/chat/completions";
  if (!models && !chat) return fail(404, "NOT_FOUND", "Unknown route.");
  const access = await authorize(request, env);
  if (access.error) return access.error;

  if (models) {
    return json({ object: "list", data: allowedModels(env).map(id => ({ id, object: "model" })) });
  }
  try {
    const { success } = await env.AI_RATE_LIMIT.limit({ key: access.userId });
    if (!success) {
      const response = fail(429, "RATE_LIMITED", "Too many SIGMA AI requests. Try again in a minute.");
      response.headers.set("retry-after", "60");
      return response;
    }
    return await chatCompletions(request, env, fetcher);
  } catch {
    return fail(500, "GATEWAY_ERROR", "The gateway failed to process the request.");
  }
}

export default {
  fetch(request, env) {
    return handleGatewayRequest(request, env);
  },
};
