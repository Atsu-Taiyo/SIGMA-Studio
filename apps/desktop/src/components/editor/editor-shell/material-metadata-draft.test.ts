import { describe, expect, it } from "vitest";

import { createBoxBlock } from "@/lib/box-blocks";
import type { MaterialContent, MaterialItem } from "@/types/material";
import {
  cloneMaterialContentForEditing,
  createEmptyMaterialMetadataDraft,
  materialMetadataDraftToInput,
  materialToMetadataDraft,
  suggestVisualConceptsForMaterialContent,
} from "./material-metadata-draft";

describe("material metadata drafts", () => {
  it("round-trips persisted search vocabulary while deduplicating comma and newline input", () => {
    const material: MaterialItem = {
      id: "material", version: 1, name: "name", description: "description",
      usage: { useCases: ["lesson", "review"], avoidWhen: ["other"], aliases: ["box", "箱"] },
      visualConcepts: ["box", "箱"],
      content: { blocks: [], overlaySnapshot: { version: 1, shapes: [], assets: {} } },
      createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
    };
    const draft = materialToMetadataDraft(material);
    expect(draft).toEqual({
      name: "name", description: "description", useCases: "lesson\nreview", avoidWhen: "other",
      aliases: "box, 箱", visualConcepts: "box, 箱",
    });
    expect(materialMetadataDraftToInput({
      ...draft, useCases: " lesson, review、lesson\n\n", aliases: "box、箱, box", visualConcepts: "box, 箱\nbox",
    })).toEqual({
      description: material.description, usage: material.usage, visualConcepts: material.visualConcepts,
    });
  });

  it("clears editable metadata explicitly without allowing the draft name to override the save request", () => {
    const draft = { ...createEmptyMaterialMetadataDraft(), name: "unsanitized name", description: "  description  " };
    expect(materialMetadataDraftToInput(draft)).toEqual({ description: "  description  ", usage: {}, visualConcepts: [] });
  });

  it("suggests both languages for persisted concepts and creates an independent editing copy", () => {
    const original: MaterialContent = {
      blocks: [createBoxBlock("fancybox")],
      overlaySnapshot: {
        version: 1,
        shapes: [{ id: "image", type: "image", x: 10, y: 20, props: { assetId: "asset", w: 50, h: 30 } }],
        assets: {},
      },
    };
    expect(suggestVisualConceptsForMaterialContent(original)).toEqual(["箱", "box", "image", "画像"]);
    const copy = cloneMaterialContentForEditing(original);
    expect(copy).toEqual(original);
    copy.blocks[0].id = "edited";
    copy.overlaySnapshot.shapes[0].x = 100;
    expect(original.blocks[0].id).not.toBe("edited");
    expect(original.overlaySnapshot.shapes[0].x).toBe(10);
  });
});
