import { validateLatex } from "mathlive/ssr";
import { describe, expect, it } from "vitest";

import { validateMathTex } from "@/lib/math-tex";
import { createTranslator } from "@/lib/i18n";
import {
  filterTexCommandReferences,
  resolveTexCommandReferences,
  TEX_COMMAND_REFERENCES,
} from "@/lib/tex-command-reference";

describe("TeX command reference", () => {
  it("keeps ids unique and every preview valid for MathLive", () => {
    expect(TEX_COMMAND_REFERENCES.length).toBeGreaterThanOrEqual(320);
    expect(new Set(TEX_COMMAND_REFERENCES.map((reference) => reference.id)).size)
      .toBe(TEX_COMMAND_REFERENCES.length);

    const invalidPreviews = TEX_COMMAND_REFERENCES.flatMap((reference) => {
      const issues = ["doubleboxed", "kyoutsuuchoice", "outerthickdoubleboxed", "thickboxed"].includes(reference.id)
        ? validateMathTex(reference.previewTex)
        : validateLatex(reference.previewTex);
      return issues.map((issue) => ({ id: reference.id, issue }));
    });
    expect(invalidPreviews).toEqual([]);
  });

  it("searches commands, Japanese labels, categories, and short aliases", () => {
    expect(filterTexCommandReferences("frac").map((reference) => reference.id)).toContain("fraction");
    expect(filterTexCommandReferences("分数").map((reference) => reference.id)).toContain("fraction");
    expect(filterTexCommandReferences("ギリシャ文字").map((reference) => reference.id)).toContain("gamma");
    expect(filterTexCommandReferences("￥ga").map((reference) => reference.id)).toContain("gamma");
    expect(filterTexCommandReferences(String.raw`\text`).map((reference) => reference.id)).toContain("text");
    expect(filterTexCommandReferences(String.raw`\begin`).length).toBeGreaterThanOrEqual(15);
    expect(filterTexCommandReferences("幾何").map((reference) => reference.id)).toContain("angle");
    expect(filterTexCommandReferences("確率・統計").map((reference) => reference.id)).toContain("expectation");
    expect(filterTexCommandReferences("自然数").map((reference) => reference.id)).toContain("natural-numbers");
    expect(filterTexCommandReferences("二重枠").map((reference) => reference.id)).toContain("doublebox");
    expect(filterTexCommandReferences(String.raw`\doubleboxed`).map((reference) => reference.id)).toContain("doubleboxed");
    expect(filterTexCommandReferences("外線").map((reference) => reference.id)).toContain("outerthickdoubleboxed");
    expect(filterTexCommandReferences("共通テスト").map((reference) => reference.id)).toContain("kyoutsuuchoice");
    expect(filterTexCommandReferences(String.raw`\kyoutsuuchoice`).map((reference) => reference.id)).toContain("kyoutsuuchoice");
    expect(filterTexCommandReferences(String.raw`\rightleftharpoons`).map((reference) => reference.id)).toContain("equilibrium-arrows");
    expect(filterTexCommandReferences("フラクトゥール").map((reference) => reference.id)).toContain("mathfrak");
    expect(filterTexCommandReferences("該当なし")).toEqual([]);
  });

  it("resolves English labels/categories and searches English names", () => {
    const t = createTranslator("en", "tex");
    const references = resolveTexCommandReferences(t);
    const fraction = references.find((reference) => reference.id === "fraction");

    expect(fraction).toMatchObject({ label: "Fraction", category: "Basics" });
    expect(filterTexCommandReferences("Greek letters", t).map((reference) => reference.id)).toContain("gamma");
    expect(filterTexCommandReferences("natural numbers", t).map((reference) => reference.id)).toContain("natural-numbers");
    expect(filterTexCommandReferences(String.raw`\rightleftharpoons`, t).map((reference) => reference.id))
      .toContain("equilibrium-arrows");
    expect(references.find((reference) => reference.id === "itembox")).toMatchObject({
      command: String.raw`\itembox{Key point}{Body}`,
      previewTex: String.raw`\boxed{\text{[Key point] Body}}`,
    });
    expect(references.find((reference) => reference.id === "text")?.command).toBe(String.raw`\text{Condition}`);
    expect(references.find((reference) => reference.id === "overbrace")?.previewTex)
      .toBe(String.raw`\overbrace{a+b+c}^{3\text{ terms}}`);
    expect(references.filter((reference) => /[぀-ヿ一-鿿]/u.test(`${reference.command} ${reference.previewTex}`)))
      .toEqual([]);
  });
});
