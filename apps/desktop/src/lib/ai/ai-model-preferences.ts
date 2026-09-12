import {
  DEFAULT_AI_EDIT_MODEL,
  DEFAULT_AI_EDIT_REASONING_EFFORT,
  type AiEditModel,
  type AiEditReasoningEffort,
} from "@/lib/ai/sigma-doc-edit-schema";
import {
  DEFAULT_CLAUDE_AI_EDIT_MODEL,
  DEFAULT_GEMINI_AI_EDIT_MODEL,
  type AiProvider,
} from "@/lib/ai/ai-providers";

const STORAGE_KEY = "sigma-studio:ai-edit-model-preferences";

export interface AiModelPreferences {
  provider: AiProvider;
  model: AiEditModel;
  claudeModel: string;
  geminiModel: string;
  reasoningEffort: AiEditReasoningEffort;
}

const DEFAULT_PREFERENCES: AiModelPreferences = {
  provider: "chatgpt",
  model: DEFAULT_AI_EDIT_MODEL,
  claudeModel: DEFAULT_CLAUDE_AI_EDIT_MODEL,
  geminiModel: DEFAULT_GEMINI_AI_EDIT_MODEL,
  reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
};

function isAiProvider(value: unknown): value is AiProvider {
  return value === "chatgpt" || value === "claude" || value === "antigravity";
}

function isAiEditModel(value: unknown): value is AiEditModel {
  return typeof value === "string" && value.trim().length > 0;
}

function isClaudeModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isGeminiModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReasoningEffort(value: unknown): value is AiEditReasoningEffort {
  return typeof value === "string" && value.trim().length > 0;
}

export function getAiModelPreferences(): AiModelPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFERENCES;
    }
    const parsed = JSON.parse(raw) as Partial<AiModelPreferences>;
    return {
      provider: isAiProvider(parsed.provider) ? parsed.provider : DEFAULT_PREFERENCES.provider,
      model: isAiEditModel(parsed.model) ? parsed.model : DEFAULT_PREFERENCES.model,
      claudeModel: isClaudeModel(parsed.claudeModel) ? parsed.claudeModel : DEFAULT_PREFERENCES.claudeModel,
      geminiModel: isGeminiModel(parsed.geminiModel) ? parsed.geminiModel : DEFAULT_PREFERENCES.geminiModel,
      reasoningEffort: isReasoningEffort(parsed.reasoningEffort)
        ? parsed.reasoningEffort
        : DEFAULT_PREFERENCES.reasoningEffort,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveAiModelPreferences(preferences: AiModelPreferences): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
