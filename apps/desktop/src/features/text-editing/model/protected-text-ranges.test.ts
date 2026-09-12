import { describe, expect, it } from "vitest";
import { rebaseProtectedTextRanges } from "./protected-text-ranges";

describe("rebaseProtectedTextRanges", () => {
  const text = "前の本文【AI対象】後の本文";
  const ranges = [{ from: 4, to: 10 }];

  it("follows edits on both sides, including a batched save", () => {
    expect(rebaseProtectedTextRanges(text, "前の本文を追記【AI対象】後の本文も編集", ranges))
      .toEqual([{ from: 7, to: 13 }]);
  });

  it("allows insertions at either boundary", () => {
    expect(rebaseProtectedTextRanges(text, "前の本文追加【AI対象】追加後の本文", ranges))
      .toEqual([{ from: 6, to: 12 }]);
  });

  it.each(["前の本文【人間対象】後の本文", "前の本文【AI追加対象】後の本文", "前の本文後の本文"])("rejects changes to the protected fragment: %s", (after) => {
    expect(rebaseProtectedTextRanges(text, after, ranges)).toBeNull();
  });

  it("does not allocate quadratic memory for long unchanged edges", () => {
    const before = "a".repeat(20000) + "対象" + "z".repeat(20000);
    expect(rebaseProtectedTextRanges(before, "追記" + before, [{ from: 20000, to: 20002 }]))
      .toEqual([{ from: 20002, to: 20004 }]);
  });

  it("rejects stale offsets", () => {
    expect(rebaseProtectedTextRanges("短文", "短文", [{ from: 0, to: 3 }])).toBeNull();
  });
});
