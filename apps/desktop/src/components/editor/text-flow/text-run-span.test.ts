import { describe, expect, it } from "vitest";

import {
  resolveClickDragSelectionHead,
  resolveDoubleClickTextRange,
  resolveHorizontalExtensionTarget,
  resolveTextRunSpanCollapsePoint,
  type TextRunClickDragHeadContext,
  type TextRunHorizontalExtensionContext,
} from "./text-run-span";

describe("resolveDoubleClickTextRange", () => {
  it("selects a complete word", () => {
    expect(resolveDoubleClickTextRange("before after", 3)).toEqual({ from: 0, to: 6 });
  });

  it.each([
    ["surrogate pair", "😀"],
    ["variation selector", "✈️"],
    ["ZWJ sequence", "👨‍👩‍👧‍👦"],
    ["combining mark", "e\u0301"],
  ])("keeps a %s intact for deletion and replacement", (_label, grapheme) => {
    const text = `a ${grapheme} b`;
    const insideGrapheme = 2 + Math.max(0, Math.floor(grapheme.length / 2));
    const range = resolveDoubleClickTextRange(text, insideGrapheme);

    expect(text.slice(range.from, range.to)).toBe(grapheme);
    expect(text.slice(0, range.from) + text.slice(range.to)).toBe("a  b");
    expect(text.slice(0, range.from) + "X" + text.slice(range.to)).toBe("a X b");
  });
});

describe("resolveTextRunSpanCollapsePoint", () => {
  const ranges = [
    { unitId: "chunk-a", from: 4, to: 9 },
    { unitId: "chunk-b", from: 0, to: 6 },
    { unitId: "chunk-c", from: 0, to: 3 },
  ];

  it.each([["ArrowLeft"], ["ArrowUp"], ["Home"]])(
    "collapses %s to the document-order start of the span",
    (key) => {
      expect(resolveTextRunSpanCollapsePoint(ranges, key)).toEqual({ unitId: "chunk-a", pos: 4 });
    },
  );

  it.each([["ArrowRight"], ["ArrowDown"], ["End"]])(
    "collapses %s to the document-order end of the span",
    (key) => {
      expect(resolveTextRunSpanCollapsePoint(ranges, key)).toEqual({ unitId: "chunk-c", pos: 3 });
    },
  );

  it("collapses PageUp to the start and PageDown to the end", () => {
    expect(resolveTextRunSpanCollapsePoint(ranges, "PageUp")).toEqual({ unitId: "chunk-a", pos: 4 });
    expect(resolveTextRunSpanCollapsePoint(ranges, "PageDown")).toEqual({ unitId: "chunk-c", pos: 3 });
  });

  it("collapses Tab to the end and Shift+Tab to the start", () => {
    expect(resolveTextRunSpanCollapsePoint(ranges, "Tab")).toEqual({ unitId: "chunk-c", pos: 3 });
    expect(resolveTextRunSpanCollapsePoint(ranges, "Tab", { shiftKey: true }))
      .toEqual({ unitId: "chunk-a", pos: 4 });
  });

  it("keeps the span for Shift-extended navigation keys", () => {
    expect(resolveTextRunSpanCollapsePoint(ranges, "ArrowRight", { shiftKey: true })).toBeNull();
    expect(resolveTextRunSpanCollapsePoint(ranges, "Home", { shiftKey: true })).toBeNull();
    expect(resolveTextRunSpanCollapsePoint(ranges, "PageDown", { shiftKey: true })).toBeNull();
  });

  it("ignores non-navigation keys", () => {
    expect(resolveTextRunSpanCollapsePoint(ranges, "a")).toBeNull();
    expect(resolveTextRunSpanCollapsePoint(ranges, "Escape")).toBeNull();
    expect(resolveTextRunSpanCollapsePoint(ranges, "Backspace")).toBeNull();
  });

  it("returns null when the span resolves to no ranges", () => {
    expect(resolveTextRunSpanCollapsePoint([], "ArrowLeft")).toBeNull();
  });
});

