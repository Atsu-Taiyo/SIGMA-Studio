// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  isNativeBodySelectionVisible,
  mergeSelectionHighlightRects,
  shouldPaintHeldBodySelection,
} from "./selection-highlight-rects";

describe("mergeSelectionHighlightRects", () => {
  it("drops empty boxes", () => {
    expect(mergeSelectionHighlightRects([
      { left: 10, top: 10, width: 0, height: 16 },
      { left: 10, top: 10, width: 40, height: 16 },
    ])).toEqual([
      { left: 10, top: 10, width: 40, height: 16 },
    ]);
  });

  it("collapses nested inline boxes on the same line into one bar", () => {
    expect(mergeSelectionHighlightRects([
      { left: 8, top: 20, width: 240, height: 18 },
      { left: 40, top: 21, width: 28, height: 16 },
      { left: 72, top: 18, width: 36, height: 22 },
    ])).toEqual([
      { left: 8, top: 18, width: 240, height: 22 },
    ]);
  });

  it("keeps separate lines apart", () => {
    expect(mergeSelectionHighlightRects([
      { left: 8, top: 20, width: 100, height: 16 },
      { left: 8, top: 44, width: 80, height: 16 },
    ])).toEqual([
      { left: 8, top: 20, width: 100, height: 16 },
      { left: 8, top: 44, width: 80, height: 16 },
    ]);
  });

  it("多段組の同じ高さの行は段間ギャップを跨いで融合しない", () => {
    // layoutSection の左右の段は同じ縦位置に行が並ぶ。水平の近接を見ずに畳むと
    // 段間 (実測 30px) ごと 1 枚の巨大矩形になり、ネイティブ選択と見た目が割れる。
    expect(mergeSelectionHighlightRects([
      { left: 8, top: 20, width: 100, height: 16 },
      { left: 138, top: 20, width: 100, height: 16 },
    ])).toEqual([
      { left: 8, top: 20, width: 100, height: 16 },
      { left: 138, top: 20, width: 100, height: 16 },
    ]);
  });

  it("行内で隣接する断片 (単語・数式ノード) は 1 本の帯に繋がる", () => {
    expect(mergeSelectionHighlightRects([
      { left: 8, top: 20, width: 40, height: 16 },
      { left: 50, top: 18, width: 30, height: 20 },
      { left: 82, top: 20, width: 60, height: 16 },
    ])).toEqual([
      { left: 8, top: 18, width: 134, height: 20 },
    ]);
  });
});

describe("shouldPaintHeldBodySelection", () => {
  it("stays off while native ::selection is already visible", () => {
    expect(shouldPaintHeldBodySelection({
      nativeSelectionVisible: true,
      multiEditorTextRunSpan: false,
    })).toBe(false);
  });

  it("stays off when the chunk-span overlay already owns the highlight", () => {
    expect(shouldPaintHeldBodySelection({
      nativeSelectionVisible: false,
      multiEditorTextRunSpan: true,
    })).toBe(false);
  });

  it("paints only when native selection is gone and no span overlay is up", () => {
    expect(shouldPaintHeldBodySelection({
      nativeSelectionVisible: false,
      multiEditorTextRunSpan: false,
    })).toBe(true);
  });
});

describe("isNativeBodySelectionVisible", () => {
  it("is true when the body editor or a descendant has focus", () => {
    const editor = document.createElement("div");
    editor.className = "text-flow-editor";
    const child = document.createElement("span");
    child.textContent = "本文";
    editor.append(child);
    document.body.append(editor);

    const range = document.createRange();
    range.selectNodeContents(child);

    expect(isNativeBodySelectionVisible(range, editor)).toBe(true);
    expect(isNativeBodySelectionVisible(range, child)).toBe(true);
    expect(isNativeBodySelectionVisible(range, document.body)).toBe(false);
  });
});
