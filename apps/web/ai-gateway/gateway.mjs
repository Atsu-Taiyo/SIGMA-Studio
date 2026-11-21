// SIGMA Studio 内蔵AIの中継 (Cloudflare Worker)。
//
// デスクトップアプリは OpenRouter の鍵を持たない。アプリ (DeepSeek Harness) は
// OpenAI Chat Completions 互換のこの中継へ投げ、鍵はここでだけ付ける。
// - 認証: `Authorization: Bearer <GATEWAY_TOKEN>`。未設定なら全拒否 (fail closed)。
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
const MAX_OUTPUT_TOKENS = 65_536;
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

// 上流へ渡してよいフィールド。`model` は検証後に付け直し、出力上限は切り詰める。
const PASSTHROUGH_FIELDS = [
  "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options",
  "temperature", "top_p", "stop", "seed", "response_format",
  "reasoning", "reasoning_effort", "thinking",
];

const encoder = new TextEncoder();

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

// 長さの違いも含めて時間差を出さない比較 (両方を SHA-256 にしてから突き合わせる)。
async function sameSecret(left, right) {
  const [a, b] = await Promise.all([left, right].map(async value =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))));
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authorized(request, env) {
  const expected = typeof env.GATEWAY_TOKEN === "string" ? env.GATEWAY_TOKEN : "";
  // 短い共有鍵は総当たりできるので、設定ミスとして扱う。
  if (encoder.encode(expected).length < 32) return "unconfigured";
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented && await sameSecret(presented, expected) ? "ok" : "denied";
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { error: fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.") };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return { error: fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large.") };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return { body: parsed };
  } catch {
    return { error: fail(400, "INVALID_JSON", "Request body must be a JSON object.") };
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
  if (typeof env.OPENROUTER_API_KEY !== "string" || !env.OPENROUTER_API_KEY) {
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
      signal: controller.signal,
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
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

  const access = await authorized(request, env);
  if (access === "unconfigured") return fail(503, "GATEWAY_UNCONFIGURED", "The gateway has no access token configured.");
  if (access !== "ok") return fail(401, "UNAUTHORIZED", "A valid gateway token is required.");

  if (request.method === "GET" && url.pathname === "/v1/models") {
    return json({ object: "list", data: allowedModels(env).map(id => ({ id, object: "model" })) });
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      return await chatCompletions(request, env, fetcher);
    } catch {
      return fail(500, "GATEWAY_ERROR", "The gateway failed to process the request.");
    }
  }
  return fail(404, "NOT_FOUND", "Unknown route.");
}

export default {
  fetch(request, env) {
    return handleGatewayRequest(request, env);
  },
};
