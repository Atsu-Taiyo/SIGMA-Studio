// AIの使用状況。2 種類ある:
//   - アカウントの利用枠 (5 時間・1 週間などの窓ごとの使用率)。AI ごとに 1 つ。
//   - 会話のコンテキスト使用量 (最後の応答の時点のトークン数)。会話ごとに 1 つ。
// 値を作る側 (main の各クライアント) と見せる側 (チャット・AI設定) が同じ型を使う。
// 各 AI が返す形はここで 1 度だけ読み、画面には割合と時刻だけを渡す。

import type { AiProvider } from "@/lib/ai/ai-providers";

export interface AiContextUsage {
  usedTokens: number;
  /** モデルのコンテキスト上限。AI が知らせないときは null (使用量だけを出す)。 */
  windowTokens: number | null;
}

/** session = 数時間の窓、weekly = 1 週間の窓、weeklyModel = モデル別の 1 週間の窓。 */
export type AiUsageWindowKind = "session" | "weekly" | "weeklyModel";

export interface AiUsageWindow {
  kind: AiUsageWindowKind;
  /** 0〜1。 */
  usedRatio: number;
  /** リセットの時刻 (epoch ms)。まだ使っていない・AI が知らせないときは null。 */
  resetsAt: number | null;
  /** weeklyModel のモデル名 (AI が返した識別子のまま)。 */
  model?: string;
  /** 窓の長さ (分)。AI が知らせたときだけ付く (5 時間 = 300、1 週間 = 10080)。 */
  windowMinutes?: number;
}

export type AiAccountUsageState =
  /** 窓の値がある。 */
  | "available"
  /** まだ分からない (その AI を次に実行すると分かる)。 */
  | "unknown"
  /** この AI は使用量を知らせない。 */
  | "unsupported"
  /** 内蔵AI: いまのプランに利用枠が無い。 */
  | "notIncluded";

export interface AiAccountUsage {
  provider: AiProvider;
  state: AiAccountUsageState;
  windows: AiUsageWindow[];
  /** AI が返したプラン名 (内蔵AI: free / trial / pro …、ChatGPT: plus / pro …)。 */
  plan: string | null;
  /** いま上限で止められている。 */
  limitReached: boolean;
  /** この値を受け取った時刻 (epoch ms)。 */
  observedAt: number | null;
}

export type AiUsageSnapshot = Record<AiProvider, AiAccountUsage>;

export const AI_USAGE_PROVIDERS: readonly AiProvider[] = ["sigma", "chatgpt", "claude", "antigravity"];

const WINDOW_ORDER: Record<AiUsageWindowKind, number> = { session: 0, weekly: 1, weeklyModel: 2 };
const SIX_DAYS_MINUTES = 6 * 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function tokens(value: unknown): number {
  const count = finite(value);
  return count !== null && count > 0 ? Math.round(count) : 0;
}

function sortWindows(windows: AiUsageWindow[]): AiUsageWindow[] {
  return [...windows].sort((a, b) => WINDOW_ORDER[a.kind] - WINDOW_ORDER[b.kind] || (a.model ?? "").localeCompare(b.model ?? ""));
}

export function emptyAiAccountUsage(provider: AiProvider): AiAccountUsage {
  return {
    provider,
    // Antigravity の CLI は利用枠を知らせない。ほかは最初の取得まで「まだ分からない」。
    state: provider === "antigravity" ? "unsupported" : "unknown",
    windows: [],
    plan: null,
    limitReached: false,
    observedAt: null,
  };
}

export function emptyAiUsageSnapshot(): AiUsageSnapshot {
  return {
    sigma: emptyAiAccountUsage("sigma"),
    chatgpt: emptyAiAccountUsage("chatgpt"),
    claude: emptyAiAccountUsage("claude"),
    antigravity: emptyAiAccountUsage("antigravity"),
  };
}

/**
 * リセットの時刻を過ぎた窓を外す。覚えていた値は、時刻を過ぎたらもう正しくない
 * (0% と決めつけない — ほかの端末で使っているかもしれない)。
 */
export function dropExpiredUsageWindows(usage: AiAccountUsage, now: number): AiAccountUsage {
  if (usage.state !== "available") return usage;
  const windows = usage.windows.filter(window => window.resetsAt === null || window.resetsAt > now);
  if (windows.length === usage.windows.length) return usage;
  return windows.length > 0
    ? { ...usage, windows, limitReached: usage.limitReached && windows.some(window => window.usedRatio >= 1) }
    : { ...usage, state: "unknown", windows: [], limitReached: false };
}

/** 秒でも ms でも来る時刻を ms にそろえる (Claude・Codex は秒、内蔵AIは ISO 文字列)。 */
function toEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = finite(value);
  if (number === null || number <= 0) return null;
  return number < 100_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}

const FIVE_HOURS_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

