import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocumentTitleText } from "./DocumentTitleText";

describe("DocumentTitleText", () => {
  it("タイトルの $…$ を本文と同じ数式描画に渡す", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="二次関数 $x^2$ の復習" />);

    expect(html).toContain("rich-inline-content");
    expect(html).toContain("inline-math-node");
    expect(html).toContain("math-preview-inline");
  });

  it("数式を含まないタイトルは要素を足さずそのまま出す", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="一次関数のまとめ" />);

    expect(html).toBe("一次関数のまとめ");
  });

  it("対にならない $ のタイトルは生の文字列のまま出す", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="価格は $100 です" />);

    expect(html).toBe("価格は $100 です");
    expect(html).not.toContain("math-preview");
  });

  it("KaTeX も MathLive も解釈できない tex で例外を投げない", () => {
    expect(() =>
      renderToStaticMarkup(<DocumentTitleText title="壊れた $\notacommand{$" />),
    ).not.toThrow();
  });

  // MathLive の検証を通るのに markup 生成で例外を投げる tex がある (`\href` など)。
  // タイトルは一覧やサイドバーで描かれるので、そこで throw すると React がツリーごと
  // 捨てて画面が真っ白になる。`renderMathHtml` が例外を握るので描画は通り、
  // markup にはリンクも実行可能な属性も残らない。
  // タイトルは「リッチ表示の可視テキスト = 生の文字列」が不変条件なので、数式として描けない
  // tex を素の TeX で出すと `$` が消えて元の文字列を復元できなくなる。丸ごと生表示へ倒すこと。
  it("markup 生成で例外を投げる tex はタイトル全体を生の文字列として出す", () => {
    let html = "";
    expect(() => {
      html = renderToStaticMarkup(<DocumentTitleText title="重要 $\href{javascript:alert(1)}{x}$ 資料" />);
    }).not.toThrow();
    expect(html).toBe("重要 $\\href{javascript:alert(1)}{x}$ 資料");
    expect(html).not.toContain("math-preview");
    expect(html).not.toContain("<a ");
  });

  // 出口で無害化するので、入口で `<` `>` `&` を弾く必要は無い。
  it("不等号を含むタイトルを数式として描く", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="範囲は $a < b$" />);

    expect(html).toContain("math-preview-inline");
    expect(html).not.toMatch(/<(?!\/?(?:span|svg|path|line|br)[\s/>])[a-zA-Z]/);
  });

  it("HTML を含むタイトルを描いても実行可能な要素を出さない", () => {
    const html = renderToStaticMarkup(
      <DocumentTitleText title="二次関数 $\text{<img src=x onerror=alert(1)>}$" />,
    );

    expect(html).toContain("math-preview-inline");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("数式付きタイトルは共有の数式スタイルが効くクラスを付ける", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="$x^2$" />);

    expect(html).toContain('class="rich-inline-content document-title-rich"');
  });

  // 本文から導出したタイトルは `$tex$` の文字列に潰さずノード列のまま渡せる。
  // 文字列に潰すと上限の切り出しが `$…$` の対を割り、生ソースが画面に出る。
  it("nodes を渡したら title 文字列をパースし直さない", () => {
    const html = renderToStaticMarkup(
      <DocumentTitleText
        title="次の和 $\sum_{i=1}^{n"
        nodes={[
          { type: "text", text: "次の和 " },
          { type: "mathInline", id: "m_1", tex: "\\sum_{i=1}^{n} i", display: "inline" },
        ]}
      />,
    );

    expect(html).toContain("math-preview-inline");
    expect(html).toContain("次の和");
    expect(html).not.toContain("$");
  });

  it("nodes={null} は素のテキストとして出す", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="二次関数 $x^2$ の復習" nodes={null} />);

    expect(html).toBe("二次関数 $x^2$ の復習");
  });

  it("nodes を省略したら従来どおり title をパースする", () => {
    const html = renderToStaticMarkup(<DocumentTitleText title="二次関数 $x^2$ の復習" />);

    expect(html).toContain("math-preview-inline");
  });

  it("nodes 経由でも描けない tex はタイトル全体を生の文字列として出す", () => {
    let html = "";
    expect(() => {
      html = renderToStaticMarkup(
        <DocumentTitleText
          title="重要 $\href{javascript:alert(1)}{x}$ 資料"
          nodes={[
            { type: "text", text: "重要 " },
            { type: "mathInline", id: "m_1", tex: "\\href{javascript:alert(1)}{x}", display: "inline" },
            { type: "text", text: " 資料" },
          ]}
        />,
      );
    }).not.toThrow();
    expect(html).toBe("重要 $\\href{javascript:alert(1)}{x}$ 資料");
    expect(html).not.toContain("<a ");
  });
});
