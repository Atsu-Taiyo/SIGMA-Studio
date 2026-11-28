import { describe, expect, it } from "vitest";

import {
  chatCompletionContextUsage,
  claudeContextUsage,
  claudeUsageFromRateLimitInfo,
  codexContextUsage,
  codexUsageFromRateLimits,
  contextUsageRatio,
  dropExpiredUsageWindows,
  emptyAiUsageSnapshot,
  formatTokenCount,
  parseAiContextUsage,
  parseAiUsageSnapshot,
  sigmaUsageFromGateway,
  usageLevel,
  usagePercent,
} from "./ai-usage";

const NOW = Date.UTC(2026, 10, 28, 5, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("Claude usage limits", () => {
  // Claude Code 2.1.332 の stream-json が実際に出した `rate_limit_event.rate_limit_info`。
  const observed = {
    status: "allowed", resetsAt: 1796371200, rateLimitType: "seven_day", overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled", isUsingOverage: false,
    unifiedWindows: { seven_day: { utilization: 0.07, resetsAt: 1796371200, status: "allowed" } },
  };

  it("reads the windows a real rate_limit_event carries", () => {
    expect(claudeUsageFromRateLimitInfo(observed, null, NOW)).toEqual({
      provider: "claude", state: "available", plan: null, limitReached: false, observedAt: NOW,
      windows: [{ kind: "weekly", usedRatio: 0.07, resetsAt: 1796371200_000, windowMinutes: 10080 }],
    });
  });

  it("keeps a window the next event does not mention, and replaces the one it does", () => {
    const first = claudeUsageFromRateLimitInfo({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.4, resetsAt: NOW / 1000 + 3600 },
        seven_day: { utilization: 0.1, resetsAt: NOW / 1000 + 86400 },
        seven_day_opus: { utilization: 0.9, resetsAt: NOW / 1000 + 86400 },
      },
    }, null, NOW)!;
    expect(first.windows.map(window => [window.kind, window.model])).toEqual([["session", undefined], ["weekly", undefined], ["weeklyModel", "opus"]]);
    const next = claudeUsageFromRateLimitInfo({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: NOW / 1000 + 3600 } } }, first, NOW + 1000)!;
    expect(next.windows.map(window => window.usedRatio)).toEqual([0.5, 0.1, 0.9]);
    // 覚えていた窓も、リセットの時刻を過ぎたら持ち越さない。
    const later = claudeUsageFromRateLimitInfo({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: NOW / 1000 + 86400 } } }, first, NOW + 2 * 3600_000)!;
    expect(later.windows.map(window => window.kind)).toEqual(["weekly", "weeklyModel"]);
  });

  it("treats a rejected window as used up even without a utilization", () => {
    const usage = claudeUsageFromRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", resetsAt: NOW / 1000 + 600, isUsingOverage: false }, null, NOW)!;
    expect(usage.limitReached).toBe(true);
    expect(usage.windows).toEqual([{ kind: "session", usedRatio: 1, resetsAt: NOW + 600_000, windowMinutes: 300 }]);
    // 追加の利用分で続いている間は、止められていない。
    expect(claudeUsageFromRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", utilization: 1, isUsingOverage: true }, null, NOW)!.limitReached).toBe(false);
  });

  it("ignores an event with nothing usable", () => {
    expect(claudeUsageFromRateLimitInfo({ status: "allowed", rateLimitType: "seven_day" }, null, NOW)).toBeNull();
    expect(claudeUsageFromRateLimitInfo(null, null, NOW)).toBeNull();
    expect(claudeUsageFromRateLimitInfo({ status: "allowed", unifiedWindows: { mystery: { utilization: 0.5 } } }, null, NOW)).toBeNull();
  });
});

