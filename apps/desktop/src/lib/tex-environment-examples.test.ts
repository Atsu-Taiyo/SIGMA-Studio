import { describe, expect, it } from "vitest";

import { createMathRenderEnvironment } from "@/lib/math-environment";
import { createTranslator } from "@/lib/i18n";
import { createMathMacroSet } from "@/lib/math-macros";
import { convertLatexToMarkupCached, validateMathTex } from "@/lib/math-tex";
import {
  EXAMPLE_TEX_PREAMBLE,
  resolveExampleTexPreamble,
  resolveTexEnvironmentPreviewExamples,
  TEX_ENVIRONMENT_PREVIEW_EXAMPLES,
} from "@/lib/tex-environment-examples";

describe("TeX environment examples", () => {
  it("localizes descriptions without changing the TeX examples", () => {
    const english = resolveTexEnvironmentPreviewExamples(createTranslator("en", "tex"));
    expect(english[0]?.label).toBe("One character");
    expect(english.map(({ tex }) => tex)).toEqual(TEX_ENVIRONMENT_PREVIEW_EXAMPLES.map(({ tex }) => tex));
    expect(resolveExampleTexPreamble(createTranslator("en", "tex")))
      .toContain("% TeX commands used in this file");
    expect(EXAMPLE_TEX_PREAMBLE).toContain("% このファイルで使うTeXコマンド");
  });

  it.each(TEX_ENVIRONMENT_PREVIEW_EXAMPLES)("renders $label", ({ tex }) => {
    const macroSet = createMathMacroSet(EXAMPLE_TEX_PREAMBLE);
    const html = convertLatexToMarkupCached(tex, createMathRenderEnvironment(EXAMPLE_TEX_PREAMBLE));

    expect(validateMathTex(tex, macroSet)).toEqual([]);
    expect(html).toContain("sigma-doubleboxed");
    expect(html).not.toContain("math-unrendered");
  });

  it.each([
    [String.raw`\thickanswerbox{\text{ア}}`, "sigma-thickboxed"],
    [String.raw`\outerthickanswerbox{\text{ア}}`, "sigma-outerthick-doubleboxed"],
  ])("renders the preamble style %s", (tex, className) => {
    const macroSet = createMathMacroSet(EXAMPLE_TEX_PREAMBLE);
    const html = convertLatexToMarkupCached(tex, createMathRenderEnvironment(EXAMPLE_TEX_PREAMBLE));

    expect(validateMathTex(tex, macroSet)).toEqual([]);
    expect(html).toContain(className);
    expect(html).not.toContain("math-unrendered");
  });
});
