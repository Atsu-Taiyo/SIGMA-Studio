import { describe, expect, it } from "vitest";

import { parseMaterialContent } from "@/lib/materials";
import { isOfficialMaterial } from "@/lib/official-materials";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import { parseTemplateItem } from "@/lib/templates";

import { isOfficialTemplate, listOfficialTemplateMaterials, listOfficialTemplates, OFFICIAL_TEMPLATE_WORKSPACE_ID } from "./index";

describe("official templates", () => {
  const templates = listOfficialTemplates();

  it("ships the reference-book and entrance-exam layouts", () => {
    expect(templates.map((template) => template.name)).toEqual([
      "青チャート型 例題ページ",
      "赤チャート型 例題ページ",
      "Focus Gold型 例題ページ",
      "共通テスト型 数学Ⅰ，数学A",
      "東大型 数学 問題冊子",
    ]);
    expect(templates.every((template) => template.workspaceId === OFFICIAL_TEMPLATE_WORKSPACE_ID && isOfficialTemplate(template))).toBe(true);
  });

  it.each(listOfficialTemplates().map((template) => [template.name, template] as const))("%s is a document the file schema accepts", (_name, template) => {
    const result = SigmaDocumentSchema.safeParse(template.document);
    expect(result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([]);
    // テンプレートとして保存・読み戻しできる形 (`parseTemplateItem`) でもある。
    expect(parseTemplateItem(template)?.id).toBe(template.id);
  });

  it("gives every block a unique id inside its template", () => {
    for (const template of templates) {
      const ids = JSON.stringify(template.document).match(/"id":"[^"]+"/g) ?? [];
      expect(new Set(ids).size, template.name).toBe(ids.length);
    }
  });

  it("does not treat a user template as official", () => {
    expect(isOfficialTemplate({ id: "template_abc" })).toBe(false);
  });
});

describe("official template materials", () => {
  const materials = listOfficialTemplateMaterials();

  it("offers each style's parts as official materials", () => {
    expect(materials.length).toBeGreaterThanOrEqual(15);
    expect(materials.every((material) => isOfficialMaterial(material))).toBe(true);
    expect(new Set(materials.map((material) => material.id)).size).toBe(materials.length);
    expect(materials.map((material) => material.name)).toEqual(expect.arrayContaining([
      "赤チャート型 CHART",
      "青チャート型 基本例題の見出し枠",
      "Focus Gold型 Focus",
      "共通テスト型 解答群",
      "東大型 大問",
    ]));
  });

  it.each(listOfficialTemplateMaterials().map((material) => [material.name, material] as const))("%s parses as material content", (_name, material) => {
    expect(parseMaterialContent(material.content)).not.toBeNull();
  });
});
