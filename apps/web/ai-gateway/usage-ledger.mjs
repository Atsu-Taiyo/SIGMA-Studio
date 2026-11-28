// 内蔵AIの利用枠と、利用者ごとの使用量の台帳。
//
// 利用枠はプランごとの「月あたりの予算 (USD)」で決め、1 週間ごとに使い切りを数え直す。
//   週の枠 = 月の予算 × 12 ÷ 52   (月 5 ドルなら 1 週間に約 1.15 ドル)
// 5 時間などの短い窓は持たない。窓は最初に使った時刻から 7 日間で、過ぎたら次に使った時刻から始め直す。
//
// 上位プランは、予算の表 (`AI_PLAN_MONTHLY_BUDGET_USD`) に行を足すだけで増やせる。プランの判定は
// 共有サービス (`/catalog/capabilities` の `plan`) が持ち、ここは「そのプランの予算はいくらか」だけを決める。
// 台帳は金額 (マイクロドル) で持つが、利用者には割合だけを返す。
//
// このファイルは Web 標準と素の JavaScript だけで書く (Node のテストからそのまま読み込む)。

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MICRO_USD = 1_000_000;
/** 予算の表に無いプランは内蔵AIを使えない。試用期間は Pro と同じ枠 (7 日間なので 1 週ぶん)。 */
export const DEFAULT_PLAN_MONTHLY_BUDGET_USD = Object.freeze({ trial: 5, pro: 5 });
/** 1 回の要求が終わるまで押さえておく額。料金が分からなかった要求には、この額を数える。 */
export const DEFAULT_REQUEST_HOLD_MICRO_USD = 10_000;
/**
 * 終わりの報告が来ないままの押さえを外すまでの時間。応答の途中で中継の実行が畳まれると
 * (受け取る側の切断の後など)、終わりの報告は来ない。1 回の応答はこれより十分短い。
 */
const HOLD_TTL_MS = 15 * 60 * 1000;
const MAX_HOLDS = 64;
/** 終わりの報告が来なかった要求のうち、上流に料金を聞き直せるもの (generation の ID が分かっているもの) の控え。 */
const MAX_UNRECONCILED = 64;
const RECONCILE_BATCH = 8;
const MAX_HISTORY = 26;
const MAX_MONTHLY_BUDGET_USD = 10_000;
const STATE_KEY = "ledger";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBudget(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MONTHLY_BUDGET_USD;
}

/** プランごとの月の予算 (USD)。置き先の設定が無ければ既定の表。形の違う設定は黙って捨てずに誤りとして止める。 */
export function planMonthlyBudgets(env) {
  if (typeof env.AI_PLAN_MONTHLY_BUDGET_USD !== "string" || !env.AI_PLAN_MONTHLY_BUDGET_USD.trim()) {
    return DEFAULT_PLAN_MONTHLY_BUDGET_USD;
  }
  let parsed;
  try {
    parsed = JSON.parse(env.AI_PLAN_MONTHLY_BUDGET_USD);
  } catch {
    throw new Error("INVALID_CONFIGURATION");
  }
  if (!isRecord(parsed)) throw new Error("INVALID_CONFIGURATION");
  for (const [plan, budget] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(plan) || !isBudget(budget)) throw new Error("INVALID_CONFIGURATION");
  }
  return parsed;
}

export function weeklyAllowanceMicroUsd(monthlyBudgetUsd) {
  return Math.round(monthlyBudgetUsd * 12 / 52 * MICRO_USD);
}

/**
 * この利用者の 1 週間の枠。枠が無い (内蔵AIを含まないプラン) なら null。
 * 共有サービスが `aiMonthlyBudgetUsd` を返したら、表より優先する (個別の増枠・追加購入を表せる)。
 */
export function resolveAllowance(capabilities, env) {
  const plan = isRecord(capabilities) && typeof capabilities.plan === "string" ? capabilities.plan : "";
  const override = isRecord(capabilities) ? capabilities.aiMonthlyBudgetUsd : undefined;
  const budgets = planMonthlyBudgets(env);
  const monthly = isBudget(override) ? override : Object.hasOwn(budgets, plan) ? budgets[plan] : 0;
  if (!(monthly > 0)) return null;
  return { plan, weeklyLimitMicroUsd: weeklyAllowanceMicroUsd(monthly) };
}

export function requestHoldMicroUsd(env) {
  if (env.AI_REQUEST_HOLD_MICRO_USD === undefined || env.AI_REQUEST_HOLD_MICRO_USD === "") return DEFAULT_REQUEST_HOLD_MICRO_USD;
  const value = Number(env.AI_REQUEST_HOLD_MICRO_USD);
  if (!Number.isInteger(value) || value < 0 || value > MICRO_USD) throw new Error("INVALID_CONFIGURATION");
  return value;
}

