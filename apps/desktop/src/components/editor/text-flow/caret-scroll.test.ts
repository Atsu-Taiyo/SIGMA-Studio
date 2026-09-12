import { describe, expect, it } from "vitest";

import {
  getCaretZoomScale,
  resolveCaretRectForScroll,
  resolveScrollDelta,
  shouldDeferCaretScrollForPlacement,
  visibleBottomOf,
} from "./caret-scroll";

describe("resolveScrollDelta", () => {
  it("可視域の内側なら 0", () => {
    expect(resolveScrollDelta({ top: 100, bottom: 120 }, { top: 0, bottom: 800 }, 8)).toBe(0);
  });

  it("上にはみ出したら負の差分", () => {
    expect(resolveScrollDelta({ top: -30, bottom: -10 }, { top: 0, bottom: 800 }, 8)).toBe(-38);
  });

  it("下にはみ出したら正の差分", () => {
    expect(resolveScrollDelta({ top: 790, bottom: 810 }, { top: 0, bottom: 800 }, 8)).toBe(18);
  });

  it("キャレットが可視域より高いときは上端合わせ", () => {
    // 下端に合わせると行の頭が切れる。
    expect(resolveScrollDelta({ top: -10, bottom: 900 }, { top: 0, bottom: 800 }, 8)).toBe(-18);
  });

  it("マージン 0 でも境界ちょうどは動かさない", () => {
    expect(resolveScrollDelta({ top: 0, bottom: 800 }, { top: 0, bottom: 800 }, 0)).toBe(0);
    expect(resolveScrollDelta({ top: 0, bottom: 20 }, { top: 0, bottom: 800 }, 0)).toBe(0);
    expect(resolveScrollDelta({ top: 780, bottom: 800 }, { top: 0, bottom: 800 }, 0)).toBe(0);
  });

  it("上下ともはみ出す前に、まず上を合わせる", () => {
    expect(resolveScrollDelta({ top: -5, bottom: 805 }, { top: 0, bottom: 800 }, 0)).toBe(-5);
  });
});

describe("resolveCaretRectForScroll", () => {
  it("空キャレットが原点矩形でも、可視域内のブロックへ倒してスクロールしない", () => {
    const caret = resolveCaretRectForScroll(
      { top: 0, bottom: 0 },
      { top: 497, bottom: 525 },
    );

    expect(caret).toEqual({ top: 497, bottom: 525 });
    expect(resolveScrollDelta(caret, { top: 116, bottom: 720 }, 24)).toBe(0);
  });
});

describe("shouldDeferCaretScrollForPlacement", () => {
  it("独立カラムで挿入直後のブロックが未配置なら待つ", () => {
    expect(shouldDeferCaretScrollForPlacement({
      caretHasPlacement: false,
      caretIsTopLevelBlock: true,
      hasPlacedBlocks: true,
      isPlacementSurface: true,
    })).toBe(true);
  });

  it("通常本文は挿入直後でも静的配置のため待たない", () => {
    expect(shouldDeferCaretScrollForPlacement({
      caretHasPlacement: false,
      caretIsTopLevelBlock: true,
      hasPlacedBlocks: false,
      isPlacementSurface: false,
    })).toBe(false);
  });

  it("配置済みブロックなら待たない", () => {
    expect(shouldDeferCaretScrollForPlacement({
      caretHasPlacement: true,
      caretIsTopLevelBlock: true,
      hasPlacedBlocks: true,
      isPlacementSurface: true,
    })).toBe(false);
  });
});


function stubElement(options: {
  clipped: boolean;
  offsetHeight: number;
  visibleHeight?: string;
}): HTMLElement {
  const element = {
    classList: {
      contains: (name: string) => options.clipped && name === "text-flow-box-fragment-source",
    },
    offsetHeight: options.offsetHeight,
  } as unknown as HTMLElement;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => options.visibleHeight ?? "",
  });
  (element as { restoreComputedStyle?: () => void }).restoreComputedStyle = () => {
    (globalThis as { getComputedStyle: unknown }).getComputedStyle = originalGetComputedStyle;
  };
  return element;
}

function rect(top: number, height: number): DOMRect {
  return { bottom: top + height, height, top } as DOMRect;
}

describe("getCaretZoomScale", () => {
  it("実寸との比を倍率として返す", () => {
    expect(getCaretZoomScale({ offsetHeight: 100 } as HTMLElement, rect(0, 130))).toBeCloseTo(1.3);
  });

  it("実寸が取れないときは 1 に倒す", () => {
    expect(getCaretZoomScale({ offsetHeight: 0 } as HTMLElement, rect(0, 130))).toBe(1);
  });
});

describe("visibleBottomOf", () => {
  it("分割されていないブロックは矩形の下端そのもの", () => {
    const element = stubElement({ clipped: false, offsetHeight: 100, visibleHeight: "40px" });
    expect(visibleBottomOf(element, rect(10, 100))).toBe(110);
    (element as { restoreComputedStyle?: () => void }).restoreComputedStyle?.();
  });

  it("分割ブロックは可視高さにズーム倍率を掛けたところで切る", () => {
    // 可視高さ 40 (紙面 px) × 倍率 1.3 = 52。矩形の下端 (10 + 130) より手前で切れる。
    const element = stubElement({ clipped: true, offsetHeight: 100, visibleHeight: "40px" });
    expect(visibleBottomOf(element, rect(10, 130))).toBeCloseTo(62);
    (element as { restoreComputedStyle?: () => void }).restoreComputedStyle?.();
  });

  it("可視高さが読めないときは矩形の下端へ倒す", () => {
    const element = stubElement({ clipped: true, offsetHeight: 100, visibleHeight: "" });
    expect(visibleBottomOf(element, rect(10, 130))).toBe(140);
    (element as { restoreComputedStyle?: () => void }).restoreComputedStyle?.();
  });
});