describe("ChatGPT usage limits", () => {
  // codex app-server 0.172 の `account/rateLimits/read` の `rateLimits` (generate-ts の RateLimitSnapshot)。
  const snapshot = {
    limitId: "codex", limitName: null, normalModelSlug: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 },
    secondary: { usedPercent: 8.5, windowDurationMins: 10080, resetsAt: NOW / 1000 + 5 * 86400 },
    credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null,
  };

  it("maps the primary and secondary windows by their length", () => {
    expect(codexUsageFromRateLimits(snapshot, NOW)).toEqual({
      provider: "chatgpt", state: "available", plan: "plus", limitReached: false, observedAt: NOW,
      windows: [
        { kind: "session", usedRatio: 0.42, resetsAt: NOW + 3600_000, windowMinutes: 300 },
        { kind: "weekly", usedRatio: 0.085, resetsAt: NOW + 5 * 86400_000, windowMinutes: 10080 },
      ],
    });
  });

  it("reads a real account whose only window is the weekly one", () => {
    // codex app-server 0.172 が実際に返した値 (プランによっては primary が 1 週間の窓で、secondary は無い)。
    const observed = {
      limitId: "codex", primary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1795899674 },
      secondary: null, planType: "self_serve_business_prolite", rateLimitReachedType: null,
    };
    expect(codexUsageFromRateLimits(observed, NOW)).toMatchObject({
      state: "available", plan: "self_serve_business_prolite", limitReached: false,
      windows: [{ kind: "weekly", usedRatio: 0.34, resetsAt: 1795899674_000, windowMinutes: 10080 }],
    });
  });

  it("merges a sparse update into what it already knew", () => {
    const known = codexUsageFromRateLimits(snapshot, NOW)!;
    const update = codexUsageFromRateLimits({ primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 }, secondary: null, planType: null }, NOW + 1, known)!;
    expect(update.plan).toBe("plus");
    expect(update.windows.map(window => [window.kind, window.usedRatio])).toEqual([["session", 0.6], ["weekly", 0.085]]);
  });

  it("reports a reached limit, and nothing when there are no windows", () => {
    expect(codexUsageFromRateLimits({ ...snapshot, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null } }, NOW)!.limitReached).toBe(true);
    expect(codexUsageFromRateLimits({ ...snapshot, rateLimitReachedType: "primary" }, NOW)!.limitReached).toBe(true);
    expect(codexUsageFromRateLimits({ primary: null, secondary: null }, NOW)).toBeNull();
    expect(codexUsageFromRateLimits(null, NOW)).toBeNull();
  });
});

describe("SIGMA AI allowance", () => {
  it("reads the gateway's weekly share and reset time", () => {
    expect(sigmaUsageFromGateway({ plan: "pro", included: true, weekly: { usedRatio: 0.2167, resetsAt: "2026-12-05T03:14:00.000Z", reached: false } }, NOW)).toEqual({
      provider: "sigma", state: "available", plan: "pro", limitReached: false, observedAt: NOW,
      windows: [{ kind: "weekly", usedRatio: 0.2167, resetsAt: Date.parse("2026-12-05T03:14:00.000Z"), windowMinutes: 10080 }],
    });
    // まだ使っていない週には、リセットの時刻が無い。
    expect(sigmaUsageFromGateway({ plan: "trial", included: true, weekly: { usedRatio: 0, resetsAt: null, reached: false } }, NOW)!.windows[0]).toMatchObject({ usedRatio: 0, resetsAt: null });
    expect(sigmaUsageFromGateway({ plan: "pro", included: true, weekly: { usedRatio: 1, resetsAt: "2026-12-05T03:14:00.000Z", reached: true } }, NOW)!.limitReached).toBe(true);
  });

  it("separates a plan without the allowance from an unreadable answer", () => {
    expect(sigmaUsageFromGateway({ plan: "free", included: false, weekly: null }, NOW)).toMatchObject({ state: "notIncluded", plan: "free", windows: [] });
    expect(sigmaUsageFromGateway({ plan: "pro", included: true, weekly: null }, NOW)).toBeNull();
    expect(sigmaUsageFromGateway({ object: "list" }, NOW)).toBeNull();
  });
});

