import { Window } from "happy-dom";
import { convertLatexToMarkup } from "mathlive";
import { describe, expect, it } from "vitest";

import { createMathRenderEnvironment } from "@/lib/math-environment";
import { convertLatexToMarkupCached, validateMathTex } from "@/lib/math-tex";
import { renderMathHtml } from "@/features/rendering/adapters/math-html";
import { SIGMA_MATHLIVE_EDITOR_MACROS } from "@/lib/math-macros";
import { withMathLiveDefaultMacros } from "@/lib/mathlive-default-macros";

const PREAMBLE = String.raw`\newcommand{\maru}[1]{\textcircled{\scriptsize#1}}`;

describe("textcircled in a document's TeX preamble", () => {
  it.each([String.raw`\maru2`, String.raw`\maru{12}`, String.raw`\frac{\maru1}{\maru2}`])(
    "retains the native KaTeX circle and scriptsize for %s in static output",
    (tex) => {
      const environment = createMathRenderEnvironment(PREAMBLE);
      const raw = convertLatexToMarkupCached(tex, environment);
      const sanitized = renderMathHtml(tex, environment);
      expect(validateMathTex(tex, environment.macroSet)).toEqual([]);
      expect(raw).toContain("katex-accent");
      expect(raw).toContain("accent-body accent-full");
      expect(raw).toContain("katex-sizing reset-size6 size3");
      expect(sanitized).toContain("accent-body accent-full");
      expect(sanitized).not.toContain("ML__notation");
      expect(sanitized).not.toContain("ML__error");
      expect(sanitized).not.toContain("data-math-unrendered");
    },
  );

  it.each(["12", "AB", "ア", "解答"])("keeps the circled label %s and a valid enclosure", (label) => {
    const environment = createMathRenderEnvironment(PREAMBLE);
    const markup = renderMathHtml(`\\textcircled{${label}}`, environment);
    const window = new Window();
    try {
      window.document.body.innerHTML = markup;
      expect(window.document.querySelector(".accent-body.accent-full")?.textContent).toBe("◯");
      expect(window.document.querySelector(".katex-html")?.textContent).toContain(label);
      expect(window.document.querySelector(".ML__error")).toBeNull();
    } finally {
      void window.happyDOM.close();
    }
  });

  it("offers a thin native editing enclosure without replacing static textcircled", () => {
    const environment = createMathRenderEnvironment(PREAMBLE);
    const markup = convertLatexToMarkup(String.raw`\maru2`, {
      macros: withMathLiveDefaultMacros({ ...SIGMA_MATHLIVE_EDITOR_MACROS, ...environment.macroSet.mathLiveMacros }),
    });
    expect(markup).toContain("ML__notation");
    expect(markup).toContain("border:1px solid currentColor");
    expect(markup).toContain("font-size: 70%");
    expect(markup).toContain("ML__cmr");
    expect(markup).not.toContain("ML__error");
  });

  it("keeps the native KaTeX circle's full-width layout when another command needs fallback", () => {
    const environment = createMathRenderEnvironment(PREAMBLE);
    const markup = renderMathHtml(String.raw`\maru2+\dots`, environment);
    const window = new Window();
    try {
      window.document.body.innerHTML = markup;
      expect(window.document.querySelector(".katex")).not.toBeNull();
      const circle = window.document.querySelector(".accent-body.accent-full");
      expect(circle?.textContent).toBe("◯");
      expect(window.document.querySelector(".katex-sizing.size3")?.textContent).toBe("2");
      expect(markup).not.toContain("data-math-unrendered");
    } finally {
      void window.happyDOM.close();
    }
  });

  it("preserves a document's own textcircled definition", () => {
    const environment = createMathRenderEnvironment(String.raw`\newcommand{\textcircled}[1]{\boxed{#1}}`);
    const markup = renderMathHtml(String.raw`\textcircled{2}`, environment);
    expect(markup).toContain("ML__box");
    expect(markup).not.toContain("ML__notation");
  });
});
