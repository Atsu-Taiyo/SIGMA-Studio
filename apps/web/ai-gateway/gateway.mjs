// SIGMA Studio 内蔵AIの中継 (Cloudflare Worker)。
//
// デスクトップアプリは OpenRouter の鍵を持たない。アプリ (DeepSeek Harness) は
// OpenAI Chat Completions 互換のこの中継へ投げ、鍵はここでだけ付ける。
// - 認証: 共有サービスで利用者のサインインとPro資格を要求ごとに確認する。
// - モデル: 許可リストにあるものだけ。それ以外は 400 (鍵を汎用の中継にしない)。
// - 本文: 既知のフィールドだけを上流へ渡す。プロバイダの経路指定などは受け取らない。
// - 利用枠: プランごとの週の枠を利用者ごとの台帳 (usage-ledger.mjs) で数え、使い切ったら上流へ送らない。
// 応答 (SSE を含む) は加工せずに流す。流しながら、上流が最後に付ける使用量 (料金) だけを読む。
//
// handleGatewayRequest は Web 標準の Request/Response だけで書いてあるので、
// Workers 以外 (Deno など) でも同じ関数を呼べる。

import {
  AiUsageLedger, callLedger, costToMicroUsd, createUsageScanner, requestHoldMicroUsd, resolveAllowance,
} from "./usage-ledger.mjs";

// Durable Object のクラスは Worker の入口から書き出す。
export { AiUsageLedger };

export const DEFAULT_ALLOWED_MODELS = ["deepseek/deepseek-v4.1-flash-1017"];
const DEFAULT_UPSTREAM = "https://openrouter.ai/api/v1";
// 画像の添付 (base64) を含むので大きめ。Workers の本文上限よりは十分小さい。
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 32_768;
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;
// 使用量を読むために覚えておく JSON 応答 (ストリームでない応答) の上限。超えた分は読まずに流す。
const MAX_METERED_JSON_CHARS = 8 * 1024 * 1024;
// 応答に料金が付かなかったとき (途中で切れた応答) に、上流へ料金を問い合わせるまでの待ち時間。
const GENERATION_LOOKUP_DELAYS_MS = [0, 1_000, 3_000];
const USER_ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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

function ready(env) {
  return Boolean(env.COLLABORATION?.fetch && env.AI_RATE_LIMIT?.limit && env.AI_USAGE?.idFromName);
}

/** サインインを確かめ、利用者の ID と共有サービスの答え (プラン) を返す。プランの枠は呼び出し側が決める。 */
async function authorize(request, env) {
  if (!ready(env)) {
    return { error: fail(503, "GATEWAY_UNCONFIGURED", "The gateway has no account authority, rate limiter or usage ledger.") };
  }
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s,]{1,8192}$/.test(authorization)) {
    return { error: fail(401, "UNAUTHORIZED", "Sign in to SIGMA Studio.") };
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const init = { headers: { authorization }, signal, redirect: "manual" };
    const [capabilities, profile] = await Promise.all(["/catalog/capabilities", "/profile"]
      .map(path => env.COLLABORATION.fetch(new Request("https://collaboration.internal" + path, init))));
    if ([capabilities, profile].some(response => response.status === 401 || response.status === 403)) {
      return { error: fail(401, "UNAUTHORIZED", "Sign in to SIGMA Studio.") };
    }
    if (!capabilities.ok || !profile.ok) throw new Error("Account authority unavailable");
    const [account, { userId }] = await Promise.all([capabilities.json(), profile.json()]);
    if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
      throw new Error("Invalid account authority response");
    }
    return { userId: userId.toLowerCase(), account };
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

/** 利用者に見せる枠の状態。金額は返さず、割合とリセットの時刻だけにする。 */
function weeklyView(snapshot) {
  return {
    usedRatio: Math.min(1, Math.max(0, Math.round(snapshot.usedRatio * 10_000) / 10_000)),
    resetsAt: snapshot.resetsAt === null ? null : new Date(snapshot.resetsAt).toISOString(),
    reached: snapshot.reached === true,
  };
}

function usageLimitReached(snapshot, now) {
  const weekly = weeklyView(snapshot);
  const response = json({
    error: {
      code: "USAGE_LIMIT_REACHED",
      message: "You have used this week's SIGMA AI allowance.",
      resetsAt: weekly.resetsAt,
    },
  // 429 にしない。利用者側の SDK は 429 を待って送り直すが、枠は待っても数秒では戻らない。
  }, 402);
  if (snapshot.resetsAt !== null) {
    response.headers.set("retry-after", String(Math.max(1, Math.ceil((snapshot.resetsAt - now) / 1000))));
  }
  return response;
}

