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

export const CLAUDE_AI_EDIT_MODELS = [
  "sonnet",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export type ClaudeAiEditModel = (typeof CLAUDE_AI_EDIT_MODELS)[number] | (string & {});

// Claude Code's `sonnet` alias follows the latest Sonnet release. It currently
// resolves to Claude Sonnet 5 and avoids freezing a dated fallback in the UI.
export const DEFAULT_CLAUDE_AI_EDIT_MODEL: ClaudeAiEditModel = "sonnet";

export const CLAUDE_MODEL_LABELS: Record<string, string> = {
  sonnet: "Claude Sonnet 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
};

export function claudeModelLabel(model: string): string {
  return CLAUDE_MODEL_LABELS[model] ?? model;
}

export const GEMINI_AI_EDIT_MODELS = [
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (High)",
  "Gemini 3.1 Pro (Low)",
] as const;

export type GeminiAiEditModel = (typeof GEMINI_AI_EDIT_MODELS)[number] | (string & {});

export const DEFAULT_GEMINI_AI_EDIT_MODEL: GeminiAiEditModel = "Gemini 3.5 Flash (High)";

export const GEMINI_MODEL_LABELS: Record<string, string> = {
  "Gemini 3.5 Flash (High)": "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Medium)": "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (Low)": "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (High)": "Gemini 3.1 Pro (High)",
  "Gemini 3.1 Pro (Low)": "Gemini 3.1 Pro (Low)",
};

export function geminiModelLabel(model: string): string {
  return GEMINI_MODEL_LABELS[model] ?? model;
}
