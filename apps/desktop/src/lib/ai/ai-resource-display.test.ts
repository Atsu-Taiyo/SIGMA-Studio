import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import { resolveAiResourceDisplayMetadata } from "./ai-resource-display";

const OFFICIAL_IMAGE = {
  id: "official-image-material",
  origin: "official",
  title: "画像からSigma Studio教材を作成",
  bundledTitle: "画像からSigma Studio教材を作成",
  description: "canonical description",
  bundledDescription: "canonical description",
  tags: ["画像", "教材再構成", "OCR", "図形"],
};

describe("resolveAiResourceDisplayMetadata", () => {
  it("resolves managed official metadata at render time without mutating the canonical input", () => {
    const canonical = structuredClone(OFFICIAL_IMAGE);
    expect(resolveAiResourceDisplayMetadata(OFFICIAL_IMAGE, createTranslator("en", "ai"))).toEqual({
      title: "Create Sigma Studio material from an image",
      description: "Use this to reconstruct images, photos, screenshots, and handwritten sketches as editable Sigma Studio material with text, formulas, tables, graphs, shapes, and annotations.",
      tags: ["image", "material reconstruction", "OCR", "shape"],
    });
    expect(resolveAiResourceDisplayMetadata(OFFICIAL_IMAGE, createTranslator("ja", "ai")).title)
      .toBe("画像からSigma Studio教材を作成");
    expect(OFFICIAL_IMAGE).toEqual(canonical);
  });

  it("keeps user-edited official metadata and ordinary resources verbatim", () => {
    const edited = { ...OFFICIAL_IMAGE, title: "My image workflow", description: "My rules" };
    expect(resolveAiResourceDisplayMetadata(edited, createTranslator("en", "ai"))).toMatchObject({
      title: "My image workflow",
      description: "My rules",
    });
    const custom = { id: "skill-custom", title: "教材の名前", description: "本文", tags: ["数学"] };
    expect(resolveAiResourceDisplayMetadata(custom, createTranslator("en", "ai"))).toEqual({
      title: custom.title,
      description: custom.description,
      tags: custom.tags,
    });
  });
});