function claudeWindowKind(key: string): Pick<AiUsageWindow, "kind" | "model" | "windowMinutes"> | null {
  if (key === "five_hour") return { kind: "session", windowMinutes: FIVE_HOURS_MINUTES };
  if (key === "seven_day") return { kind: "weekly", windowMinutes: WEEK_MINUTES };
  // seven_day_opus / seven_day_sonnet などはモデル別の 1 週間の窓。
  const model = /^seven_day_([a-z0-9_]+)$/u.exec(key)?.[1];
  return model ? { kind: "weeklyModel", model, windowMinutes: WEEK_MINUTES } : null;
}

/**
 * Claude Code の `rate_limit_event` (stream-json)。変わった窓だけが届くので、前の値に重ねる。
 * 例: `{ status: "allowed", rateLimitType: "seven_day", resetsAt: 1796371200,
 *        unifiedWindows: { seven_day: { utilization: 0.07, resetsAt: 1796371200 } } }`
 */
export function claudeUsageFromRateLimitInfo(info: unknown, previous: AiAccountUsage | null, now: number): AiAccountUsage | null {
  if (!isRecord(info)) return null;
  const incoming: AiUsageWindow[] = [];
  if (isRecord(info.unifiedWindows)) {
    for (const [key, value] of Object.entries(info.unifiedWindows)) {
      const kind = claudeWindowKind(key);
      const utilization = isRecord(value) ? finite(value.utilization) : null;
      if (!kind || utilization === null || !isRecord(value)) continue;
      incoming.push({ ...kind, usedRatio: clampRatio(utilization), resetsAt: toEpochMs(value.resetsAt) });
    }
  }
  const rejected = info.status === "rejected" && info.isUsingOverage !== true;
  const named = typeof info.rateLimitType === "string" ? claudeWindowKind(info.rateLimitType) : null;
  if (named && !incoming.some(window => window.kind === named.kind && window.model === named.model)) {
    const utilization = finite(info.utilization);
    // 止められた窓は、使用率が付いていなくても使い切っている。
    if (utilization !== null || rejected) {
      incoming.push({ ...named, usedRatio: utilization === null ? 1 : clampRatio(utilization), resetsAt: toEpochMs(info.resetsAt) });
    }
  }
  if (incoming.length === 0 && !rejected) return null;
  const kept = (previous?.state === "available" ? dropExpiredUsageWindows(previous, now).windows : [])
    .filter(window => !incoming.some(next => next.kind === window.kind && next.model === window.model));
  const windows = sortWindows([...kept, ...incoming]);
  return {
    provider: "claude",
    state: windows.length > 0 ? "available" : "unknown",
    windows,
    plan: previous?.plan ?? null,
    limitReached: rejected,
    observedAt: now,
  };
}

/**
 * Codex app-server の `account/rateLimits/read` (`rateLimits`) と `account/rateLimits/updated`。
 * `primary` / `secondary` は `{ usedPercent, windowDurationMins, resetsAt }`。
 */
export function codexUsageFromRateLimits(snapshot: unknown, now: number, previous: AiAccountUsage | null = null): AiAccountUsage | null {
  if (!isRecord(snapshot)) return null;
  const incoming: AiUsageWindow[] = [];
  for (const value of [snapshot.primary, snapshot.secondary]) {
    const usedPercent = isRecord(value) ? finite(value.usedPercent) : null;
    if (!isRecord(value) || usedPercent === null) continue;
    const minutes = finite(value.windowDurationMins);
    const kind: AiUsageWindowKind = minutes !== null && minutes >= SIX_DAYS_MINUTES ? "weekly" : "session";
    if (incoming.some(window => window.kind === kind)) continue;
    incoming.push({
      kind,
      usedRatio: clampRatio(usedPercent / 100),
      resetsAt: toEpochMs(value.resetsAt),
      ...(minutes !== null && minutes > 0 ? { windowMinutes: Math.round(minutes) } : {}),
    });
  }
  if (incoming.length === 0) return null;
  // `account/rateLimits/updated` は変わった分だけを知らせる。届かなかった窓とプラン名は、前の値を残す。
  const kept = (previous?.state === "available" ? dropExpiredUsageWindows(previous, now).windows : [])
    .filter(window => !incoming.some(next => next.kind === window.kind));
  const windows = [...kept, ...incoming];
  return {
    provider: "chatgpt",
    state: "available",
    windows: sortWindows(windows),
    plan: typeof snapshot.planType === "string" ? snapshot.planType : previous?.plan ?? null,
    limitReached: (snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined)
      || windows.some(window => window.usedRatio >= 1),
    observedAt: now,
  };
}

/** 内蔵AIの中継の `GET /v1/usage`: `{ plan, included, weekly: { usedRatio, resetsAt, reached } | null }`。 */
export function sigmaUsageFromGateway(body: unknown, now: number): AiAccountUsage | null {
  if (!isRecord(body) || typeof body.included !== "boolean") return null;
  const plan = typeof body.plan === "string" ? body.plan : null;
  if (!body.included) {
    return { provider: "sigma", state: "notIncluded", windows: [], plan, limitReached: false, observedAt: now };
  }
  const weekly = isRecord(body.weekly) ? body.weekly : null;
  const usedRatio = weekly ? finite(weekly.usedRatio) : null;
  if (!weekly || usedRatio === null) return null;
  return {
    provider: "sigma",
    state: "available",
    windows: [{ kind: "weekly", usedRatio: clampRatio(usedRatio), resetsAt: toEpochMs(weekly.resetsAt), windowMinutes: WEEK_MINUTES }],
    plan,
    limitReached: weekly.reached === true,
    observedAt: now,
  };
}

