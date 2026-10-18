import { describe, expect, it } from "vitest";

import type { SigmaDocument } from "@/features/document";
import { getCommentQuoteContent, sliceInlineNodes } from "@/lib/comment-quote-content";

const document: SigmaDocument = {
  version: "2.0",
  docId: "comment_quote_content",
  metadata: { title: "引用" },
  content: [
    { id: "h1", type: "heading", level: 1, children: [{ type: "text", text: "見出し", fontSize: 20 }] },
    {
      id: "p1",
      type: "paragraph",
      children: [
        { type: "text", text: "関数 " },
        { type: "mathInline", id: "m1", tex: "y=x^2", display: "inline" },
        { type: "text", text: " の最小値は", marks: ["bold"] },
        { type: "text", text: "頂点でとる。" },
      ],
    },
    { id: "p2", type: "paragraph", children: [{ type: "text", text: "続きの段落です。" }] },
  ],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

describe("getCommentQuoteContent", () => {
  it("切り出した範囲の書式と数式を本文のまま残す (数式は $tex$ の長さで数える)", () => {
    // 「関数 」(3) + 「$y=x^2$」(7) + 「 の最小値は」(6)
    const content = getCommentQuoteContent(document, {
      type: "textRange",
      start: { blockId: "p1", offset: 3 },
      end: { blockId: "p1", offset: 16 },
      quote: "y=x2 の最小値は",
    });
    expect(content).toEqual([
      { type: "mathInline", id: "m1__comment_quote", tex: "y=x^2", display: "inline" },
      { type: "text", text: " の最小値は", marks: ["bold"] },
    ]);
  });

  it("段落をまたぐ範囲と、後ろから前へ選んだ範囲も本文の並びで切り出す", () => {
    const anchor = {
      type: "textRange" as const,
      start: { blockId: "p2", offset: 3 },
      end: { blockId: "p1", offset: 16 },
      quote: "",
    };
    const content = getCommentQuoteContent(document, anchor);
    expect(content?.map((node) => node.type === "text" ? node.text : `$${node.tex}$`).join("")).toBe("頂点でとる。 続きの");
  });

  it("ブロック・数式への付け先は中身を返し、本文の文字の大きさは持ち込まない", () => {
    expect(getCommentQuoteContent(document, { type: "block", blockId: "h1" })).toEqual([{ type: "text", text: "見出し" }]);
    expect(getCommentQuoteContent(document, { type: "inlineMath", blockId: "p1", mathInlineId: "m1" })).toEqual([
      { type: "mathInline", id: "m1__comment_quote", tex: "y=x^2", display: "inline" },
    ]);
    expect(getCommentQuoteContent(document, { type: "overlayMath", tex: "\\frac{1}{2}" })?.[0]).toMatchObject({ tex: "\\frac{1}{2}" });
  });

  it("本文から引けない付け先は null (保存してある引用の文字列で出す)", () => {
    expect(getCommentQuoteContent(document, { type: "block", blockId: "missing", quote: "消えた段落" })).toBeNull();
    expect(getCommentQuoteContent(document, { type: "document" })).toBeNull();
    expect(getCommentQuoteContent(document, { type: "overlayShape", shapeIds: ["s1"] })).toBeNull();
  });
});

describe("sliceInlineNodes", () => {
  it("数式に一部だけ掛かっても数式を丸ごと入れる", () => {
    const nodes = document.content[1].type === "paragraph" ? document.content[1].children : [];
    expect(sliceInlineNodes(nodes, 5, 6).map((node) => node.type)).toEqual(["mathInline"]);
    expect(sliceInlineNodes(nodes, 0, 2)).toEqual([{ type: "text", text: "関数" }]);
  });
});
