// AI がサブエージェント (作業を分担する別のエージェント) を使う設定。
// 設定ファイル (electron/desktop-settings.ts)・IPC・設定画面・各プロバイダの起動引数が
// 同じ値の範囲と既定値を読むので、React にも Electron にも依存させない。

/** サブエージェントを使えるAI。ai-edit:run の provider の値と同じ名前で持つ。 */
export const AI_SUBAGENT_PROVIDERS = ["claude", "chatgpt", "antigravity", "sigma"] as const;
export type AiSubagentProvider = (typeof AI_SUBAGENT_PROVIDERS)[number];

export interface AiSubagentSettings {
  /** 全体のスイッチ。false ならどのAIもサブエージェントを使わない。 */
  enabled: boolean;
  /**
   * 入れ子の深さの上限。1 は「AIがサブエージェントを起動できるが、そのサブエージェントは
   * さらに起動できない」。2 ならサブエージェントがもう1段だけ起動できる。
   */
  maxDepth: number;
  /** 同時に動かすサブエージェントの数の上限。 */
  maxConcurrent: number;
  /** AIごとのスイッチ。全体が有効でも、ここが false のAIは使わない。 */
  providers: Record<AiSubagentProvider, boolean>;
}

export const AI_SUBAGENT_MIN_DEPTH = 1;
export const AI_SUBAGENT_MAX_DEPTH = 5;
export const AI_SUBAGENT_MIN_CONCURRENT = 1;
export const AI_SUBAGENT_MAX_CONCURRENT = 10;

// 既定は「使えるが控えめ」: 入れ子なし・同時3つ。サブエージェントは利用枠を速く使うので、
// 深さと数は利用者が明示的に上げたときだけ増やす。
// 内蔵AI (sigma) だけは既定でオフ。モデルの利用料が利用者の枠ではなく中継 (運営) の負担で、
// サブエージェントは 1 つごとにモデルの呼び出しを増やすため、使うと決めたときだけオンにする。
export const DEFAULT_AI_SUBAGENT_SETTINGS: AiSubagentSettings = {
  enabled: true,
  maxDepth: 1,
  maxConcurrent: 3,
  providers: { claude: true, chatgpt: true, antigravity: true, sigma: false },
};

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 設定ファイルや IPC から来た値を、範囲に収めた完全な設定へ直す。
 * 欠けた項目・壊れた値は既定値にする (キーが無い = まだ触っていない)。
 */
export function normalizeAiSubagentSettings(value: unknown): AiSubagentSettings {
  const record = isRecord(value) ? value : {};
  const providers = isRecord(record.providers) ? record.providers : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_AI_SUBAGENT_SETTINGS.enabled,
    maxDepth: clampInteger(
      record.maxDepth,
      AI_SUBAGENT_MIN_DEPTH,
      AI_SUBAGENT_MAX_DEPTH,
      DEFAULT_AI_SUBAGENT_SETTINGS.maxDepth,
    ),
    maxConcurrent: clampInteger(
      record.maxConcurrent,
      AI_SUBAGENT_MIN_CONCURRENT,
      AI_SUBAGENT_MAX_CONCURRENT,
      DEFAULT_AI_SUBAGENT_SETTINGS.maxConcurrent,
    ),
    providers: {
      claude: typeof providers.claude === "boolean" ? providers.claude : DEFAULT_AI_SUBAGENT_SETTINGS.providers.claude,
      chatgpt: typeof providers.chatgpt === "boolean" ? providers.chatgpt : DEFAULT_AI_SUBAGENT_SETTINGS.providers.chatgpt,
      antigravity: typeof providers.antigravity === "boolean"
        ? providers.antigravity
        : DEFAULT_AI_SUBAGENT_SETTINGS.providers.antigravity,
      sigma: typeof providers.sigma === "boolean" ? providers.sigma : DEFAULT_AI_SUBAGENT_SETTINGS.providers.sigma,
    },
  };
}

export function areAiSubagentSettingsEqual(a: AiSubagentSettings, b: AiSubagentSettings): boolean {
  return a.enabled === b.enabled
    && a.maxDepth === b.maxDepth
    && a.maxConcurrent === b.maxConcurrent
    && AI_SUBAGENT_PROVIDERS.every((provider) => a.providers[provider] === b.providers[provider]);
}

/** 1つのAIの、この実行での扱い。無効のときも上限は持たせる (プロンプトと起動引数が同じ形で読む)。 */
export interface AiSubagentPolicy {
  enabled: boolean;
  maxDepth: number;
  maxConcurrent: number;
}

export const DISABLED_AI_SUBAGENT_POLICY: AiSubagentPolicy = {
  enabled: false,
  maxDepth: AI_SUBAGENT_MIN_DEPTH,
  maxConcurrent: AI_SUBAGENT_MIN_CONCURRENT,
};

function isAiSubagentProvider(provider: string): provider is AiSubagentProvider {
  return (AI_SUBAGENT_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * 設定から、指定したAIの扱いを決める。知らないAIは常に無効。
 * `provider` は ai-edit:run の値 ("claude" | "chatgpt" | "antigravity" | "sigma") をそのまま渡す。
 */
export function resolveAiSubagentPolicy(settings: AiSubagentSettings, provider: string): AiSubagentPolicy {
  if (!isAiSubagentProvider(provider)) {
    return DISABLED_AI_SUBAGENT_POLICY;
  }
  return {
    enabled: settings.enabled && settings.providers[provider],
    maxDepth: settings.maxDepth,
    maxConcurrent: settings.maxConcurrent,
  };
}

export function areAiSubagentPoliciesEqual(a: AiSubagentPolicy, b: AiSubagentPolicy): boolean {
  return a.enabled === b.enabled && a.maxDepth === b.maxDepth && a.maxConcurrent === b.maxConcurrent;
}

/**
 * 上限をそのAIのCLIが強制するか、指示として伝えるだけか。設定画面の注記と文書が読む。
 * 実機で確かめた内容は docs/mcp-local-app.md の「サブエージェント」。
 */
export type AiSubagentEnforcement = "cli" | "instruction";

export const AI_SUBAGENT_ENFORCEMENT: Record<AiSubagentProvider, {
  toggle: AiSubagentEnforcement;
  maxDepth: AiSubagentEnforcement;
  maxConcurrent: AiSubagentEnforcement;
}> = {
  claude: { toggle: "cli", maxDepth: "cli", maxConcurrent: "cli" },
  // Codex の深さ (agents.max_depth) は従来方式のサブエージェントだけが読む。現行の方式は
  // 無視するので、深さは指示としても伝える。
  chatgpt: { toggle: "cli", maxDepth: "instruction", maxConcurrent: "cli" },
  // Antigravity CLI には対応する設定が無い (権限ルールでも止められない)。
  antigravity: { toggle: "instruction", maxDepth: "instruction", maxConcurrent: "instruction" },
  // 内蔵AI (dsh) は、道具の有無・深さ (maxDepth)・同時に動かす数 (maxActiveSubagents) を実行環境が強制する。
  sigma: { toggle: "cli", maxDepth: "cli", maxConcurrent: "cli" },
};
