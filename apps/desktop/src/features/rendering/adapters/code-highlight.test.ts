import { describe, expect, it } from "vitest";

import {
  CODE_BLOCK_LANGUAGES,
  codeHighlightRanges,
  detectCodeLanguage,
  highlightCode,
  normalizeCodeLanguage,
  shouldHighlightCode,
} from "./code-highlight";

const JS = "function add(a, b) {\n  return a + b; // sum\n}";

describe("highlightCode", () => {
  // これが崩れると、装飾も静的描画も 1 文字ずつずれた場所を塗る。位置合わせの土台。
  it("トークンの長さの総和は必ず元の文字数に等しい", () => {
    for (const [code, language] of [
      [JS, "javascript"],
      ["def add(a, b):\n    return a + b", "python"],
      ["SELECT id FROM users WHERE age > 20;", "sql"],
      ["", "javascript"],
      ["日本語のコメント # だけ", "python"],
      [JS, undefined],
      [JS, "plaintext"],
      [JS, "存在しない言語"],
    ] as const) {
      const total = highlightCode(code, language).reduce((sum, token) => sum + token.length, 0);
      expect(total, `${language} / ${code.slice(0, 20)}`).toBe(code.length);
    }
  });

  it("色を付ける範囲を class つきで返す", () => {
    const ranges = codeHighlightRanges(JS, "javascript");

    expect(ranges[0]).toEqual({ from: 0, to: 8, className: "hljs-keyword" });
    expect(ranges.every((range) => range.from < range.to)).toBe(true);
    expect(ranges.every((range) => range.to <= JS.length)).toBe(true);
    // 範囲は前から順で重ならない (装飾も静的描画もそれを前提に切っている)。
    expect(ranges.every((range, index) => index === 0 || ranges[index - 1].to <= range.from)).toBe(true);
  });

  it("plaintext は色を付けない", () => {
    expect(codeHighlightRanges(JS, "plaintext")).toEqual([]);
  });

  it("巨大なコードは本文を保ったまま色分けだけを省略する", () => {
    const code = Array.from({ length: 10_000 }, (_, index) => `const value${index} = ${index};`).join("\n");

    expect(shouldHighlightCode(code)).toBe(false);
    expect(highlightCode(code, "javascript")).toEqual([{ length: code.length }]);
    expect(codeHighlightRanges(code, "javascript")).toEqual([]);
  });

  it("読めない言語は自動判定へ落として本文は失わない", () => {
    expect(normalizeCodeLanguage("存在しない言語")).toBeUndefined();
    expect(normalizeCodeLanguage(42)).toBeUndefined();
    expect(normalizeCodeLanguage("python")).toBe("python");
  });
});

describe("detectCodeLanguage", () => {
  it("明示指定があればそのまま返す", () => {
    expect(detectCodeLanguage("a = 1", "python")).toBe("python");
  });

  // 数文字で判定させると打鍵のたびに色が変わる。短いうちは何も言わないのが正しい。
  it("短すぎる断片では判定しない", () => {
    expect(detectCodeLanguage("a = 1")).toBeUndefined();
  });

  it("ある程度の長さがあれば言語を当てる", () => {
    expect(detectCodeLanguage(JS)).toBe("javascript");
  });
});

describe("CODE_BLOCK_LANGUAGES", () => {
  it("一覧の値はすべて normalize を通る (ツールバーで選べる = 使える)", () => {
    for (const option of CODE_BLOCK_LANGUAGES) {
      expect(normalizeCodeLanguage(option.value), option.value).toBe(option.value);
    }
  });

  it("値が重複していない", () => {
    const values = CODE_BLOCK_LANGUAGES.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
