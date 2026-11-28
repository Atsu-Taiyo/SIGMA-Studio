import { afterEach, describe, expect, it } from "vitest";

import { setValidationLocale } from "@/lib/ai/validation-locale";
import { describeGatewayRefusal, formatUsageResetTime } from "./sigma-edit";

afterEach(() => setValidationLocale("ja"));

describe("what the chat says when the gateway refuses", () => {
  const resetsAt = "2026-12-05T03:14:00.000Z";

  it("names the day the allowance comes back, in the reader's language", () => {
    setValidationLocale("ja");
    const ja = describeGatewayRefusal({ status: 402, code: "USAGE_LIMIT_REACHED", resetsAt }, "ja")!;
    expect(ja).toBe(`今週の SIGMA AI の利用枠を使い切りました。${formatUsageResetTime(resetsAt, "ja")} にリセットされます。ご自身の Claude・ChatGPT・Antigravity は続けて使えます。`);
    expect(formatUsageResetTime(resetsAt, "ja")).toMatch(/^12月\d+日\(.\) \d+:\d{2}$/u);

    setValidationLocale("en");
    const en = describeGatewayRefusal({ status: 402, code: "USAGE_LIMIT_REACHED", resetsAt }, "en")!;
    expect(en).toContain(`It resets on ${formatUsageResetTime(resetsAt, "en")}.`);
    // 埋め残しの記号を見せない。
    for (const text of [ja, en]) expect(text).not.toMatch(/[{}]/u);
  });

  it("still explains the limit when the gateway gives no reset time", () => {
    setValidationLocale("ja");
    expect(describeGatewayRefusal({ status: 402, code: "USAGE_LIMIT_REACHED", resetsAt: null }, "ja"))
      .toBe("今週の SIGMA AI の利用枠を使い切りました。ご自身の Claude・ChatGPT・Antigravity は続けて使えます。");
    expect(describeGatewayRefusal({ status: 402, code: "USAGE_LIMIT_REACHED", resetsAt: "not a date" }, "ja")).not.toMatch(/Invalid|NaN/u);
  });

  it("tells a plan, a burst and a sign-in problem apart, and leaves anything else to the agent's own message", () => {
    setValidationLocale("ja");
    expect(describeGatewayRefusal({ status: 403, code: "PRO_REQUIRED", resetsAt: null }, "ja")).toContain("Pro プラン");
    expect(describeGatewayRefusal({ status: 429, code: "RATE_LIMITED", resetsAt: null }, "ja")).toContain("1 分ほど待って");
    expect(describeGatewayRefusal({ status: 401, code: "UNAUTHORIZED", resetsAt: null }, "ja")).toContain("拒否されました");
    // 上流 (OpenRouter) の残高不足も 402 だが、利用者の利用枠ではない。
    expect(describeGatewayRefusal({ status: 402, code: null, resetsAt: null }, "ja")).toBeNull();
    expect(describeGatewayRefusal({ status: 502, code: "UPSTREAM_UNREACHABLE", resetsAt: null }, "ja")).toBeNull();
    expect(describeGatewayRefusal(undefined, "ja")).toBeNull();
  });
});
