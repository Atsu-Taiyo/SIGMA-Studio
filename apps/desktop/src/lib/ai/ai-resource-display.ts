import type { Translate } from "@/lib/i18n";

interface AiResourceDisplayInput {
  id: string;
  title: string;
  description: string;
  tags: string[];
  origin?: string;
  bundledTitle?: string;
  bundledDescription?: string;
}

export interface AiResourceDisplayMetadata {
  title: string;
  description: string;
  tags: string[];
}

/**
 * 公式skillのid → 表示用の翻訳キー。tags はmanifestのtagsと同じ並びで、翻訳しない語
 * (OCR・Graph2D・3Dなど)は null のまま元の値を出す。新しい公式skillを足すときは
 * electron/ai-resource-store.ts の定義と、ja/en の `desktop.resource.officialSkills` を揃える。
 */
const OFFICIAL_DISPLAY_KEYS = {
  "official-svg-figure": {
    title: "desktop.resource.officialSkills.svgFigure.title",
    description: "desktop.resource.officialSkills.svgFigure.description",
    tags: [
      "desktop.resource.officialSkills.svgFigure.tags.svg",
      "desktop.resource.officialSkills.svgFigure.tags.diagram",
      "desktop.resource.officialSkills.svgFigure.tags.illustration",
      "desktop.resource.officialSkills.svgFigure.tags.artwork",
    ],
  },
  "official-image-material": {
    title: "desktop.resource.officialSkills.imageMaterial.title",
    description: "desktop.resource.officialSkills.imageMaterial.description",
    tags: [
      "desktop.resource.officialSkills.imageMaterial.tags.image",
      "desktop.resource.officialSkills.imageMaterial.tags.material",
      null,
      "desktop.resource.officialSkills.imageMaterial.tags.diagram",
    ],
  },
  "official-graph": {
    title: "desktop.resource.officialSkills.graph.title",
    description: "desktop.resource.officialSkills.graph.description",
    tags: [
      "desktop.resource.officialSkills.graph.tags.graph",
      null,
      "desktop.resource.officialSkills.graph.tags.function",
      "desktop.resource.officialSkills.graph.tags.coordinates",
    ],
  },
  "official-graph3d": {
    title: "desktop.resource.officialSkills.graph3d.title",
    description: "desktop.resource.officialSkills.graph3d.description",
    tags: [
      null,
      "desktop.resource.officialSkills.graph3d.tags.solid",
      "desktop.resource.officialSkills.graph3d.tags.revolution",
      "desktop.resource.officialSkills.graph3d.tags.section",
    ],
  },
  "official-problem": {
    title: "desktop.resource.officialSkills.problem.title",
    description: "desktop.resource.officialSkills.problem.description",
    tags: [
      "desktop.resource.officialSkills.problem.tags.problem",
      "desktop.resource.officialSkills.problem.tags.answer",
      "desktop.resource.officialSkills.problem.tags.explanation",
      "desktop.resource.officialSkills.problem.tags.hint",
    ],
  },
  "official-body": {
    title: "desktop.resource.officialSkills.body.title",
    description: "desktop.resource.officialSkills.body.description",
    tags: [
      "desktop.resource.officialSkills.body.tags.body",
      "desktop.resource.officialSkills.body.tags.formula",
      "desktop.resource.officialSkills.body.tags.list",
      "desktop.resource.officialSkills.body.tags.box",
    ],
  },
  "official-table": {
    title: "desktop.resource.officialSkills.table.title",
    description: "desktop.resource.officialSkills.table.description",
    tags: [
      "desktop.resource.officialSkills.table.tags.table",
      "desktop.resource.officialSkills.table.tags.variation",
      "desktop.resource.officialSkills.table.tags.cell",
    ],
  },
  "official-page-layout": {
    title: "desktop.resource.officialSkills.pageLayout.title",
    description: "desktop.resource.officialSkills.pageLayout.description",
    tags: [
      "desktop.resource.officialSkills.pageLayout.tags.page",
      "desktop.resource.officialSkills.pageLayout.tags.columns",
      "desktop.resource.officialSkills.pageLayout.tags.pageBreak",
      "desktop.resource.officialSkills.pageLayout.tags.margins",
    ],
  },
  "official-proofreading": {
    title: "desktop.resource.officialSkills.proofreading.title",
    description: "desktop.resource.officialSkills.proofreading.description",
    tags: [
      "desktop.resource.officialSkills.proofreading.tags.proofreading",
      "desktop.resource.officialSkills.proofreading.tags.rephrasing",
      "desktop.resource.officialSkills.proofreading.tags.notation",
    ],
  },
  "official-shape": {
    title: "desktop.resource.officialSkills.shape.title",
    description: "desktop.resource.officialSkills.shape.description",
    tags: [
      "desktop.resource.officialSkills.shape.tags.shape",
      "desktop.resource.officialSkills.shape.tags.arrow",
      "desktop.resource.officialSkills.shape.tags.annotation",
      "desktop.resource.officialSkills.shape.tags.callout",
    ],
  },
  "official-material-library": {
    title: "desktop.resource.officialSkills.materialLibrary.title",
    description: "desktop.resource.officialSkills.materialLibrary.description",
    tags: [
      "desktop.resource.officialSkills.materialLibrary.tags.material",
      "desktop.resource.officialSkills.materialLibrary.tags.pastDocuments",
      "desktop.resource.officialSkills.materialLibrary.tags.search",
    ],
  },
  "official-document-management": {
    title: "desktop.resource.officialSkills.documentManagement.title",
    description: "desktop.resource.officialSkills.documentManagement.description",
    tags: [
      "desktop.resource.officialSkills.documentManagement.tags.documents",
      "desktop.resource.officialSkills.documentManagement.tags.folders",
      "desktop.resource.officialSkills.documentManagement.tags.organize",
    ],
  },
} as const;

/**
 * 公式skillのAI向けmetadataはmanifest上のcanonical値を保ち、未編集の項目だけを
 * 描画時に現在のUI localeへ置き換える。ユーザーがtitle/descriptionを編集済みなら
 * その値を優先し、翻訳表示を保存データやAI promptへ逆流させない。
 */
export function resolveAiResourceDisplayMetadata(
  resource: AiResourceDisplayInput,
  t: Translate<"ai">,
): AiResourceDisplayMetadata {
  if (resource.origin !== "official") {
    return { title: resource.title, description: resource.description, tags: resource.tags };
  }
  const keys = OFFICIAL_DISPLAY_KEYS[resource.id as keyof typeof OFFICIAL_DISPLAY_KEYS];
  if (!keys) {
    return { title: resource.title, description: resource.description, tags: resource.tags };
  }
  const titleManaged = resource.bundledTitle === undefined || resource.title === resource.bundledTitle;
  const descriptionManaged = resource.bundledDescription === undefined
    || resource.description === resource.bundledDescription;
  return {
    title: titleManaged ? t(keys.title) : resource.title,
    description: descriptionManaged ? t(keys.description) : resource.description,
    tags: resource.tags.map((tag, index) => {
      const key = keys.tags[index];
      return key ? t(key) : tag;
    }),
  };
}
