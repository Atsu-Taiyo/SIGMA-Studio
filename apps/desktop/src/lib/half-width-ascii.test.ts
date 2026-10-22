import { describe, expect, it } from "vitest";

import { hasFullWidthAscii, toHalfWidthAscii } from "@/lib/half-width-ascii";

describe("toHalfWidthAscii", () => {
  it("maps the whole U+FF01-U+FF5E block onto U+0021-U+007E", () => {
    const fullWidth = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) => String.fromCharCode(0xff01 + index)).join("");
    const halfWidth = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) => String.fromCharCode(0x21 + index)).join("");
    expect(toHalfWidthAscii(fullWidth)).toBe(halfWidth);
  });

  it("turns an ideographic space into a normal space", () => {
    expect(toHalfWidthAscii("　")).toBe(" ");
    expect(toHalfWidthAscii("ａ　ｂ")).toBe("a b");
  });

  it("normalises a typical formula typed with the IME open", () => {
    expect(toHalfWidthAscii("ｘ＋１")).toBe("x+1");
    expect(toHalfWidthAscii("（ａ－ｂ）＝０")).toBe("(a-b)=0");
    expect(toHalfWidthAscii("ｙ＝ｘ＾２")).toBe("y=x^2");
  });

  it("leaves half-width ASCII, kana, kanji and characters outside the block untouched", () => {
    for (const text of ["x+1", "あいうアイウｱｲｳ", "漢字", "ー", "−", "、。", "￥", "¥", "", " "]) {
      expect(toHalfWidthAscii(text), text).toBe(text);
    }
  });

  it("normalises only the full-width part of mixed text", () => {
    expect(toHalfWidthAscii("傾きｍの直線ｙ＝ｍｘ")).toBe("傾きmの直線y=mx");
  });

  it("keeps surrogate pairs intact", () => {
    expect(toHalfWidthAscii("𠮟ｘ𠮟")).toBe("𠮟x𠮟");
  });
});

describe("hasFullWidthAscii", () => {
  it("detects the characters toHalfWidthAscii would change", () => {
    expect(hasFullWidthAscii("ｘ")).toBe(true);
    expect(hasFullWidthAscii("a　b")).toBe(true);
    expect(hasFullWidthAscii("x+1")).toBe(false);
    expect(hasFullWidthAscii("あ漢")).toBe(false);
    expect(hasFullWidthAscii("")).toBe(false);
  });
});
