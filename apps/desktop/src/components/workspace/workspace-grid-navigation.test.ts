import { describe, expect, it } from "vitest";

import { computeNextIndex, countGridColumns } from "./workspace-grid-navigation";

describe("countGridColumns", () => {
  it("returns 0 for an empty list", () => {
    expect(countGridColumns([])).toBe(0);
  });

  it("returns 1 when every item is on its own row", () => {
    expect(countGridColumns([0, 50, 100])).toBe(1);
  });

  it("counts leading items sharing the first item's offsetTop as one row", () => {
    // 4-column grid, 6 items -> row 1 has 4 items at top=0, row 2 has 2 at top=160.
    expect(countGridColumns([0, 0, 0, 0, 160, 160])).toBe(4);
  });

  it("does not count items past the first differing top", () => {
    // Even if a later row coincidentally has the same count, only the
    // leading run at the first item's top is counted.
    expect(countGridColumns([0, 0, 160, 160, 160])).toBe(2);
  });

  it("returns the full length when every item shares the same top (single row)", () => {
    expect(countGridColumns([0, 0, 0])).toBe(3);
  });
});

describe("computeNextIndex", () => {
  it("returns -1 for an empty row set", () => {
    expect(computeNextIndex(0, 0, "down", "list", 1)).toBe(-1);
  });

  it("Home always returns 0", () => {
    expect(computeNextIndex(5, 10, "home", "grid", 3)).toBe(0);
  });

  it("End always returns the last index", () => {
    expect(computeNextIndex(0, 10, "end", "list", 1)).toBe(9);
  });

  describe("list layout", () => {
    it("moves up by 1", () => {
      expect(computeNextIndex(3, 10, "up", "list", 1)).toBe(2);
    });

    it("moves down by 1", () => {
      expect(computeNextIndex(3, 10, "down", "list", 1)).toBe(4);
    });

    it("clamps up at the first row", () => {
      expect(computeNextIndex(0, 10, "up", "list", 1)).toBe(0);
    });

    it("clamps down at the last row", () => {
      expect(computeNextIndex(9, 10, "down", "list", 1)).toBe(9);
    });

    it("is a no-op for left/right", () => {
      expect(computeNextIndex(4, 10, "left", "list", 1)).toBe(4);
      expect(computeNextIndex(4, 10, "right", "list", 1)).toBe(4);
    });
  });

  describe("grid layout", () => {
    it("moves left/right by 1", () => {
      expect(computeNextIndex(4, 10, "left", "grid", 3)).toBe(3);
      expect(computeNextIndex(4, 10, "right", "grid", 3)).toBe(5);
    });

    it("moves up/down by the column count", () => {
      expect(computeNextIndex(4, 10, "down", "grid", 3)).toBe(7);
      expect(computeNextIndex(4, 10, "up", "grid", 3)).toBe(1);
    });

    it("clamps left at the first item", () => {
      expect(computeNextIndex(0, 10, "left", "grid", 3)).toBe(0);
    });

    it("clamps right at the last item", () => {
      expect(computeNextIndex(9, 10, "right", "grid", 3)).toBe(9);
    });

    it("clamps up past the top row to the first item", () => {
      expect(computeNextIndex(1, 10, "up", "grid", 3)).toBe(0);
    });

    it("clamps down past the bottom row to the last item", () => {
      expect(computeNextIndex(8, 10, "down", "grid", 3)).toBe(9);
    });

    it("treats a columnCount of 0 as 1 column", () => {
      expect(computeNextIndex(2, 5, "down", "grid", 0)).toBe(3);
    });
  });
});
