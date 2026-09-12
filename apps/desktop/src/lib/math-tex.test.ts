import { describe, expect, it } from "vitest";

import {
  convertLatexToMarkupCached,
  insertEditableMathTemplateTex,
  normalizeMathTextRuns,
  toEditableMathTemplateTex,
  toKatexPreviewTex,
  toMathLivePreviewTex,
  validateMathTex,
} from "@/lib/math-tex";
import { createMathMacroSet } from "@/lib/math-macros";
import { createMathRenderEnvironment, DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";

describe("math template TeX helpers", () => {
  it("materializes template slots as editable MathLive placeholders", () => {
    expect(toEditableMathTemplateTex("\\frac{#?}{#?}")).toBe("\\frac{\\placeholder{}}{\\placeholder{}}");
    expect(toEditableMathTemplateTex("\\sqrt[#?]{#?}")).toBe("\\sqrt[\\placeholder{}]{\\placeholder{}}");
  });

  it("inserts templates at the current cursor and lands on the first placeholder", () => {
    expect(insertEditableMathTemplateTex("a+b", 1, "\\frac{#?}{#?}")).toEqual({
      cursor: 7,
      tex: "a\\frac{\\placeholder{}}{\\placeholder{}}+b",
    });
  });

  it("lands after the inserted template when there is no placeholder token", () => {
    expect(insertEditableMathTemplateTex("x ", 2, "\\to")).toEqual({
      cursor: 5,
      tex: "x \\to",
    });
  });

  it("clamps invalid cursors before inserting", () => {
    expect(insertEditableMathTemplateTex("x", Number.NaN, "\\sqrt{#?}")).toEqual({
      cursor: 7,
      tex: "x\\sqrt{\\placeholder{}}",
    });
  });

  it("wraps Japanese math text runs in text mode", () => {
    expect(normalizeMathTextRuns("x=高さ")).toBe(String.raw`x=\text{高さ}`);
    expect(normalizeMathTextRuns(String.raw`\frac{高さ}{幅}`)).toBe(String.raw`\frac{\text{高さ}}{\text{幅}}`);
    expect(normalizeMathTextRuns("半径r=2")).toBe(String.raw`\text{半径}r=2`);
    expect(normalizeMathTextRuns(String.raw`\text{高さ}=x`)).toBe(String.raw`\text{高さ}=x`);
    expect(normalizeMathTextRuns(String.raw`x+\mbox{横幅}`)).toBe(String.raw`x+\mbox{横幅}`);
  });

  it("normalizes Japanese runs before MathLive preview placeholder rendering", () => {
    expect(toMathLivePreviewTex("x=高さ")).toBe(String.raw`x=\text{高さ}`);
    expect(toMathLivePreviewTex("\\placeholder{}")).toBe("\\placeholder[?]{\\square}");
  });

  it("renders KaTeX-only commands without changing MathLive-supported previews", () => {
    const tableTex = String.raw`\begin{array}{c}a\\\hline b\end{array}`;

    expect(convertLatexToMarkupCached("x^2", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__latex");
    expect(convertLatexToMarkupCached(String.raw`\dots`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("katex");
    expect(convertLatexToMarkupCached(String.raw`\dots`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("…");
    expect(convertLatexToMarkupCached(tableTex, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("hline");
    expect(convertLatexToMarkupCached(tableTex, DEFAULT_MATH_RENDER_ENVIRONMENT)).not.toContain("katex-error");
  });

  // 仕様変更: 囲みマクロは MathLive に渡るようになったので MathLive 経路 (`ML__box`) で描かれる。
  // 以前はマクロを渡していなかったため KaTeX (`frac-line`) に倒れており、同じ式が本文と
  // 編集中で別の組版になっていた (経路 D)。
  it("renders a double box nested inside another math command through MathLive", () => {
    const tex = String.raw`\frac{1}{\doubleboxed{a}}`;
    const html = convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(validateMathTex(tex)).toEqual([]);
    expect(html).toContain("ML__box");
    expect(html).not.toContain("katex");
    expect(html).toContain("sigma-doubleboxed");
    expect(html.match(/\bfbox\b|ML__box/g)).toHaveLength(1);
    expect(html).not.toContain("katex-error");
  });

  it.each([
    [String.raw`\thickboxed{a}`, "sigma-thickboxed"],
    [String.raw`\outerthickdoubleboxed{a}`, "sigma-outerthick-doubleboxed"],
  ])("renders the built-in math box %s through MathLive", (tex, className) => {
    const html = convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(validateMathTex(tex)).toEqual([]);
    expect(html).toContain(className);
    expect(html).toContain("ML__box");
    expect(html.match(/\bfbox\b|ML__box/g)).toHaveLength(1);
    expect(html).not.toContain("math-unrendered");
  });

  it("renders the Common Test choice marker through MathLive", () => {
    const tex = String.raw`\kyoutsuuchoice{0}`;
    const html = convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(validateMathTex(tex)).toEqual([]);
    expect(html).toContain("sigma-kyoutsuu-choice");
    expect(html).toContain("ML__bold");
    expect(html).not.toContain("math-unrendered");
  });

  it("keeps the Common Test choice marker when a KaTeX-only command triggers fallback", () => {
    const tex = String.raw`\kyoutsuuchoice{9}+\dots`;
    const html = convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(validateMathTex(tex)).toEqual([]);
    expect(html).toContain("katex");
    expect(html).toContain("sigma-kyoutsuu-choice");
    expect(html).not.toContain("katex-error");
  });

  it("renders file-scoped commands through the shared macro set", () => {
    const preamble = String.raw`\newcommand{\answerbox}[1]{\doubleboxed{\mathstrut\quad\raisebox{-0.04em}{$#1$}\quad}}`;
    const macros = createMathMacroSet(preamble);
    const tex = String.raw`\frac{1}{\answerbox{ア}}`;
    const html = convertLatexToMarkupCached(tex, createMathRenderEnvironment(preamble));

    expect(validateMathTex(tex, macros)).toEqual([]);
    expect(html).toContain("sigma-doubleboxed");
    expect(html).toContain("ア");
    expect(html).not.toContain("math-unrendered");
  });

  it("caps KaTeX dimensions from user-authored TeX", () => {
    const html = convertLatexToMarkupCached(String.raw`\dots+\rule{1em}{1000000000em}`, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(html).toContain("height:100em");
    expect(html).not.toContain("1000000000em");
  });

  it("accepts the union of MathLive and KaTeX commands", () => {
    const tableTex = String.raw`\begin{array}{c}a\\\hline b\end{array}+\dots`;

    expect(validateMathTex(tableTex)).toEqual([]);
    expect(validateMathTex(String.raw`\placeholder{}`)).toEqual([]);
    expect(validateMathTex(String.raw`\unknown{x}`)).not.toEqual([]);
    expect(toKatexPreviewTex(String.raw`\placeholder{}`)).toBe(String.raw`\square`);
  });
});
