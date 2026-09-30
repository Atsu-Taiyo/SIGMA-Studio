// AIプロバイダ (ChatGPT=Codex / Claude=Claude Code / Antigravity=Antigravity CLI) とモデル定義。
// UI上の表示は ChatGPT / Claude / Antigravity。内部ランタイムは Codex app-server / claude stream-json / agy print。

import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

export type AiProvider = "chatgpt" | "claude" | "antigravity";

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  antigravity: "Antigravity",
};

/** Keeps provider identity visible even when a future or malformed id is restored. */
export function aiProviderLabel(provider: unknown): string {
  if (provider === "chatgpt" || provider === "claude" || provider === "antigravity") {
    return AI_PROVIDER_LABELS[provider];
  }
  const id = typeof provider === "string" ? provider.trim() : "";
  return id ? ta("provider.unknownWithId", { id }) : ta("provider.unknown");
}

/**
 * AiResourceStore / ai-resources IPC 側のプロバイダキー ("codex" | "claude" | "antigravity")。
 * UI表示用の AiProvider ("chatgpt" | "claude" | "antigravity") とは "chatgpt"/"codex" の
 * 命名が異なるため変換が必要。4箇所 (AiEditPanel.tsx x2, main.ts) で
 * `provider === "claude" || provider === "antigravity" ? provider : "codex"` が重複していたため
 * ここに集約する (Finding 5)。
 */
export type AiResourceProvider = "codex" | "claude" | "antigravity";

export function toAiResourceProvider(provider: AiProvider): AiResourceProvider {
  return provider === "claude" || provider === "antigravity" ? provider : "codex";
}

// Claude Codeが「常に最新を指す」別名。個別のバージョンはここに固定せず、実行時に
// インストール済みClaude Codeのモデル一覧から取得する (electron/claude-model-catalog.ts)。
// これは一覧を取得できないときの縮退用で、表示名にも数字を入れない。
export const CLAUDE_AI_EDIT_MODELS = ["sonnet", "opus", "fable", "haiku"] as const;

export type ClaudeAiEditModel = (typeof CLAUDE_AI_EDIT_MODELS)[number] | (string & {});

export const DEFAULT_CLAUDE_AI_EDIT_MODEL: ClaudeAiEditModel = "sonnet";

export const CLAUDE_MODEL_LABELS: Record<string, string> = {
  sonnet: "Claude Sonnet (latest)",
  opus: "Claude Opus (latest)",
  fable: "Claude Fable (latest)",
  haiku: "Claude Haiku (latest)",
};

export function claudeModelLabel(model: string): string {
  return CLAUDE_MODEL_LABELS[model] ?? model;
}

// Antigravity's account-specific catalog is supplied by the installed CLI.
// This sentinel is resolved at execution time and is never passed to --model.
export const GEMINI_AI_EDIT_MODELS = ["auto"] as const;
export type GeminiAiEditModel = string;
export const DEFAULT_GEMINI_AI_EDIT_MODEL: GeminiAiEditModel = "auto";

export function geminiModelLabel(model: string): string {
  return model === "auto" ? ta("model.runtimeDefault") : model;
}
