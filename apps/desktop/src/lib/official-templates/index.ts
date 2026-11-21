import { createEmptyOverlaySnapshot } from "@/features/document";
import type { MaterialItem } from "@/types/material";
import type { TemplateItem } from "@/types/template";

import { OFFICIAL_TEMPLATE_UPDATED_AT, type OfficialTemplateBuild } from "./build";
import { createChartBlueTemplate } from "./chart-blue";
import { createChartRedTemplate } from "./chart-red";
import { createFocusGoldTemplate } from "./focus-gold";
import { createKyotsuTestTemplate } from "./kyotsu-test";
import { createTodaiTemplate } from "./todai";

/**
 * アプリに同梱するテンプレート。利用者のテンプレートと同じ `TemplateItem` の形で返し、
 * ギャラリーの「公式」タブに並べる。保存先は持たないので、名前の変更・削除はできない。
 * テンプレートの中の部品 (例題の見出し枠・指針・解答群など) は公式素材としても返す。
 */
export const OFFICIAL_TEMPLATE_WORKSPACE_ID = "official";

const OFFICIAL_TEMPLATE_ID_PREFIX = "official_template_";
/** `isOfficialMaterial` (`@/lib/official-materials`) はこの接頭辞と `source: "official"` で見分ける。 */
const OFFICIAL_MATERIAL_ID_PREFIX = "official_material_";

interface OfficialTemplateDefinition {
  key: string;
  name: string;
  create(): OfficialTemplateBuild;
}

const DEFINITIONS: readonly OfficialTemplateDefinition[] = [
  { key: "chart_blue", name: "青チャート型 例題ページ", create: createChartBlueTemplate },
  { key: "chart_red", name: "赤チャート型 例題ページ", create: createChartRedTemplate },
  { key: "focus_gold", name: "Focus Gold型 例題ページ", create: createFocusGoldTemplate },
  { key: "kyotsu_test", name: "共通テスト型 数学Ⅰ，数学A", create: createKyotsuTestTemplate },
  { key: "todai", name: "東大型 数学 問題冊子", create: createTodaiTemplate },
];

let cache: { templates: TemplateItem[]; materials: MaterialItem[] } | null = null;

function build() {
  cache ??= (() => {
    const built = DEFINITIONS.map((definition) => ({ definition, build: definition.create() }));
    return {
      templates: built.map(({ definition, build }) => ({
        version: 1 as const,
        id: `${OFFICIAL_TEMPLATE_ID_PREFIX}${definition.key}`,
        workspaceId: OFFICIAL_TEMPLATE_WORKSPACE_ID,
        name: definition.name,
        document: build.document,
        createdAt: OFFICIAL_TEMPLATE_UPDATED_AT,
        updatedAt: OFFICIAL_TEMPLATE_UPDATED_AT,
      })),
      materials: built.flatMap(({ build }) => build.parts.map((part): MaterialItem => ({
        version: 1,
        id: `${OFFICIAL_MATERIAL_ID_PREFIX}${part.key}`,
        name: part.name,
        source: "official",
        description: part.description,
        tags: part.tags,
        usage: { useCases: [part.description], aliases: part.tags },
        content: { blocks: part.blocks, overlaySnapshot: createEmptyOverlaySnapshot() },
        createdAt: OFFICIAL_TEMPLATE_UPDATED_AT,
        updatedAt: OFFICIAL_TEMPLATE_UPDATED_AT,
      }))),
    };
  })();
  return cache;
}

export function listOfficialTemplates(): TemplateItem[] {
  return build().templates;
}

export function listOfficialTemplateMaterials(): MaterialItem[] {
  return build().materials;
}

export function isOfficialTemplate(template: Pick<TemplateItem, "id">): boolean {
  return template.id.startsWith(OFFICIAL_TEMPLATE_ID_PREFIX);
}
