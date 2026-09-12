import type { MaterialContent, MaterialItem } from "@/types/material";

export interface MaterialMetadataDraft {
  name: string;
  description: string;
  useCases: string;
  avoidWhen: string;
  aliases: string;
  visualConcepts: string;
}

export function createEmptyMaterialMetadataDraft(): MaterialMetadataDraft {
  return {
    name: "",
    description: "",
    useCases: "",
    avoidWhen: "",
    aliases: "",
    visualConcepts: "",
  };
}

export function materialToMetadataDraft(material: MaterialItem): MaterialMetadataDraft {
  return {
    name: material.name,
    description: material.description ?? "",
    useCases: (material.usage?.useCases ?? []).join("\n"),
    avoidWhen: (material.usage?.avoidWhen ?? []).join("\n"),
    aliases: (material.usage?.aliases ?? []).join(", "),
    visualConcepts: (material.visualConcepts ?? []).join(", "),
  };
}

export function materialMetadataDraftToInput(draft: MaterialMetadataDraft): Partial<MaterialItem> {
  const useCases = splitMaterialListInput(draft.useCases);
  const avoidWhen = splitMaterialListInput(draft.avoidWhen);
  const aliases = splitMaterialListInput(draft.aliases);
  return {
    description: draft.description,
    usage: {
      ...(useCases.length > 0 ? { useCases } : {}),
      ...(avoidWhen.length > 0 ? { avoidWhen } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    },
    visualConcepts: splitMaterialListInput(draft.visualConcepts),
  };
}

function splitMaterialListInput(input: string): string[] {
  return [...new Set(input
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

/**
 * 素材の検索語 (`visualConcepts`)。
 *
 * **これは表示文言ではなく、素材に保存されて検索の照合に使われる語彙。**
 * `materialMatchesQuery` / `materialMatchesConcepts` (lib/materials.ts) が、
 * 利用者や AI の書いた語をこの集合へ突き合わせる。UI 言語で訳して 1 言語に
 * すると、**もう一方の言語で保存された素材が永久に引けなくなる** (しかも
 * 保存済みデータなので後から直せない)。日英を両方積むのが正しい。
 *
 * 元コードが「箱」と "box" を並べていたのはそのため。他の語にも英語を揃えた。
 *
 * **この変更より前に保存された素材は和語しか持たない。** 英語で概念検索しても
 * 古い素材は出てこないが、保存済みデータなので遡って直せない。
 */
export function suggestVisualConceptsForMaterialContent(content: MaterialContent): string[] {
  const concepts = new Set<string>();
  for (const block of content.blocks) {
    if (block.type === "boxBlock") {
      concepts.add("箱");
      concepts.add("box");
    }
    if (block.type === "problem") {
      concepts.add("問題");
      concepts.add("problem");
    }
  }
  for (const shape of content.overlaySnapshot.shapes) {
    // shape.type 自体も機械値として積む ("arrow" / "tableShape" …)。
    concepts.add(shape.type);
    // arrow / line / image は `shape.type` がそのまま英語なので、和語だけ足せばよい。
    // tableShape / graph2dShape は英単語ではないので英語も明示する。
    if (shape.type === "arrow") concepts.add("矢印");
    if (shape.type === "line") concepts.add("線");
    if (shape.type === "tableShape") { concepts.add("表"); concepts.add("table"); }
    if (shape.type === "graph2dShape") { concepts.add("グラフ"); concepts.add("graph"); }
    if (shape.type === "graph3dShape") { concepts.add("3D教材"); concepts.add("3D material"); }
    if (shape.type === "image") concepts.add("画像");
  }
  return [...concepts];
}

export function cloneMaterialContentForEditing(content: MaterialContent): MaterialContent {
  return JSON.parse(JSON.stringify(content)) as MaterialContent;
}