/** Claude の `assistant` メッセージの `usage`。入力 (キャッシュを含む) と出力の合計が、その時点のコンテキスト。 */
export function claudeContextUsage(usage: unknown, windowTokens: number | null): AiContextUsage | null {
  if (!isRecord(usage)) return null;
  const usedTokens = tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens)
    + tokens(usage.cache_read_input_tokens) + tokens(usage.output_tokens);
  return usedTokens > 0 ? { usedTokens, windowTokens } : null;
}

/** Codex の `thread/tokenUsage/updated` の `tokenUsage`。`last` が最後の応答の時点。 */
export function codexContextUsage(tokenUsage: unknown): AiContextUsage | null {
  if (!isRecord(tokenUsage) || !isRecord(tokenUsage.last)) return null;
  const usedTokens = tokens(tokenUsage.last.totalTokens);
  const window = finite(tokenUsage.modelContextWindow);
  return usedTokens > 0 ? { usedTokens, windowTokens: window !== null && window > 0 ? Math.round(window) : null } : null;
}

/** OpenAI Chat Completions 互換の `usage` (内蔵AIの中継の応答)。 */
export function chatCompletionContextUsage(usage: unknown, windowTokens: number | null): AiContextUsage | null {
  if (!isRecord(usage)) return null;
  const usedTokens = tokens(usage.prompt_tokens) + tokens(usage.completion_tokens);
  return usedTokens > 0 ? { usedTokens, windowTokens } : null;
}

/** 保存した値・IPC で受けた値を読み直す。形の合わないものは null。 */
export function parseAiContextUsage(value: unknown): AiContextUsage | null {
  if (!isRecord(value)) return null;
  const usedTokens = tokens(value.usedTokens);
  const window = finite(value.windowTokens);
  return usedTokens > 0 ? { usedTokens, windowTokens: window !== null && window > 0 ? Math.round(window) : null } : null;
}

export function parseAiAccountUsage(provider: AiProvider, value: unknown): AiAccountUsage {
  const empty = emptyAiAccountUsage(provider);
  if (!isRecord(value)) return empty;
  const state = value.state;
  if (state !== "available" && state !== "unknown" && state !== "unsupported" && state !== "notIncluded") return empty;
  const windows = (Array.isArray(value.windows) ? value.windows : []).flatMap((window): AiUsageWindow[] => {
    if (!isRecord(window)) return [];
    const kind = window.kind;
    const usedRatio = finite(window.usedRatio);
    if ((kind !== "session" && kind !== "weekly" && kind !== "weeklyModel") || usedRatio === null) return [];
    const minutes = finite(window.windowMinutes);
    return [{
      kind,
      usedRatio: clampRatio(usedRatio),
      resetsAt: finite(window.resetsAt),
      ...(typeof window.model === "string" && window.model ? { model: window.model.slice(0, 64) } : {}),
      ...(minutes !== null && minutes > 0 ? { windowMinutes: Math.round(minutes) } : {}),
    }];
  });
  return {
    provider,
    state: state === "available" && windows.length === 0 ? "unknown" : state,
    windows: sortWindows(windows),
    plan: typeof value.plan === "string" && value.plan ? value.plan.slice(0, 64) : null,
    limitReached: value.limitReached === true,
    observedAt: finite(value.observedAt),
  };
}

export function parseAiUsageSnapshot(value: unknown): AiUsageSnapshot {
  const record = isRecord(value) ? value : {};
  return {
    sigma: parseAiAccountUsage("sigma", record.sigma),
    chatgpt: parseAiAccountUsage("chatgpt", record.chatgpt),
    claude: parseAiAccountUsage("claude", record.claude),
    antigravity: parseAiAccountUsage("antigravity", record.antigravity),
  };
}

/** 表示する割合 (整数の %)。使っているのに 0% と出さない。 */
export function usagePercent(ratio: number): number {
  const percent = Math.round(clampRatio(ratio) * 100);
  return percent === 0 && ratio > 0 ? 1 : percent;
}

/** normal = 余裕がある、warning = 残り 2 割を切った、reached = 使い切った。色だけに頼らず文でも出す。 */
export type AiUsageLevel = "normal" | "warning" | "reached";

export function usageLevel(ratio: number): AiUsageLevel {
  return ratio >= 1 ? "reached" : ratio >= 0.8 ? "warning" : "normal";
}

/** コンテキストの使用率 (0〜1)。上限が分からなければ null。 */
export function contextUsageRatio(usage: AiContextUsage | null | undefined): number | null {
  if (!usage || !usage.windowTokens) return null;
  return clampRatio(usage.usedTokens / usage.windowTokens);
}

/** 1234 → "1.2K"、1048576 → "1M"。トークン数の短い表記 (言語によらない)。 */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(Math.round(value));
}

function trimDecimal(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
