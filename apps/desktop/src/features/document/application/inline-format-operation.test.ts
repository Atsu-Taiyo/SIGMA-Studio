import { describe, expect, it } from "vitest";

import {
  formatInlineNodeRange,
  inlineNodesReferenceLength,
  reconcileInlineNodeReplacement,
  replaceInlineNodeRange,
} from "./inline-format-operation";
import type { InlineNode } from "../model";

// `features/document` はコードで投げる (文言は `shape` 辞書)。
// 文字列で検査すると i18n のたびに壊れるので、コードで固定する。
describe("formatInlineNodeRange", () => {
  it("formats only the selected text while preserving content and unrelated marks", () => {
    const children: InlineNode[] = [
      { type: "text", text: "前半", marks: ["bold"] },
      { type: "text", text: "中央後半" },
    ];

    const result = formatInlineNodeRange(children, 2, 4, {
      fontFamily: 'ui-serif, "Yu Mincho", serif',
      fontSize: 14,
      boxed: { enabled: true, variant: "double", tone: "blue" },
    });

    expect(result.map((child) => child.type === "text" ? child.text : `$${child.tex}$`).join(""))
      .toBe("前半中央後半");
    expect(result).toEqual([
      { type: "text", text: "前半", marks: ["bold"] },
      {
        type: "text",
        text: "中央",
        marks: ["boxed"],
        fontFamily: 'ui-serif, "Yu Mincho", serif',
        fontSize: 14,
        boxedVariant: "double",
        boxedTone: "blue",
      },
      { type: "text", text: "後半" },
    ]);
  });

  it("formats a whole intersected math atom and can clear explicit formatting", () => {
    const children: InlineNode[] = [
      { type: "text", text: "式" },
      {
        type: "mathInline",
        id: "m_1",
        tex: "x^2",
        display: "inline",
        marks: ["underline", "boxed"],
        fontFamily: "serif",
        fontSize: 18,
        boxedVariant: "thick",
      },
    ];

    expect(inlineNodesReferenceLength(children)).toBe(6);
    expect(formatInlineNodeRange(children, 2, 3, {
      fontFamily: null,
      fontSize: null,
      boxed: { enabled: false },
    })).toEqual([
      { type: "text", text: "式" },
      { type: "mathInline", id: "m_1", tex: "x^2", display: "inline", marks: ["underline"] },
    ]);
  });

  it("rejects unsafe font values before they reach a renderer", () => {
    expect(() => formatInlineNodeRange([{ type: "text", text: "本文" }], 0, 2, {
      fontFamily: "serif;}html{display:none",
    })).toThrow(expect.objectContaining({ code: "unsafeFontFamily" }));
  });
});

describe("replaceInlineNodeRange", () => {
  it("copy-with replaces only the requested text and inherits its inline presentation", () => {
    const children: InlineNode[] = [
      { type: "text", text: "前半", marks: ["bold"] },
      {
        type: "text",
        text: "変更前",
        fontFamily: 'ui-serif, "Yu Mincho", serif',
        fontSize: 14,
        color: "#123456",
      },
      { type: "text", text: "後半", marks: ["underline"] },
    ];

    expect(replaceInlineNodeRange(children, 2, 5, [{ type: "text", text: "変更後の文" }])).toEqual([
      { type: "text", text: "前半", marks: ["bold"] },
      {
        type: "text",
        text: "変更後の文",
        fontFamily: 'ui-serif, "Yu Mincho", serif',
        fontSize: 14,
        color: "#123456",
      },
      { type: "text", text: "後半", marks: ["underline"] },
    ]);
  });

  it("keeps explicit replacement formatting while inheriting unspecified fields", () => {
    const children: InlineNode[] = [{
      type: "text",
      text: "旧",
      marks: ["bold"],
      fontFamily: "serif",
      fontSize: 14,
    }];

    expect(replaceInlineNodeRange(children, 0, 1, [{
      type: "text",
      text: "新",
      fontSize: 18,
    }])).toEqual([{
      type: "text",
      text: "新",
      marks: ["bold"],
      fontFamily: "serif",
      fontSize: 18,
    }]);
  });

  it("supports insertion and deletion without rebuilding surrounding nodes", () => {
    const children: InlineNode[] = [{ type: "text", text: "本文", fontSize: 16 }];

    expect(replaceInlineNodeRange(children, 1, 1, [{ type: "text", text: "追記" }])).toEqual([
      { type: "text", text: "本追記文", fontSize: 16 },
    ]);
    expect(replaceInlineNodeRange(children, 0, 2, [])).toEqual([{ type: "text", text: "" }]);
  });

  it("rejects replacing only part of a math atom", () => {
    const children: InlineNode[] = [
      { type: "text", text: "式" },
      { type: "mathInline", id: "m_1", tex: "x^2", display: "inline", fontSize: 14 },
    ];

    expect(() => replaceInlineNodeRange(children, 2, 3, [{ type: "text", text: "x" }]))
      .toThrow(expect.objectContaining({ code: "inlineMathPartialRange" }));
  });
});

describe("reconcileInlineNodeReplacement", () => {
  it("reduces a full unstyled payload to a minimal copy-with patch", () => {
    const current: InlineNode[] = [
      { type: "text", text: "固定" },
      { type: "text", text: "変更前", fontFamily: "serif", fontSize: 14 },
      { type: "text", text: "末尾", marks: ["underline"] },
    ];
    const replacement: InlineNode[] = [{ type: "text", text: "固定変更後末尾" }];

    expect(reconcileInlineNodeReplacement(current, replacement)).toEqual([
      { type: "text", text: "固定" },
      { type: "text", text: "変更後", fontFamily: "serif", fontSize: 14 },
      { type: "text", text: "末尾", marks: ["underline"] },
    ]);
  });

  it("keeps an unchanged rich inline structure instead of accepting an unstyled rebuild", () => {
    const current: InlineNode[] = [
      { type: "text", text: "重要", marks: ["bold"], fontSize: 16 },
      { type: "mathInline", id: "m_keep", tex: "x^2", display: "inline", fontSize: 16 },
    ];

    expect(reconcileInlineNodeReplacement(current, [{ type: "text", text: "重要$x^2$" }]))
      .toEqual(current);
  });
});
