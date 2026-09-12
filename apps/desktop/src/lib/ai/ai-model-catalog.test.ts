import { describe, expect, it } from "vitest";

import {
  cycleReasoningEffort,
  formatReasoningEffortLabel,
  getModelReasoningEfforts,
  getProviderReasoningEfforts,
  resolveAiModelOptions,
  resolveCatalogSelection,
} from "@/lib/ai/ai-model-catalog";

describe("ai-model-catalog", () => {
  it("keeps Fable selectable with no catalog or an older CLI alias list", () => {
    for (const catalog of [null, { models: [{ id: "sonnet", label: "Sonnet", isDefault: true }] }]) {
      const models = resolveAiModelOptions("claude", catalog);
      expect(models).toContainEqual(expect.objectContaining({ id: "claude-fable-5-1", label: "Claude Fable 5.1" }));
      expect(resolveCatalogSelection({ models, model: "claude-fable-5-1", reasoningEffort: "high" }).model)
        .toBe("claude-fable-5-1");
      expect(models.find((model) => model.isDefault)?.id).toBe("sonnet");
    }
  });

  it("preserves the runtime Fable option without adding a duplicate", () => {
    const models = resolveAiModelOptions("claude", { models: [{ id: "fable", label: "Fable (latest)" }] });
    expect(models.map((model) => model.id)).toEqual(["fable"]);
  });

  it("always renders explicit effort labels, including unknown and missing values", () => {
    expect(formatReasoningEffortLabel("low")).toBe("低");
    expect(formatReasoningEffortLabel("xhigh")).toBe("最高");
    expect(formatReasoningEffortLabel("future-effort")).toBe("future-effort");
    expect(formatReasoningEffortLabel(" ")).toBe("未設定");
  });

  it("prefers runtime models and preserves newly advertised effort values", () => {
    const models = resolveAiModelOptions("chatgpt", {
      models: [{
        id: "gpt-future",
        label: "GPT Future",
        isDefault: true,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [{ id: "none" }, { id: "max" }],
      }],
    });

    expect(models.map((model) => model.id)).toEqual(["gpt-future"]);
    expect(getModelReasoningEfforts(models, "gpt-future")).toEqual(["none", "max"]);
    expect(resolveCatalogSelection({ models, model: "retired-model", reasoningEffort: "xhigh" }))
      .toEqual({ model: "gpt-future", reasoningEffort: "max" });
  });

  it("falls back to built-in candidates when a runtime cannot return a catalog", () => {
    expect(resolveAiModelOptions("chatgpt", null).length).toBeGreaterThan(0);
    expect(resolveAiModelOptions("claude", { models: [] }).length).toBeGreaterThan(0);
    expect(resolveAiModelOptions("antigravity", undefined).length).toBeGreaterThan(0);
  });

  it("offers effort choices for Claude/Sonnet but not Antigravity models", () => {
    const claudeModels = resolveAiModelOptions("claude", null);
    expect(getProviderReasoningEfforts("claude", claudeModels, "sonnet"))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getProviderReasoningEfforts("antigravity", resolveAiModelOptions("antigravity", null), "Gemini 3.5 Flash (Low)"))
      .toEqual([]);
  });

  it("keeps an explicitly empty runtime effort list unsupported", () => {
    const models = resolveAiModelOptions("chatgpt", {
      models: [{ id: "gpt-no-reasoning", label: "GPT No Reasoning", supportedReasoningEfforts: [] }],
    });

    expect(getModelReasoningEfforts(models, "gpt-no-reasoning")).toEqual([]);
    expect(getProviderReasoningEfforts("chatgpt", models, "gpt-no-reasoning")).toEqual([]);
  });

  it("normalizes a restored effort against the selected runtime model", () => {
    const models = resolveAiModelOptions("claude", {
      models: [{
        id: "claude-narrow-effort",
        label: "Claude Narrow Effort",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ id: "low" }, { id: "medium" }],
      }],
    });

    expect(resolveCatalogSelection({
      models,
      model: "claude-narrow-effort",
      reasoningEffort: "xhigh",
    })).toEqual({ model: "claude-narrow-effort", reasoningEffort: "low" });
  });

  it("cycles reasoning effort in both directions and wraps at the ends", () => {
    const efforts = ["low", "medium", "high"];
    expect(cycleReasoningEffort(efforts, "low", 1)).toBe("medium");
    expect(cycleReasoningEffort(efforts, "low", -1)).toBe("high");
    expect(cycleReasoningEffort(efforts, "high", 1)).toBe("low");
  });
});
