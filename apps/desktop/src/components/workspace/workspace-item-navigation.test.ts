import { describe, expect, it } from "vitest";

import { computeNextIndex } from "./workspace-item-navigation";

describe("computeNextIndex", () => {
  it("returns -1 for an empty row set", () => {
    expect(computeNextIndex(0, 0, "down")).toBe(-1);
  });

  it("Home always returns 0", () => {
    expect(computeNextIndex(5, 10, "home")).toBe(0);
  });

  it("End always returns the last index", () => {
    expect(computeNextIndex(0, 10, "end")).toBe(9);
  });

  it("moves up by 1", () => {
    expect(computeNextIndex(3, 10, "up")).toBe(2);
  });

  it("moves down by 1", () => {
    expect(computeNextIndex(3, 10, "down")).toBe(4);
  });

  it("clamps up at the first row", () => {
    expect(computeNextIndex(0, 10, "up")).toBe(0);
  });

  it("clamps down at the last row", () => {
    expect(computeNextIndex(9, 10, "down")).toBe(9);
  });
});
