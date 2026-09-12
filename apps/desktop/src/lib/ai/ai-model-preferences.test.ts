import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAiModelPreferences,
  saveAiModelPreferences,
  type AiModelPreferences,
} from "@/lib/ai/ai-model-preferences";
import { DEFAULT_AI_EDIT_MODEL, DEFAULT_AI_EDIT_REASONING_EFFORT } from "@/lib/ai/sigma-doc-edit-schema";
import { DEFAULT_CLAUDE_AI_EDIT_MODEL, DEFAULT_GEMINI_AI_EDIT_MODEL } from "@/lib/ai/ai-providers";

describe("ai-model-preferences", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          clear: () => storage.clear(),
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("returns defaults when nothing is stored", () => {
    expect(getAiModelPreferences()).toEqual({
      provider: "chatgpt",
      model: DEFAULT_AI_EDIT_MODEL,
      claudeModel: DEFAULT_CLAUDE_AI_EDIT_MODEL,
      geminiModel: DEFAULT_GEMINI_AI_EDIT_MODEL,
      reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
    });
  });

  it("persists and restores the last used provider and models", () => {
    const preferences: AiModelPreferences = {
      provider: "claude",
      model: "gpt-5.4-mini",
      claudeModel: "claude-opus-4-8",
      geminiModel: "Gemini 3.5 Flash (Medium)",
      reasoningEffort: "high",
    };
    saveAiModelPreferences(preferences);
    expect(getAiModelPreferences()).toEqual(preferences);
  });

  it("falls back to defaults for invalid stored values", () => {
    window.localStorage.setItem("sigma-studio:ai-edit-model-preferences", JSON.stringify({
      provider: "unknown",
      model: "",
      claudeModel: " ",
      geminiModel: "",
      reasoningEffort: " ",
    }));
    expect(getAiModelPreferences()).toEqual({
      provider: "chatgpt",
      model: DEFAULT_AI_EDIT_MODEL,
      claudeModel: DEFAULT_CLAUDE_AI_EDIT_MODEL,
      geminiModel: DEFAULT_GEMINI_AI_EDIT_MODEL,
      reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
    });
  });

  it("restores runtime-discovered model and effort values that were not known at build time", () => {
    window.localStorage.setItem("sigma-studio:ai-edit-model-preferences", JSON.stringify({
      provider: "chatgpt",
      model: "gpt-future-runtime",
      claudeModel: "fable",
      geminiModel: "Gemini Future",
      reasoningEffort: "max",
    }));

    expect(getAiModelPreferences()).toMatchObject({
      model: "gpt-future-runtime",
      claudeModel: "fable",
      geminiModel: "Gemini Future",
      reasoningEffort: "max",
    });
  });

  it("accepts gemini as a valid provider", () => {
    const preferences: AiModelPreferences = {
      provider: "antigravity",
      model: DEFAULT_AI_EDIT_MODEL,
      claudeModel: DEFAULT_CLAUDE_AI_EDIT_MODEL,
      geminiModel: DEFAULT_GEMINI_AI_EDIT_MODEL,
      reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
    };
    saveAiModelPreferences(preferences);
    expect(getAiModelPreferences()).toEqual(preferences);
  });
});
