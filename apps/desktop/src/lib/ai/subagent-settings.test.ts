import { describe, expect, it } from "vitest";

import {
  AI_SUBAGENT_MAX_CONCURRENT,
  AI_SUBAGENT_MAX_DEPTH,
  areAiSubagentSettingsEqual,
  DEFAULT_AI_SUBAGENT_SETTINGS,
  DISABLED_AI_SUBAGENT_POLICY,
  normalizeAiSubagentSettings,
  resolveAiSubagentPolicy,
} from "./subagent-settings";

describe("normalizeAiSubagentSettings", () => {
  it("uses the defaults when nothing was saved", () => {
    expect(normalizeAiSubagentSettings(undefined)).toEqual(DEFAULT_AI_SUBAGENT_SETTINGS);
    expect(normalizeAiSubagentSettings("on")).toEqual(DEFAULT_AI_SUBAGENT_SETTINGS);
    expect(normalizeAiSubagentSettings([])).toEqual(DEFAULT_AI_SUBAGENT_SETTINGS);
  });

  it("starts with subagents on, no nesting, and a small number at once", () => {
    expect(DEFAULT_AI_SUBAGENT_SETTINGS).toEqual({
      enabled: true,
      maxDepth: 1,
      maxConcurrent: 3,
      providers: { claude: true, chatgpt: true, antigravity: true, sigma: false },
    });
  });

  it("keeps the saved values and fills only the missing ones", () => {
    expect(normalizeAiSubagentSettings({ enabled: false, maxDepth: 3, providers: { antigravity: false } })).toEqual({
      enabled: false,
      maxDepth: 3,
      maxConcurrent: DEFAULT_AI_SUBAGENT_SETTINGS.maxConcurrent,
      providers: { claude: true, chatgpt: true, antigravity: false, sigma: false },
    });
    expect(normalizeAiSubagentSettings({ providers: { sigma: true } }).providers).toEqual({
      claude: true, chatgpt: true, antigravity: true, sigma: true,
    });
  });

  it("clamps the depth and the count into their ranges and rounds fractions", () => {
    expect(normalizeAiSubagentSettings({ maxDepth: 0, maxConcurrent: 0 })).toMatchObject({ maxDepth: 1, maxConcurrent: 1 });
    expect(normalizeAiSubagentSettings({ maxDepth: 99, maxConcurrent: 99 })).toMatchObject({
      maxDepth: AI_SUBAGENT_MAX_DEPTH,
      maxConcurrent: AI_SUBAGENT_MAX_CONCURRENT,
    });
    expect(normalizeAiSubagentSettings({ maxDepth: 2.4, maxConcurrent: 3.6 })).toMatchObject({ maxDepth: 2, maxConcurrent: 4 });
  });

  it("falls back to the defaults for values of the wrong type", () => {
    expect(normalizeAiSubagentSettings({
      enabled: "yes",
      maxDepth: "2",
      maxConcurrent: Number.NaN,
      providers: { claude: 1, chatgpt: null },
    })).toEqual(DEFAULT_AI_SUBAGENT_SETTINGS);
  });
});

describe("areAiSubagentSettingsEqual", () => {
  it("compares every field, including the per-AI switches", () => {
    expect(areAiSubagentSettingsEqual(DEFAULT_AI_SUBAGENT_SETTINGS, normalizeAiSubagentSettings({}))).toBe(true);
    expect(areAiSubagentSettingsEqual(DEFAULT_AI_SUBAGENT_SETTINGS, normalizeAiSubagentSettings({ maxDepth: 2 }))).toBe(false);
    expect(areAiSubagentSettingsEqual(
      DEFAULT_AI_SUBAGENT_SETTINGS,
      normalizeAiSubagentSettings({ providers: { chatgpt: false } }),
    )).toBe(false);
  });
});

describe("resolveAiSubagentPolicy", () => {
  const settings = normalizeAiSubagentSettings({ maxDepth: 2, maxConcurrent: 5, providers: { antigravity: false } });

  it("gives each AI the shared limits and its own switch", () => {
    expect(resolveAiSubagentPolicy(settings, "claude")).toEqual({ enabled: true, maxDepth: 2, maxConcurrent: 5 });
    expect(resolveAiSubagentPolicy(settings, "chatgpt")).toEqual({ enabled: true, maxDepth: 2, maxConcurrent: 5 });
    expect(resolveAiSubagentPolicy(settings, "antigravity")).toEqual({ enabled: false, maxDepth: 2, maxConcurrent: 5 });
  });

  it("turns every AI off when the main switch is off", () => {
    const off = { ...settings, enabled: false };
    expect(resolveAiSubagentPolicy(off, "claude").enabled).toBe(false);
    expect(resolveAiSubagentPolicy(off, "chatgpt").enabled).toBe(false);
  });

  it("keeps the built-in AI off until its own switch is turned on", () => {
    // 内蔵AIの利用料は運営の負担なので、既定ではサブエージェントを使わせない。
    expect(resolveAiSubagentPolicy(settings, "sigma").enabled).toBe(false);
    const on = normalizeAiSubagentSettings({ maxDepth: 2, maxConcurrent: 5, providers: { sigma: true } });
    expect(resolveAiSubagentPolicy(on, "sigma")).toEqual({ enabled: true, maxDepth: 2, maxConcurrent: 5 });
    expect(resolveAiSubagentPolicy({ ...on, enabled: false }, "sigma").enabled).toBe(false);
  });

  it("never enables subagents for an unknown provider", () => {
    expect(resolveAiSubagentPolicy(settings, "something-else")).toEqual(DISABLED_AI_SUBAGENT_POLICY);
  });
});
