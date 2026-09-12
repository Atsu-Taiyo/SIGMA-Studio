import { describe, expect, it } from "vitest";

import { parsePastedMarkdown } from "./markdown-paste";

describe("parsePastedMarkdown", () => {
  it("creates a code block from pasted fenced Markdown without storing the fence", () => {
    expect(parsePastedMarkdown([
      "```typescript",
      "const answer: number = 42;",
      "```",
    ].join("\n"))).toMatchObject([{
      type: "codeBlock",
      language: "typescript",
      children: [{ type: "text", text: "const answer: number = 42;" }],
    }]);
  });

  it("keeps text glued to an unknown opening marker as code instead of discarding it", () => {
    expect(parsePastedMarkdown([
      "```asdasda",
      "asdasdasdsaadasdasdas",
    ].join("\n"))).toMatchObject([{
      type: "codeBlock",
      children: [{ type: "text", text: "asdasda\nasdasdasdsaadasdasdas" }],
    }]);
  });

  it("converts pasted Markdown paragraphs, headings, and bullet lists into text-flow blocks", () => {
    const blocks = parsePastedMarkdown([
      "md形式の文章",
      "",
      "## aaa",
      "- wagvw",
      "- **太字** と *斜体*",
    ].join("\n"));

    expect(blocks).toMatchObject([
      {
        type: "paragraph",
        children: [{ type: "text", text: "md形式の文章" }],
      },
      {
        type: "heading",
        level: 2,
        children: [{ type: "text", text: "aaa" }],
      },
      {
        type: "list",
        listType: "bullet",
        items: [
          {
            type: "listItem",
            children: [{ type: "text", text: "wagvw" }],
          },
          {
            type: "listItem",
            children: [
              { type: "text", text: "太字", marks: ["bold"] },
              { type: "text", text: " と " },
              { type: "text", text: "斜体", marks: ["italic"] },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps ordered starts and nested list structure", () => {
    const blocks = parsePastedMarkdown([
      "3. first",
      "4. second",
      "   - child",
      "   - child 2",
    ].join("\n"));

    expect(blocks).toMatchObject([
      {
        type: "list",
        listType: "ordered",
        start: 3,
        items: [
          { children: [{ type: "text", text: "first" }] },
          {
            children: [{ type: "text", text: "second" }],
            nested: [{
              type: "list",
              listType: "bullet",
              items: [
                { children: [{ type: "text", text: "child" }] },
                { children: [{ type: "text", text: "child 2" }] },
              ],
            }],
          },
        ],
      },
    ]);
  });

  it("reads a pasted (1) block as one paren-marked ordered list", () => {
    expect(parsePastedMarkdown([
      "(1) first",
      "(2) second",
    ].join("\n"))).toMatchObject([
      {
        type: "list",
        listType: "ordered",
        markerStyle: "paren",
        items: [
          { children: [{ type: "text", text: "first" }] },
          { children: [{ type: "text", text: "second" }] },
        ],
      },
    ]);
  });

  it("keeps a non-1 start and skipped numbers on the pasted paren list", () => {
    expect(parsePastedMarkdown([
      "(2) second",
      "(5) fifth",
    ].join("\n"))).toMatchObject([
      {
        type: "list",
        listType: "ordered",
        markerStyle: "paren",
        start: 2,
        items: [
          { children: [{ type: "text", text: "second" }] },
          { children: [{ type: "text", text: "fifth" }] },
        ],
      },
    ]);
  });

  it("splits (1) and 1. runs into separate lists instead of merging the markers", () => {
    const blocks = parsePastedMarkdown([
      "(1) paren",
      "1. decimal",
    ].join("\n"));

    expect(blocks).toHaveLength(2);
    expect(blocks).toMatchObject([
      { type: "list", listType: "ordered", markerStyle: "paren" },
      { type: "list", listType: "ordered" },
    ]);
    expect(blocks?.[1]).not.toHaveProperty("markerStyle");
  });

  it("nests an indented (1) run under its parent item", () => {
    expect(parsePastedMarkdown([
      "(1) parent",
      "   (1) child",
    ].join("\n"))).toMatchObject([
      {
        type: "list",
        markerStyle: "paren",
        items: [{
          children: [{ type: "text", text: "parent" }],
          nested: [{ type: "list", listType: "ordered", markerStyle: "paren" }],
        }],
      },
    ]);
  });

  it("keeps a blank-line separated paren run in the same list", () => {
    expect(parsePastedMarkdown([
      "(1) first",
      "",
      "(2) second",
    ].join("\n"))).toMatchObject([
      { type: "list", markerStyle: "paren", items: [{}, {}] },
    ]);
  });

  it("leaves parenthesised prose that is not a list marker alone", () => {
    expect(parsePastedMarkdown("(1)括弧のあとに空白がない\n次の行")).toBeNull();
    expect(parsePastedMarkdown("式 (1) を使う\n次の行")).toBeNull();
  });

  it("maps unsupported deeper Markdown heading levels to the deepest SigmaDoc heading", () => {
    expect(parsePastedMarkdown("###### 詳細 ###")).toMatchObject([
      {
        type: "heading",
        level: 3,
        children: [{ type: "text", text: "詳細" }],
      },
    ]);
  });

  it("leaves ordinary prose and ambiguous punctuation on the native paste path", () => {
    expect(parsePastedMarkdown("普通の文章\n次の行です")).toBeNull();
    expect(parsePastedMarkdown("#見出しではない")).toBeNull();
    expect(parsePastedMarkdown("-123 は負の数です")).toBeNull();
    expect(parsePastedMarkdown("価格は\\$5です")).toBeNull();
  });

  it("converts each $...$ range in pasted prose into an inline math node", () => {
    const blocks = parsePastedMarkdown([
      String.raw`$z=0$ の面内で点 $\mathrm{O}$ を中心とする半径 $a\,(\leqq R)$ の円を貫く磁束 $\Phi_a$ は，`,
      "",
      String.raw`$\Phi_a=\pi B_0a^2\left(1-\frac{2a}{3R}\right)$`,
      "",
      "であることを示せ。",
    ].join("\n"));

    expect(blocks).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "mathInline", tex: "z=0", display: "inline" },
          { type: "text", text: " の面内で点 " },
          { type: "mathInline", tex: String.raw`\mathrm{O}`, display: "inline" },
          { type: "text", text: " を中心とする半径 " },
          { type: "mathInline", tex: String.raw`a\,(\leqq R)`, display: "inline" },
          { type: "text", text: " の円を貫く磁束 " },
          { type: "mathInline", tex: String.raw`\Phi_a`, display: "inline" },
          { type: "text", text: " は，" },
        ],
      },
      {
        type: "paragraph",
        children: [{
          type: "mathInline",
          tex: String.raw`\Phi_a=\pi B_0a^2\left(1-\frac{2a}{3R}\right)`,
          display: "inline",
        }],
      },
      {
        type: "paragraph",
        children: [{ type: "text", text: "であることを示せ。" }],
      },
    ]);
  });

  it("does not interpret underscores inside words as emphasis", () => {
    expect(parsePastedMarkdown("- snake_case and __bold__")).toMatchObject([
      {
        type: "list",
        items: [{
          children: [
            { type: "text", text: "snake_case and " },
            { type: "text", text: "bold", marks: ["bold"] },
          ],
        }],
      },
    ]);
  });
});
