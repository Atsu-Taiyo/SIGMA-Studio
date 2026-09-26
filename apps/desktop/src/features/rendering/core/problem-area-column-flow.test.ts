import { describe, expect, it } from "vitest";

import {
  hasManualBreakInside,
  isProblemAreaFlowEligible,
} from ".";

describe("hasManualBreakInside", () => {
  it("is false when no block requests a manual break", () => {
    expect(hasManualBreakInside([
      { pagination: undefined },
      { pagination: { break: false } },
    ])).toBe(false);
  });

  it("is false when only the first block carries break (nothing to break away from)", () => {
    expect(hasManualBreakInside([
      { pagination: { break: true } },
      { pagination: undefined },
    ])).toBe(false);
  });

  it("is true when a block other than the first carries break: always", () => {
    expect(hasManualBreakInside([
      { pagination: undefined },
      { pagination: { break: true } },
    ])).toBe(true);
  });
});

describe("isProblemAreaFlowEligible", () => {
  it("is always eligible for an ordinary (non-atomic) area", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: false,
      blocks: [{ pagination: undefined }],
    })).toBe(true);
  });

  it("keeps a framed area atomic when it has no manual break inside", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: true,
      blocks: [
        { pagination: undefined },
        { pagination: undefined },
      ],
    })).toBe(false);
  });

  it("flows measured framed areas even when they fit a complete segment", () => {
    const input = {
      isFullSpan: false,
      isFramedArea: true,
      blocks: [{ pagination: undefined }],
      segmentHeightPx: 1_000,
    };
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_000 })).toBe(true);
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_001 })).toBe(true);
  });

  it("keeps a full-span area atomic at exactly one segment and flows it at +1px", () => {
    const input = {
      isFullSpan: true,
      isFramedArea: false,
      blocks: [{ pagination: undefined }],
      segmentHeightPx: 1_000,
    };
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_000 })).toBe(false);
    expect(isProblemAreaFlowEligible({ ...input, gapFreeHeightPx: 1_001 })).toBe(true);
  });

  it("keeps a full-span area atomic when it has no manual break inside", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: true,
      isFramedArea: false,
      blocks: [
        { pagination: undefined },
        { pagination: undefined },
      ],
    })).toBe(false);
  });

  it("makes a framed area flowable once a manual break is placed inside it", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: true,
      blocks: [
        { pagination: undefined },
        { pagination: { break: true } },
      ],
    })).toBe(true);
  });

  it("makes a full-span area flowable once a manual break is placed inside it", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: true,
      isFramedArea: false,
      blocks: [
        { pagination: undefined },
        { pagination: { break: true } },
      ],
    })).toBe(true);
  });

  it("does not become flowable from a break on its very first block", () => {
    expect(isProblemAreaFlowEligible({
      isFullSpan: false,
      isFramedArea: true,
      blocks: [
        { pagination: { break: true } },
        { pagination: undefined },
      ],
    })).toBe(false);
  });

  it("keeps atomic areas atomic when the segment height is invalid", () => {
    for (const segmentHeightPx of [0, -1, Number.NaN]) {
      expect(isProblemAreaFlowEligible({
        isFullSpan: false,
        isFramedArea: true,
        blocks: [{ pagination: undefined }],
        gapFreeHeightPx: 1_000,
        segmentHeightPx,
      })).toBe(false);
    }
  });
});
