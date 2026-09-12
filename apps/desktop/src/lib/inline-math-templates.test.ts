import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  INLINE_MATH_TEMPLATE_GROUPS,
  ORDERED_INLINE_MATH_TEMPLATE_GROUPS,
} from "@/lib/inline-math-templates";
import { toEditableMathTemplateTex, validateMathTex } from "@/lib/math-tex";

const ALL_TEMPLATES = INLINE_MATH_TEMPLATE_GROUPS.flatMap((group) => (
  group.templates.map((template) => ({ ...template, groupId: group.id }))
));

function findTemplate(groupId: string, templateId: string): string {
  const template = ALL_TEMPLATES.find((candidate) => (
    candidate.groupId === groupId && candidate.id === templateId
  ));
  if (!template) {
    throw new Error(`template not found: ${groupId}/${templateId}`);
  }
  return template.tex;
}

describe("inline math template palette", () => {
  it("keeps group and template ids unique", () => {
    const groupIds = INLINE_MATH_TEMPLATE_GROUPS.map((group) => group.id);
    expect(new Set(groupIds).size).toBe(groupIds.length);

    const templateIds = ALL_TEMPLATES.map((template) => template.id);
    expect(new Set(templateIds).size).toBe(templateIds.length);
  });

  it("shows every group exactly once in the palette order", () => {
    expect(ORDERED_INLINE_MATH_TEMPLATE_GROUPS.map((group) => group.id).sort())
      .toEqual(INLINE_MATH_TEMPLATE_GROUPS.map((group) => group.id).sort());
  });

  // パレットのボタンはTeXを書かずに数式を組み立てるための唯一の入口。壊れたTeXを
  // 混ぜると、押した瞬間に数式が「読めない式」になって編集画面から復旧できない。
  it("inserts TeX that the document renderers accept", () => {
    const invalid = ALL_TEMPLATES.flatMap((template) => (
      validateMathTex(toEditableMathTemplateTex(template.tex))
        .map((issue) => ({ id: `${template.groupId}/${template.id}`, issue }))
    ));
    expect(invalid).toEqual([]);
  });

  it("offers 順列・組合せ so nCr / nPr / nHr need no TeX typing", () => {
    const group = INLINE_MATH_TEMPLATE_GROUPS.find((candidate) => candidate.id === "combinatorics");
    expect(group).toBeDefined();
    // 見出しは辞書が持つ (`shape.mathTemplateGroup.<id>`)。id から引けることを見る。
    expect(createTranslator("ja", "shape")("mathTemplateGroup.combinatorics")).toBe("順列・組合せ");

    expect(findTemplate("combinatorics", "combination")).toBe("_{#?}\\mathrm{C}_{#?}");
    expect(findTemplate("combinatorics", "permutation")).toBe("_{#?}\\mathrm{P}_{#?}");
    expect(findTemplate("combinatorics", "repeated-combination")).toBe("_{#?}\\mathrm{H}_{#?}");
  });

  // 左下の添字に `{}` を前置しないこと。MathLiveが往復のたびに末尾へ `{}` を
  // 3個ずつ吐き足すため、編集して閉じるたびにTeXが伸び続ける。
  it("leaves the leading subscript without an empty group", () => {
    for (const id of ["combination", "permutation", "repeated-combination"]) {
      const tex = findTemplate("combinatorics", id);
      expect(tex.startsWith("_{")).toBe(true);
      expect(tex).not.toContain("{}");
    }
  });
});
