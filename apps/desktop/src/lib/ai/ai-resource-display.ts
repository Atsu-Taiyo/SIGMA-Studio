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

const OFFICIAL_DISPLAY_KEYS = {
  "official-image-material": {
    title: "desktop.resource.officialImageTitle",
    description: "desktop.resource.officialImageDescription",
    tags: [
      "desktop.resource.officialImageTags.image",
      "desktop.resource.officialImageTags.material",
      null,
      "desktop.resource.officialImageTags.shape",
    ],
  },
  "official-graph": {
    title: "desktop.resource.officialGraphTitle",
    description: "desktop.resource.officialGraphDescription",
    tags: [
      "desktop.resource.officialGraphTags.graph",
      null,
      "desktop.resource.officialGraphTags.function",
      "desktop.resource.officialGraphTags.coordinates",
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
