import { describe, expect, it } from "vitest";

import { AUTO_APPLY_DEFER_MS, shouldDeferAutoApply } from "./auto-apply-defer";

describe("shouldDeferAutoApply", () => {
  it("does not defer when there is no recorded renderer save", () => {
    expect(shouldDeferAutoApply(undefined, 10_000)).toBe(false);
  });

  it("defers immediately after a renderer save", () => {
    expect(shouldDeferAutoApply(1_000, 1_000)).toBe(true);
  });

  it("defers while still within the threshold", () => {
    expect(shouldDeferAutoApply(1_000, 1_000 + AUTO_APPLY_DEFER_MS - 1)).toBe(true);
  });

  it("stops deferring once the threshold has fully elapsed", () => {
    expect(shouldDeferAutoApply(1_000, 1_000 + AUTO_APPLY_DEFER_MS)).toBe(false);
  });

  it("stops deferring well after the threshold", () => {
    expect(shouldDeferAutoApply(1_000, 1_000 + AUTO_APPLY_DEFER_MS + 5_000)).toBe(false);
  });

  it("keeps deferring across repeated renderer saves (simulated continuous typing)", () => {
    // 450msデバウンスの自動保存が繰り返され、そのたびに lastRendererSaveAt が更新される想定。
    let lastRendererSaveAt = 0;
    for (let elapsed = 0; elapsed < 5_000; elapsed += 450) {
      lastRendererSaveAt = elapsed;
      expect(shouldDeferAutoApply(lastRendererSaveAt, elapsed)).toBe(true);
    }
  });
});