/** JSON 応答 (ストリームでない応答) から、使用量と generation の ID を拾う。 */
function createJsonUsageReader() {
  const decoder = new TextDecoder();
  let text = "";
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      text += decoder.decode(chunk, { stream: true });
      if (text.length > MAX_METERED_JSON_CHARS) {
        overflow = true;
        text = "";
      }
    },
    end() {
      if (overflow) return { usage: null, generationId: null };
      try {
        const parsed = JSON.parse(text + decoder.decode());
        return {
          usage: typeof parsed?.usage === "object" && parsed.usage !== null ? parsed.usage : null,
          generationId: typeof parsed?.id === "string" && parsed.id ? parsed.id : null,
        };
      } catch {
        return { usage: null, generationId: null };
      }
    },
  };
}

/**
 * 上流の本文を 1 バイトも変えずに流しながら、使用量を読む。
 * 流し終えた・途中で切れた・受け取る側が閉じた、のどれでも `onEnd` を 1 度だけ呼ぶ。
 *
 * 受け取る側が切れたことは `signal` (要求の中断) でも受ける。Workers は、切れた応答の本文を
 * 読みに来なくなるだけで `cancel` を呼ばないことがあり、それを待つと押さえが外れず料金も数えられない。
 */
function meterBody(upstreamBody, reader, onEnd, signal) {
  const source = upstreamBody.getReader();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd(reader.end());
  };
  const abandon = () => {
    end();
    source.cancel().catch(() => {});
  };
  if (signal?.aborted) abandon();
  else signal?.addEventListener("abort", abandon, { once: true });
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await source.read();
        if (done) {
          controller.close();
          end();
          return;
        }
        reader.push(value);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        end();
      }
    },
    cancel(reason) {
      end();
      return source.cancel(reason).catch(() => {});
    },
  });
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

