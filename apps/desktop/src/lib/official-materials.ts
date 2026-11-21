import { listOfficialTemplateMaterials } from "@/lib/official-templates";
import type { MaterialContent, MaterialItem } from "@/types/material";

export const OFFICIAL_TEX_BOX_MATERIALS: readonly MaterialItem[] = [];

export function isOfficialMaterial(material: MaterialItem): boolean {
  return material.source === "official" || material.id.startsWith("official_tex_box_");
}

/**
 * 利用者の素材の後ろに、同梱の公式素材 (公式テンプレートの部品) を並べる。保存先から
 * 「公式」を名乗って戻ってきたものは捨てる — 公式素材はいつも同梱の版だけを使う。
 */
export function mergeOfficialMaterials(userMaterials: readonly MaterialItem[]): MaterialItem[] {
  return [
    ...userMaterials.filter((material) => !isOfficialMaterial(material)),
    ...listOfficialTemplateMaterials(),
  ];
}

export function fitOfficialBoxToColumnWidth(content: MaterialContent, columnWidthPx: number): MaterialContent {
  void columnWidthPx;
  return content;
}
