import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import { formatUsagePlanName, formatUsageResetTime, formatUsageWindowLabel } from "./ai-usage-format";

const ja = createTranslator("ja", "ai");
const en = createTranslator("en", "ai");

describe("usage labels", () => {
  it("names a window by its length, without guessing a length the AI did not give", () => {
    expect(formatUsageWindowLabel({ kind: "session", usedRatio: 0, resetsAt: null, windowMinutes: 300 }, ja)).toBe("5時間");
    expect(formatUsageWindowLabel({ kind: "session", usedRatio: 0, resetsAt: null, windowMinutes: 1440 }, ja)).toBe("1日間");
    expect(formatUsageWindowLabel({ kind: "session", usedRatio: 0, resetsAt: null }, ja)).toBe("短い時間の枠");
    expect(formatUsageWindowLabel({ kind: "weekly", usedRatio: 0, resetsAt: null, windowMinutes: 10080 }, ja)).toBe("1週間");
    expect(formatUsageWindowLabel({ kind: "weeklyModel", usedRatio: 0, resetsAt: null, model: "opus" }, ja)).toBe("1週間 (opus)");
    expect(formatUsageWindowLabel({ kind: "session", usedRatio: 0, resetsAt: null, windowMinutes: 300 }, en)).toBe("5-hour");
  });

  it("shows plan ids readably, and SIGMA AI's free and trial plans in words", () => {
    expect(formatUsagePlanName({ provider: "sigma", plan: "pro" }, ja)).toBe("Pro");
    expect(formatUsagePlanName({ provider: "sigma", plan: "trial" }, ja)).toBe("Pro (試用期間)");
    expect(formatUsagePlanName({ provider: "sigma", plan: "free" }, en)).toBe("Free");
    // まだ無い上位プランも、名前のまま出せる。
    expect(formatUsagePlanName({ provider: "sigma", plan: "max" }, ja)).toBe("Max");
    expect(formatUsagePlanName({ provider: "chatgpt", plan: "self_serve_business_prolite" }, ja)).toBe("Self serve business prolite");
    expect(formatUsagePlanName({ provider: "claude", plan: null }, ja)).toBeNull();
  });

  it("writes the reset time in the reader's language", () => {
    const at = Date.UTC(2026, 11, 5, 3, 14);
    expect(formatUsageResetTime(at, "ja")).toMatch(/^12\/\d+\(.\) \d+:14$/u);
    expect(formatUsageResetTime(at, "en")).toMatch(/^[A-Z][a-z]{2}, 12\/\d+, \d+:14\s?[AP]M$/u);
  });
});