/** 応答に料金が付かなかった要求の料金を、上流の generation から引く。分からなければ null。 */
async function lookupGenerationCost(generationId, { base, env, fetcher, delays }) {
  if (typeof generationId !== "string" || !/^gen-[0-9A-Za-z-]{1,128}$/.test(generationId)) return null;
  for (const delay of delays) {
    await sleep(delay);
    try {
      const response = await fetcher(`${base}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const cost = costToMicroUsd((await response.json())?.data?.total_cost);
        if (cost !== null) return cost;
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      // 次の回でもう一度聞く。
    }
  }
  return null;
}

function tokenCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** 上流へ渡す利用者の識別子。利用者の ID そのものは外へ出さず、戻せない形にする。 */
async function hashedUser(userId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sigma-ai:${userId}`));
  return `u_${[...new Uint8Array(digest)].slice(0, 16).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function chatCompletions(request, env, fetcher, context) {
  const { access, allowance, waitUntil, now, lookupDelays } = context;
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

  // 設定の誤り (https でない上流・事業者の選び方・枠の設定) は、通信の失敗と区別して 500 にする。
  const base = upstreamBase(env);
  const routing = providerRouting(env);
  if (routing) upstreamBody.provider = routing;
  const holdMicroUsd = requestHoldMicroUsd(env);
  if (env.OPENROUTER_USER_ATTRIBUTION === "hashed") upstreamBody.user = await hashedUser(access.userId);

  // 上流へ送る前に枠を確かめる。台帳が答えなければ送らない (数えられない利用を通さない)。
  const limitMicroUsd = allowance.weeklyLimitMicroUsd;
  let started;
  try {
    started = await callLedger(env, access.userId, "begin", { now: now(), limitMicroUsd, holdMicroUsd });
  } catch {
    return fail(503, "USAGE_LEDGER_UNAVAILABLE", "Could not check your SIGMA AI allowance.");
  }
  // 終わりの報告が来なかった前の要求があれば、応答の後で上流に料金を聞き直して数える。
  const reconciler = { base, env, fetcher, delays: lookupDelays, userId: access.userId, limitMicroUsd, now };
  waitUntil(reconcileUsage(started.reconcile, reconciler));
  if (!started.allowed) return usageLimitReached(started, now());

  // ここから先は、どの終わり方でも押さえを台帳へ返す。
  // 記録が終わるまで実行を続けさせる約束は、いま渡しておく。応答の途中で受け取る側が切れると、
  // その時点で待たせるものが無ければ、料金を数える前に実行が畳まれる。
  let settlementDone;
  waitUntil(new Promise((resolve) => { settlementDone = resolve; }));
  const settle = async (outcome) => {
    try {
      const usage = outcome.usage ?? {};
      let costMicroUsd = outcome.billed ? costToMicroUsd(usage.cost) : 0;
      if (outcome.billed && costMicroUsd === null) {
        costMicroUsd = await lookupGenerationCost(outcome.generationId, { base, env, fetcher, delays: lookupDelays });
      }
      const promptTokens = tokenCount(usage.prompt_tokens);
      const completionTokens = tokenCount(usage.completion_tokens);
      const cachedTokens = tokenCount(usage.prompt_tokens_details?.cached_tokens);
      await callLedger(env, access.userId, "settle", {
        now: now(), reservationId: started.reservationId, billed: outcome.billed, costMicroUsd, promptTokens, completionTokens, cachedTokens, limitMicroUsd,
      });
      // 利用者をまたいだ集計は、置き先に Analytics Engine があるときだけ書く (無くても枠の判定は台帳だけで決まる)。
      if (outcome.billed) {
        env.AI_USAGE_EVENTS?.writeDataPoint?.({
          indexes: [access.userId],
          blobs: [allowance.plan, body.model, costMicroUsd === null ? "unmetered" : "metered"],
          doubles: [(costMicroUsd ?? holdMicroUsd) / 1_000_000, promptTokens, completionTokens, cachedTokens],
        });
      }
    } catch {
      // 台帳へ書けなかった押さえは、台帳の側で時間切れとして数えられる。
    } finally {
      settlementDone();
    }
  };

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
      redirect: "manual",
      signal: AbortSignal.any([controller.signal, request.signal]),
    });
  } catch {
    await settle({ billed: false });
    return fail(502, "UPSTREAM_UNREACHABLE", "The model provider could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => {});
    await settle({ billed: false });
    return fail(502, "UPSTREAM_UNREACHABLE", "The model provider could not be reached.");
  }

  // 上流のヘッダーは持ち帰らない (レート制限や課金の識別子を利用者へ出さない)。
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  // 上流が断った要求 (4xx/5xx) に料金はかからない。押さえを外して、そのまま返す。
  if (!upstream.ok || !upstream.body) {
    await settle({ billed: false });
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  // generation の ID は本文より先にヘッダーで届く。最初の塊の前に切れても料金を引ける。
  // 台帳にも覚えさせる: 応答の途中でこの実行が畳まれても、次の要求のときに料金を聞き直せる。
  const headerGenerationId = upstream.headers.get("x-generation-id");
  if (headerGenerationId) {
    waitUntil(callLedger(env, access.userId, "attach", { now: now(), reservationId: started.reservationId, generationId: headerGenerationId }).catch(() => {}));
  }
  const reader = contentType.includes("text/event-stream") ? createUsageScanner() : createJsonUsageReader();
  const metered = meterBody(upstream.body, reader, ({ usage, generationId }) => {
    void settle({ billed: true, usage, generationId: headerGenerationId ?? generationId });
  }, request.signal);
  return new Response(metered, { status: upstream.status, headers });
}

/**
 * 終わりの報告が来なかった要求 (応答の途中で実行が畳まれた要求) を、上流の記録から数え直す。
 * 料金が分からなければ、元の押さえの額を数える。
 */
async function reconcileUsage(items, { base, env, fetcher, delays, userId, limitMicroUsd, now }) {
  for (const item of Array.isArray(items) ? items : []) {
    try {
      const costMicroUsd = await lookupGenerationCost(item.generationId, { base, env, fetcher, delays });
      await callLedger(env, userId, "settle", { now: now(), reservationId: "", billed: true, costMicroUsd, fallbackMicroUsd: item.microUsd, limitMicroUsd });
    } catch {
      // 数え直せなかった分は、ここで終わり (上流の全体の支出上限が最後の歯止め)。
    }
  }
}

/** いまの枠の使い方。枠の無いプランにも 200 で答える (設定画面が理由を出せるように)。 */
async function usageReport(env, fetcher, { access, allowance, now, waitUntil, lookupDelays }) {
  if (!allowance) {
    return json({ plan: typeof access.account?.plan === "string" ? access.account.plan : "free", included: false, weekly: null });
  }
  const limitMicroUsd = allowance.weeklyLimitMicroUsd;
  const snapshot = await callLedger(env, access.userId, "snapshot", { now: now(), limitMicroUsd });
  if (snapshot.reconcile?.length > 0) {
    waitUntil(reconcileUsage(snapshot.reconcile, {
      base: upstreamBase(env), env, fetcher, delays: lookupDelays, userId: access.userId, limitMicroUsd, now,
    }));
  }
  return json({ plan: allowance.plan, included: true, weekly: weeklyView(snapshot) });
}

async function sameSecret(presented, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([presented, expected].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

/**
 * 運用者向け: 1 人の台帳を金額のまま読む (GET)、いまの窓を閉じて枠を戻す (DELETE)。
 * `ADMIN_TOKEN` を置いたときだけ開く。置いていなければ経路そのものが無い。
 */
async function adminUsage(request, url, env, now) {
  const token = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
  if (token.length < 32 || !env.AI_USAGE?.idFromName || !["GET", "DELETE"].includes(request.method)) {
    return fail(404, "NOT_FOUND", "Unknown route.");
  }
  if (!(await sameSecret(request.headers.get("authorization") ?? "", `Bearer ${token}`))) {
    return fail(401, "UNAUTHORIZED", "Admin token required.");
  }
  const userId = url.searchParams.get("user") ?? "";
  if (!USER_ID_PATTERN.test(userId)) return fail(400, "INVALID_REQUEST", "user must be an account id.");
  const operation = request.method === "DELETE" ? "reset" : "inspect";
  return json(await callLedger(env, userId.toLowerCase(), operation, { now: now() }));
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

/**
 * `ctx` は Workers の実行コンテキスト (応答の後も使用量の記録を終えるまで待たせる)。
 * `options` はテスト用: `now` (時刻)、`generationLookupDelaysMs` (料金の問い合わせの待ち時間)。
 */
export async function handleGatewayRequest(request, env, fetcher = fetch, ctx = undefined, options = {}) {
  const url = new URL(request.url);
  url.pathname = stripMountPath(url.pathname, env.MOUNT_PATH);
  const now = typeof options.now === "function" ? options.now : Date.now;
  if (request.method === "GET" && url.pathname === "/health") {
    const ok = Boolean(ready(env) && env.OPENROUTER_API_KEY);
    return json({ ok, protocol: 1 }, ok ? 200 : 503);
  }
  if (url.pathname === "/admin/usage") {
    try {
      return await adminUsage(request, url, env, now);
    } catch {
      return fail(500, "GATEWAY_ERROR", "The gateway failed to process the request.");
    }
  }

  const models = request.method === "GET" && url.pathname === "/v1/models";
  const usage = request.method === "GET" && url.pathname === "/v1/usage";
  const chat = request.method === "POST" && url.pathname === "/v1/chat/completions";
  if (!models && !usage && !chat) return fail(404, "NOT_FOUND", "Unknown route.");
  const access = await authorize(request, env);
  if (access.error) return access.error;

  try {
    // 枠はプランの表から決まる。表に無いプラン (無料) は内蔵AIを使えない。
    const allowance = resolveAllowance(access.account, env);
    const limited = async (key) => {
      const { success } = await env.AI_RATE_LIMIT.limit({ key });
      if (success) return null;
      const response = fail(429, "RATE_LIMITED", "Too many SIGMA AI requests. Try again in a minute.");
      response.headers.set("retry-after", "60");
      return response;
    };
    const waitUntil = promise => ctx?.waitUntil?.(promise);
    const lookupDelays = Array.isArray(options.generationLookupDelaysMs) ? options.generationLookupDelaysMs : GENERATION_LOOKUP_DELAYS_MS;
    if (usage) {
      return await limited(`usage:${access.userId}`) ?? await usageReport(env, fetcher, { access, allowance, now, waitUntil, lookupDelays });
    }
    if (!allowance) return fail(403, "PRO_REQUIRED", "SIGMA AI requires a plan that includes it.");
    if (models) {
      return json({ object: "list", data: allowedModels(env).map(id => ({ id, object: "model" })) });
    }
    return await limited(access.userId) ?? await chatCompletions(request, env, fetcher, { access, allowance, now, waitUntil, lookupDelays });
  } catch {
    return fail(500, "GATEWAY_ERROR", "The gateway failed to process the request.");
  }
}

export default {
  fetch(request, env, ctx) {
    return handleGatewayRequest(request, env, fetch, ctx);
  },
};