describe("resolveHorizontalExtensionTarget", () => {
  const base: TextRunHorizontalExtensionContext = {
    active: true,
    backward: false,
    lineBoundaryKey: false,
    pos: 5,
    lineStart: 3,
    lineEnd: 8,
    firstSelectablePos: 1,
    lastSelectablePos: 10,
  };

  it("moves Shift+End to the line end within the unit", () => {
    expect(resolveHorizontalExtensionTarget({ ...base, lineBoundaryKey: true }))
      .toEqual({ kind: "within", pos: 8 });
  });

  it("stays put at a mid-unit line end instead of teleporting to the next editor", () => {
    expect(resolveHorizontalExtensionTarget({ ...base, lineBoundaryKey: true, pos: 8 })).toBeNull();
  });

  it("hands over to the adjacent editor only from the unit-edge line boundary", () => {
    expect(resolveHorizontalExtensionTarget({
      ...base,
      lineBoundaryKey: true,
      pos: 10,
      lineEnd: 10,
    })).toEqual({ kind: "adjacent" });
    expect(resolveHorizontalExtensionTarget({
      ...base,
      backward: true,
      lineBoundaryKey: true,
      pos: 1,
      lineStart: 1,
    })).toEqual({ kind: "adjacent" });
  });

  it("steps one position within the unit for Shift+Arrow away from the boundary", () => {
    expect(resolveHorizontalExtensionTarget(base)).toEqual({ kind: "step" });
    expect(resolveHorizontalExtensionTarget({ ...base, backward: true })).toEqual({ kind: "step" });
  });

  it("crosses to the adjacent editor from the last selectable position", () => {
    expect(resolveHorizontalExtensionTarget({ ...base, pos: 10 })).toEqual({ kind: "adjacent" });
    expect(resolveHorizontalExtensionTarget({ ...base, backward: true, pos: 1 }))
      .toEqual({ kind: "adjacent" });
  });

  it("treats a non-paragraph chunk edge (first selectable position > 1) as the boundary", () => {
    expect(resolveHorizontalExtensionTarget({
      ...base,
      backward: true,
      pos: 3,
      firstSelectablePos: 3,
    })).toEqual({ kind: "adjacent" });
  });

  it("does not start a span mid-unit when none is active", () => {
    expect(resolveHorizontalExtensionTarget({ ...base, active: false })).toBeNull();
    expect(resolveHorizontalExtensionTarget({ ...base, active: false, pos: 10 }))
      .toEqual({ kind: "adjacent" });
  });
});

describe("resolveClickDragSelectionHead", () => {
  const base: TextRunClickDragHeadContext = {
    detail: 2,
    extendsBackward: false,
    initialRange: { from: 4, to: 9 },
    pos: 22,
    posRange: { from: 20, to: 26 },
  };

  it("snaps a forward word drag to the end of the word under the pointer", () => {
    expect(resolveClickDragSelectionHead(base)).toBe(26);
  });

  it("snaps a backward word drag to the start of the word under the pointer", () => {
    expect(resolveClickDragSelectionHead({
      ...base,
      extendsBackward: true,
      pos: 2,
      posRange: { from: 1, to: 3 },
    })).toBe(1);
  });

  it("snaps a triple-click drag to the paragraph boundary the same way", () => {
    expect(resolveClickDragSelectionHead({ ...base, detail: 3 })).toBe(26);
  });

  it("keeps the raw position for a plain (single-click) drag", () => {
    expect(resolveClickDragSelectionHead({ ...base, detail: 1 })).toBe(22);
  });

  it("falls back to the raw position when the initial click found no range (empty line)", () => {
    expect(resolveClickDragSelectionHead({ ...base, initialRange: { from: 4, to: 4 } })).toBe(22);
  });
});
