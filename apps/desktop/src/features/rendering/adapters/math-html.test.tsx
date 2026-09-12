// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createMathHtmlElement } from "@/components/tiptap/inline-math-extension";
import { applyMathTypesetStyle } from "@/features/rendering/core";
import { createMathRenderEnvironment, type MathRenderEnvironment } from "@/lib/math-environment";

import { renderMathHtml } from "./math-html";
import { MathEnvironmentValueProvider, MathPreview } from "./react";
import { exportOverlaySvg } from "./svg";

/**
 * 「同じ TeX が面ごとに別の組版で描かれる」の再発ガード。plan.md の再発経路との対応:
 *
 * - A: 静的バックエンドが 2 系統 (MathLive / KaTeX) で既定 mathstyle が違う
 * - B: 静的経路だけ TeX を書き換えていた (`\frac` → `\dfrac`)
 * - C: 描画環境がオプション引数で呼び出し側から落とせた
 * - D: 静的 MathLive にマクロが渡らず、マクロを使う式が必ず KaTeX (textstyle) に倒れていた
 */

const PREAMBLE = String.raw`\newcommand{\RR}{\mathbb{R}}`;
const DISPLAYSTYLE_ENVIRONMENT = createMathRenderEnvironment("", "uniform");
const TEXTSTYLE_ENVIRONMENT = createMathRenderEnvironment("", "texDefault");
const PREAMBLE_ENVIRONMENT = createMathRenderEnvironment(PREAMBLE, "uniform");

/** 現在の経路が MathLive / KaTeX どちらでも、組版スタイルが効いていなければ落ちる式を並べる。 */
const FORMULAS = [
  // MathLive 経路。入れ子分数は `\dfrac` 書き換えの有無が markup に出る (経路 B)。
  String.raw`\frac{x}{\frac{a}{b}}`,
  String.raw`\sum_{i=1}^n i`,
  // `\dots` は MathLive が描けないので KaTeX へ落ちる (経路 A)。
  String.raw`1,\dots,n+\frac{a}{b}`,
  // Sigma 自前の囲みマクロ。マクロを渡さないと KaTeX へ落ちていた (経路 D)。
  String.raw`\thickboxed{\sum_{i=1}^n i}`,
];

describe("static math rendering carries one typeset style", () => {
  it.each(FORMULAS)("is idempotent under an explicit displaystyle prefix for %s", (tex) => {
    expect(renderMathHtml(applyMathTypesetStyle(tex, "displaystyle"), DISPLAYSTYLE_ENVIRONMENT))
      .toBe(renderMathHtml(tex, DISPLAYSTYLE_ENVIRONMENT));
  });

  it.each(FORMULAS)("is idempotent under an explicit textstyle prefix for %s", (tex) => {
    expect(renderMathHtml(applyMathTypesetStyle(tex, "textstyle"), TEXTSTYLE_ENVIRONMENT))
      .toBe(renderMathHtml(tex, TEXTSTYLE_ENVIRONMENT));
  });

  it.each(FORMULAS)("actually changes the markup between the two styles for %s", (tex) => {
    // 前置が「効いていない」実装 (旧 KaTeX 既定 / 旧 MathLive 既定) ならここが同一になる。
    expect(renderMathHtml(tex, TEXTSTYLE_ENVIRONMENT))
      .not.toBe(renderMathHtml(tex, DISPLAYSTYLE_ENVIRONMENT));
  });

  it("renders the built-in box macros without falling back to KaTeX", () => {
    const html = renderMathHtml(String.raw`\thickboxed{\sum_{i=1}^n i}`, DISPLAYSTYLE_ENVIRONMENT);

    expect(html).toContain("ML__box");
    expect(html).not.toContain("katex");
  });

  it("keeps big operators large after the sanitizer runs", () => {
    // `large-op` を `SAFE_CLASS_TOKENS` に足し忘れると、KaTeX 経路の `\sum` だけが
    // 小さいまま残る (修正が黙って半分しか効かない)。
    const html = renderMathHtml(String.raw`\sum_{i=1}^n i+\dots`, DISPLAYSTYLE_ENVIRONMENT);

    expect(html).toContain("katex");
    expect(html).toContain("large-op");
  });
});

describe("static math rendering never rewrites the source TeX", () => {
  it("keeps a nested fraction distinct from its dfrac spelling", () => {
    // 旧実装は `uniform` のとき `\frac` を `\dfrac` へ書き換えていたため、この 2 つが一致していた。
    // 一致する = 静的側だけ TeX を作り変えている = math-field と食い違う (経路 B)。
    expect(renderMathHtml(String.raw`\frac{x}{\frac{a}{b}}`, DISPLAYSTYLE_ENVIRONMENT))
      .not.toBe(renderMathHtml(String.raw`\dfrac{x}{\dfrac{a}{b}}`, DISPLAYSTYLE_ENVIRONMENT));
  });

  it("gives an explicit dfrac the same markup in both typeset styles", () => {
    // 著者が明示したサイズは組版スタイルに関係なく保たれる。
    expect(renderMathHtml(String.raw`\dfrac{a}{b}`, TEXTSTYLE_ENVIRONMENT))
      .toBe(renderMathHtml(String.raw`\dfrac{a}{b}`, DISPLAYSTYLE_ENVIRONMENT));
  });
});

describe("the document macros reach every static outlet", () => {
  const tex = String.raw`\frac{a}{b}\RR`;

  it("expands a preamble macro instead of falling back to raw TeX", () => {
    const html = renderMathHtml(tex, PREAMBLE_ENVIRONMENT);

    expect(html).not.toContain("data-math-unrendered");
    expect(html).not.toContain("RR");
    expect(renderMathHtml(tex, DISPLAYSTYLE_ENVIRONMENT)).not.toBe(html);
  });

  it.each([
    ["displaystyle", PREAMBLE_ENVIRONMENT],
    ["textstyle", createMathRenderEnvironment(PREAMBLE, "texDefault")],
  ] as Array<[string, MathRenderEnvironment]>)(
    "produces identical markup from every outlet (%s)",
    (_label, environment) => {
      const expected = renderMathHtml(tex, environment);

      // Tiptap NodeView / clipboard 経路。
      const element = createMathHtmlElement(tex, false, environment);
      expect(typeof element === "string" ? element : element.innerHTML).toBe(expected);

      // React の静的描画 (本文・印刷・公開ビューア)。
      expect(renderToStaticMarkup(
        <MathEnvironmentValueProvider environment={environment}>
          <MathPreview tex={tex} />
        </MathEnvironmentValueProvider>,
      )).toContain(expected);

      // SVG 書き出し (図形テキスト)。
      const svg = exportOverlaySvg([{
        id: "shape_math_outlet",
        type: "text",
        x: 0,
        y: 0,
        props: {
          w: 320,
          h: 80,
          color: "#111111",
          size: "m",
          blocks: [{
              type: "paragraph", id: "math_html_test_17",
              children: [{ type: "mathInline", id: "math_outlet", tex, display: "inline" }],
            }],
        },
      }], {}, { width: 400, height: 200 }, { mathEnvironment: environment });
      expect(svg).toContain(expected);
    },
  );
});
