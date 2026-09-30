import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiStreamRenderer } from "./AiStreamRenderer";

describe("AiStreamRenderer", () => {
  it("renders inline and multiline display math in AI chat text", () => {
    const html = renderToStaticMarkup(
      <AiStreamRenderer
        text={[
          "二次関数は $y=x^2$ と表せます。",
          "",
          "$$",
          "\\frac{1}{2}x^2",
          "$$",
        ].join("\n")}
      />,
    );

    expect(html).toContain("math-preview-inline");
    expect(html).toContain("math-preview-display");
    expect(html).toContain("inline-math-node");
    expect(html).toContain("display-math-node");
    expect(html).not.toContain("$$");
  });

  it("preserves regular line breaks while parsing math across a paragraph", () => {
    const html = renderToStaticMarkup(
      <AiStreamRenderer text={"1行目\n2行目 \\(x+1\\)"} />,
    );

    expect(html).toContain("<br/>");
    expect(html).toContain("math-preview-inline");
  });

  it("renders a Markdown table with alignment, keeping math and pipes inside math intact", () => {
    const html = renderToStaticMarkup(
      <AiStreamRenderer
        text={[
          "比較です。",
          "",
          "| 項目 | 式 | 値 |",
          "| :--- | :---: | ---: |",
          "| 絶対値 | $|x|$ | 3 |",
          "| 二次式 | `a|b` | 12 |",
        ].join("\n")}
      />,
    );

    expect(html).toContain("data-markdown-table");
    expect(html).toContain("<thead>");
    expect(html.match(/<th[ >]/g)).toHaveLength(3);
    // 見出し行 + 2行、各3セル。数式とコードの中の | では割られない。
    expect(html.match(/<td/g)).toHaveLength(6);
    expect(html).toContain("text-align:center");
    expect(html).toContain("text-align:right");
    expect(html).toContain("math-preview-inline");
    expect(html).toContain("<code>a|b</code>");
    expect(html).not.toContain("| 項目");
  });

  it("does not turn pipe-containing prose or a lone rule into a table", () => {
    const prose = renderToStaticMarkup(<AiStreamRenderer text={"A | B のどちらか\n---"} />);
    expect(prose).not.toContain("<table");
    expect(prose).toContain("<hr/>");

    const ragged = renderToStaticMarkup(<AiStreamRenderer text={"| a | b |\n| --- |\n| 1 | 2 |"} />);
    expect(ragged).not.toContain("<table");
  });

  it("renders block quotes and horizontal rules, and pads short rows to the header width", () => {
    const html = renderToStaticMarkup(
      <AiStreamRenderer text={"> 注意: 単位をそろえる\n> 次の行\n\n***\n\n| a | b |\n|---|---|\n| 1 |"} />,
    );

    expect(html).toContain("<blockquote>");
    expect(html).toContain("注意: 単位をそろえる");
    expect(html).toContain("<br/>");
    expect(html).toContain("<hr/>");
    expect(html.match(/<td/g)).toHaveLength(2);
  });
});
