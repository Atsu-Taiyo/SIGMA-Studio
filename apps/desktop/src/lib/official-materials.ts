import type { MaterialContent, MaterialItem } from "@/types/material";

export const OFFICIAL_TEX_BOX_MATERIALS: readonly MaterialItem[] = [];

export function isOfficialMaterial(material: MaterialItem): boolean {
  return material.source === "official" || material.id.startsWith("official_tex_box_");
}

export function mergeOfficialMaterials(userMaterials: readonly MaterialItem[]): MaterialItem[] {
  return userMaterials.filter((material) => !isOfficialMaterial(material));
}

export function fitOfficialBoxToColumnWidth(content: MaterialContent, columnWidthPx: number): MaterialContent {
  void columnWidthPx;
  return content;
}