/** 上流が返した料金 (USD) をマイクロドルにする。読めない値は null (= 分からない)。 */
export function costToMicroUsd(cost) {
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * MICRO_USD) : null;
}

function count(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function emptyWindow(startedAt) {
  return { startedAt, costMicroUsd: 0, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, unmetered: 0, unsettled: 0 };
}

function readState(value) {
  const state = isRecord(value) ? value : {};
  return {
    version: 1,
    window: isRecord(state.window) && Number.isFinite(state.window.startedAt) ? { ...emptyWindow(state.window.startedAt), ...state.window } : null,
    holds: isRecord(state.holds) ? { ...state.holds } : {},
    unreconciled: Array.isArray(state.unreconciled) ? [...state.unreconciled] : [],
    history: Array.isArray(state.history) ? [...state.history] : [],
  };
}

/**
 * 7 日を過ぎた窓を閉じ、終わりの報告が来なかった押さえを外す。
 * 上流の generation の ID が分かっている押さえは、料金を聞き直すために控えへ移す (`takeUnreconciled`)。
 * 分からない押さえは外すだけで、数を窓に残す。
 */
function roll(state, now) {
  if (state.window && now >= state.window.startedAt + WEEK_MS) {
    const { startedAt, costMicroUsd, requests, unmetered, unsettled } = state.window;
    state.history = [{ startedAt, costMicroUsd, requests, unmetered, unsettled }, ...state.history].slice(0, MAX_HISTORY);
    state.window = null;
  }
  for (const [id, hold] of Object.entries(state.holds)) {
    if (!isRecord(hold) || now - hold.at >= HOLD_TTL_MS) {
      delete state.holds[id];
      if (isRecord(hold) && typeof hold.generationId === "string" && state.unreconciled.length < MAX_UNRECONCILED) {
        state.unreconciled.push({ generationId: hold.generationId, microUsd: count(hold.microUsd) });
      } else if (state.window) {
        state.window.unsettled += 1;
      }
    }
  }
  return state;
}

/** 進行中の要求の押さえと、料金を聞き直している要求の押さえ。どちらも、まだ数えていない利用。 */
function heldMicroUsd(state) {
  return [...Object.values(state.holds), ...state.unreconciled].reduce((sum, hold) => sum + count(hold.microUsd), 0);
}

/** 料金を聞き直す要求を、控えから少しずつ渡す。渡したものは呼び出し側が `settle` で数える。 */
function takeUnreconciled(state) {
  return state.unreconciled.splice(0, RECONCILE_BATCH);
}

function view(state, limitMicroUsd) {
  const usedMicroUsd = state.window?.costMicroUsd ?? 0;
  return {
    usedMicroUsd,
    limitMicroUsd,
    usedRatio: limitMicroUsd > 0 ? usedMicroUsd / limitMicroUsd : 1,
    startedAt: state.window?.startedAt ?? null,
    resetsAt: state.window ? state.window.startedAt + WEEK_MS : null,
    // 「いま送ると断られるか」と同じ判定にする (進行中の要求の押さえも数える)。
    // 画面が「まだ残っている」と出しているのに断られる、という食い違いを作らない。
    reached: usedMicroUsd + heldMicroUsd(state) >= limitMicroUsd,
  };
}

/**
 * 1 人ぶんの台帳。`storage` は `get(key)` / `put(key, value)` を持つもの (Durable Object の storage)。
 * 読んでから書くまでに storage 以外を待たないので、Durable Object の中では要求どうしが混ざらない。
 */
export class UsageLedger {
  constructor(storage) {
    this.storage = storage;
  }

  async load(now) {
    return roll(readState(await this.storage.get(STATE_KEY)), now);
  }

  /** 要求を通してよいか。通すなら、終わるまでの押さえを置く。 */
  async begin({ now, limitMicroUsd, holdMicroUsd }) {
    const state = await this.load(now);
    // 進行中の要求の押さえも数える。同時に何本送っても、枠を大きく超えては通らない。
    // 判定は、聞き直しに渡す前の状態でする (渡す分も、まだ数えていない利用として効かせる)。
    const current = view(state, limitMicroUsd);
    const reconcile = takeUnreconciled(state);
    if (current.reached || Object.keys(state.holds).length >= MAX_HOLDS) {
      await this.storage.put(STATE_KEY, state);
      return { allowed: false, reconcile, ...current };
    }
    state.window ??= emptyWindow(now);
    const reservationId = crypto.randomUUID();
    state.holds[reservationId] = { microUsd: count(holdMicroUsd), at: now };
    await this.storage.put(STATE_KEY, state);
    return { allowed: true, reservationId, reconcile, ...view(state, limitMicroUsd) };
  }

  /** 上流が返した generation の ID を、押さえに覚えさせる (終わりの報告が来なかったときに料金を聞き直せる)。 */
  async attach({ now, reservationId, generationId }) {
    const state = await this.load(now);
    const hold = state.holds[reservationId];
    if (isRecord(hold) && typeof generationId === "string" && /^gen-[0-9A-Za-z-]{1,128}$/.test(generationId)) {
      hold.generationId = generationId;
      await this.storage.put(STATE_KEY, state);
    }
    return { ok: true };
  }

  /**
   * 要求の終わり。`costMicroUsd` が null (料金が分からなかった) なら、押さえた額を数えて件数を残す。
   * `billed: false` は上流へ届かなかった・上流が断った要求で、押さえを外すだけ。
   * 聞き直した要求 (押さえはもう無い) は `fallbackMicroUsd` に元の押さえの額を渡す。
   */
  async settle({ now, reservationId, costMicroUsd, billed = true, fallbackMicroUsd, promptTokens, completionTokens, cachedTokens, limitMicroUsd }) {
    const state = await this.load(now);
    const hold = state.holds[reservationId];
    delete state.holds[reservationId];
    if (billed) {
      state.window ??= emptyWindow(now);
      const known = Number.isInteger(costMicroUsd) && costMicroUsd >= 0;
      state.window.costMicroUsd += known ? costMicroUsd : count(hold?.microUsd ?? fallbackMicroUsd);
      state.window.requests += 1;
      state.window.promptTokens += count(promptTokens);
      state.window.completionTokens += count(completionTokens);
      state.window.cachedTokens += count(cachedTokens);
      if (!known) state.window.unmetered += 1;
    }
    await this.storage.put(STATE_KEY, state);
    return view(state, limitMicroUsd);
  }

  async snapshot({ now, limitMicroUsd }) {
    const state = await this.load(now);
    const current = view(state, limitMicroUsd);
    const reconcile = takeUnreconciled(state);
    if (reconcile.length > 0) await this.storage.put(STATE_KEY, state);
    return { ...current, reconcile };
  }

  /** 運用者向け: 金額・件数・過去の窓をそのまま返す。 */
  async inspect({ now }) {
    const state = await this.load(now);
    return {
      window: state.window, holds: Object.keys(state.holds).length, unreconciled: state.unreconciled.length,
      heldMicroUsd: heldMicroUsd(state), history: state.history,
    };
  }

  /** 運用者向け: いまの窓を閉じる (問い合わせへの対応で枠を戻すとき)。過去の窓には残す。 */
  async reset({ now }) {
    const state = await this.load(now);
    if (state.window) roll(state, state.window.startedAt + WEEK_MS);
    state.holds = {};
    state.unreconciled = [];
    await this.storage.put(STATE_KEY, state);
    return { ok: true };
  }
}

const OPERATIONS = new Set(["begin", "attach", "settle", "snapshot", "inspect", "reset"]);

/**
 * 利用者 1 人につき 1 つの Durable Object。名前は利用者の ID。
 * 中継 (同じ Worker) からだけ呼ばれ、外からの経路は無い。
 */
export class AiUsageLedger {
  constructor(state) {
    this.ledger = new UsageLedger(state.storage);
  }

  async fetch(request) {
    const operation = new URL(request.url).pathname.slice(1);
    if (request.method !== "POST" || !OPERATIONS.has(operation)) return new Response(null, { status: 404 });
    return Response.json(await this.ledger[operation](await request.json()));
  }
}

/** 中継から台帳を呼ぶ。台帳が答えなければ例外にする (呼び出し側は要求を通さない)。 */
export async function callLedger(env, userId, operation, args) {
  const stub = env.AI_USAGE.get(env.AI_USAGE.idFromName(userId));
  const response = await stub.fetch(`https://ledger.internal/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error("Usage ledger unavailable");
  return response.json();
}

/**
 * 応答 (SSE) を通しながら、使用量と generation の ID だけを拾う。本文の差分は JSON として読まない。
 * 行の途中で切れた塊は次の塊とつなぐ。
 */
export function createUsageScanner(maxLineLength = 4 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let carry = "";
  let usage = null;
  let generationId = null;
  const inspect = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]" || (generationId && !data.includes('"usage"'))) return;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.id === "string" && parsed.id) generationId ??= parsed.id;
      if (isRecord(parsed.usage)) usage = parsed.usage;
    } catch {
      // 壊れた行は使用量として読まない。応答そのものは加工せずに流れている。
    }
  };
  return {
    push(chunk) {
      carry += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = carry.indexOf("\n")) !== -1) {
        inspect(carry.slice(0, index));
        carry = carry.slice(index + 1);
      }
      if (carry.length > maxLineLength) carry = "";
    },
    end() {
      inspect(carry + decoder.decode());
      carry = "";
      return { usage, generationId };
    },
  };
}