describe("context usage", () => {
  it("adds up what a Claude response read and wrote", () => {
    // Claude Code の `assistant` メッセージが実際に出した usage。
    const usage = { input_tokens: 2, cache_creation_input_tokens: 3502, cache_read_input_tokens: 649, output_tokens: 4, service_tier: "standard" };
    expect(claudeContextUsage(usage, 1_000_000)).toEqual({ usedTokens: 4157, windowTokens: 1_000_000 });
    expect(claudeContextUsage(usage, null)).toEqual({ usedTokens: 4157, windowTokens: null });
    expect(claudeContextUsage({}, 1000)).toBeNull();
  });

  it("uses the latest response of a Codex thread, not the running total", () => {
    const tokenUsage = {
      total: { totalTokens: 90_000, inputTokens: 80_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10_000, reasoningOutputTokens: 0 },
      last: { totalTokens: 31_000, inputTokens: 30_000, cachedInputTokens: 20_000, cacheWriteInputTokens: 0, outputTokens: 1_000, reasoningOutputTokens: 200 },
      modelContextWindow: 272_000,
    };
    expect(codexContextUsage(tokenUsage)).toEqual({ usedTokens: 31_000, windowTokens: 272_000 });
    expect(codexContextUsage({ ...tokenUsage, modelContextWindow: null })).toEqual({ usedTokens: 31_000, windowTokens: null });
    expect(codexContextUsage({ total: tokenUsage.total })).toBeNull();
  });

  it("reads an OpenAI-compatible usage object", () => {
    expect(chatCompletionContextUsage({ prompt_tokens: 78_000, completion_tokens: 400, cost: 0.004 }, 1_048_576)).toEqual({ usedTokens: 78_400, windowTokens: 1_048_576 });
    expect(chatCompletionContextUsage({ cost: 0.1 }, 1000)).toBeNull();
  });

  it("gives a ratio only when the window is known", () => {
    expect(contextUsageRatio({ usedTokens: 250, windowTokens: 1000 })).toBe(0.25);
    expect(contextUsageRatio({ usedTokens: 5000, windowTokens: 1000 })).toBe(1);
    expect(contextUsageRatio({ usedTokens: 250, windowTokens: null })).toBeNull();
    expect(contextUsageRatio(null)).toBeNull();
  });

  it("drops a stored value that is not a usage", () => {
    expect(parseAiContextUsage({ usedTokens: 12.6, windowTokens: 100 })).toEqual({ usedTokens: 13, windowTokens: 100 });
    expect(parseAiContextUsage({ usedTokens: 0, windowTokens: 100 })).toBeNull();
    expect(parseAiContextUsage("12")).toBeNull();
  });
});

describe("stored snapshots", () => {
  it("starts with nothing known, and with Antigravity marked as not reporting", () => {
    const empty = emptyAiUsageSnapshot();
    expect(empty.claude.state).toBe("unknown");
    expect(empty.antigravity.state).toBe("unsupported");
    expect(parseAiUsageSnapshot(null)).toEqual(empty);
    expect(parseAiUsageSnapshot({ claude: { state: "available", windows: [] } }).claude.state).toBe("unknown");
  });

  it("round-trips a snapshot and rejects malformed windows", () => {
    const usage = sigmaUsageFromGateway({ plan: "pro", included: true, weekly: { usedRatio: 0.5, resetsAt: "2026-12-05T03:14:00.000Z", reached: false } }, NOW)!;
    const stored = JSON.parse(JSON.stringify({ ...emptyAiUsageSnapshot(), sigma: usage }));
    expect(parseAiUsageSnapshot(stored).sigma).toEqual(usage);
    expect(parseAiUsageSnapshot({ sigma: { state: "available", windows: [{ kind: "monthly", usedRatio: 0.5 }, { kind: "weekly", usedRatio: "x" }] } }).sigma.state).toBe("unknown");
  });

  it("stops showing a remembered window once its reset time has passed", () => {
    const usage = sigmaUsageFromGateway({ plan: "pro", included: true, weekly: { usedRatio: 1, resetsAt: new Date(NOW + 1000).toISOString(), reached: true } }, NOW)!;
    expect(dropExpiredUsageWindows(usage, NOW)).toBe(usage);
    expect(dropExpiredUsageWindows(usage, NOW + WEEK_MS)).toMatchObject({ state: "unknown", windows: [], limitReached: false });
  });
});

describe("display helpers", () => {
  it("never shows used allowance as 0%", () => {
    expect(usagePercent(0)).toBe(0);
    expect(usagePercent(0.001)).toBe(1);
    expect(usagePercent(0.426)).toBe(43);
    expect(usagePercent(1.3)).toBe(100);
  });

  it("warns in the last fifth and stops at the limit", () => {
    expect([0, 0.79, 0.8, 0.99, 1].map(usageLevel)).toEqual(["normal", "normal", "warning", "warning", "reached"]);
  });

  it("shortens token counts", () => {
    expect([950, 1234, 78_400, 272_000, 1_048_576].map(formatTokenCount)).toEqual(["950", "1.2K", "78.4K", "272K", "1M"]);
  });
});
