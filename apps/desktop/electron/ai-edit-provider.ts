// ai-edit:run payload から実行プロバイダを解決する純関数。electron非依存なので単体テスト可能
// (main.ts はモジュールスコープでElectron appを触るため直接importしてのテストができない)。

export type AiEditProvider = "claude" | "chatgpt" | "antigravity";

export function resolveAiEditProvider(payload: unknown): AiEditProvider {
  if (typeof payload !== "object" || payload === null) {
    return "chatgpt";
  }
  const provider = (payload as { provider?: unknown }).provider;
  if (provider === "claude" || provider === "antigravity") {
    return provider;
  }
  return "chatgpt";
}
