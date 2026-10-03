import { describe, expect, it } from "vitest";

import {
  MAX_CAPTURE_OUTPUT_DIMENSION,
  MAX_CAPTURE_REGION_SIDE,
  MIN_CAPTURE_OUTPUT_DIMENSION,
  parseCaptureRegionRequest,
  planCaptureDownscale,
} from "./capture-region";

describe("parseCaptureRegionRequest", () => {
  it("rounds a fractional rectangle outwards so no edge pixel is lost", () => {
    expect(parseCaptureRegionRequest({ x: 10.4, y: 20.6, width: 100.2, height: 50.1 })).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    });
  });

  it.each([
    null,
    "rect",
    {},
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: 10, height: -5 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
    { x: "0", y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: MAX_CAPTURE_REGION_SIDE + 1, height: 10 },
  ])("rejects %j", (value) => {
    expect(parseCaptureRegionRequest(value)).toBeNull();
  });

  it("clamps the requested output size and ignores a non-number", () => {
    const base = { x: 0, y: 0, width: 10, height: 10 };
    expect(parseCaptureRegionRequest({ ...base, maxDimension: 2048 })?.maxDimension).toBe(2048);
    expect(parseCaptureRegionRequest({ ...base, maxDimension: 10 })?.maxDimension).toBe(MIN_CAPTURE_OUTPUT_DIMENSION);
    expect(parseCaptureRegionRequest({ ...base, maxDimension: 99999 })?.maxDimension).toBe(MAX_CAPTURE_OUTPUT_DIMENSION);
    expect(parseCaptureRegionRequest({ ...base, maxDimension: "big" })).not.toHaveProperty("maxDimension");
  });
});

describe("planCaptureDownscale", () => {
  it("keeps the captured resolution when no limit is requested or the image already fits", () => {
    expect(planCaptureDownscale({ width: 4000, height: 3000 }, undefined)).toBeNull();
    expect(planCaptureDownscale({ width: 2048, height: 1000 }, 2048)).toBeNull();
  });

  it("shrinks the longer side to the limit and keeps the aspect ratio", () => {
    expect(planCaptureDownscale({ width: 4000, height: 2000 }, 2000)).toEqual({ width: 2000, height: 1000 });
    expect(planCaptureDownscale({ width: 1000, height: 4000 }, 2000)).toEqual({ width: 500, height: 2000 });
  });

  it("never collapses a thin image to zero", () => {
    expect(planCaptureDownscale({ width: 8000, height: 1 }, 256)).toEqual({ width: 256, height: 1 });
  });
});
