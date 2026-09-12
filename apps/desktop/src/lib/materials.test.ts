import { describe, expect, it } from "vitest";

import {
  cloneMaterialContentForInsert,
  createMaterialCatalogEntry,
  inferDefaultMaterialPorts,
  materialMatchesConcepts,
  materialMatchesQuery,
  normalizeMaterialOverlayToOrigin,
  parseMaterialContent,
  replaceMaterialTriggerWithBlocks,
} from "@/lib/materials";
import { BUILTIN_BOX_STYLES, createBoxBlock } from "@/lib/box-blocks";
import {
  OFFICIAL_TEX_BOX_MATERIALS,
  isOfficialMaterial,
  mergeOfficialMaterials,
} from "@/lib/official-materials";
import type { OverlayAsset, OverlayShape } from "@/features/document";
import type { SigmaBlock, SigmaDocument, ParagraphNode } from "@/types/sigma-doc";
import type { MaterialContent, MaterialItem } from "@/types/material";

describe("materials", () => {
  it("does not ship bundled official TeX box materials", () => {
    expect(OFFICIAL_TEX_BOX_MATERIALS).toHaveLength(0);
  });

  it("provides simple TeX-style boxes as native box block styles", () => {
    const commandNames = BUILTIN_BOX_STYLES.map((style) => style.commandName);

    expect(commandNames).toEqual(expect.arrayContaining([
      "fancybox",
      "itembox",
      "tcolorbox",
      "tcolorbox-note",
      "shadebox",
      "leftbar",
      "doublebox",
      "dashedbox",
      "ruledbox",
      "screenbox",
      "ovalbox",
      "cornerbox",
    ]));

    const itembox = createBoxBlock("itembox");
    const tcolorbox = createBoxBlock("tcolorbox");
    const noteBox = createBoxBlock("tcolorbox-note");
    const dashedbox = createBoxBlock("dashedbox");
    const ovalbox = createBoxBlock("ovalbox");

    expect(itembox).toMatchObject({ type: "boxBlock", styleId: "itembox" });
    expect(itembox.title).toEqual([{ type: "text", text: "ポイント" }]);
    expect(itembox.frame?.decorations).toEqual([]); // titlePlate applied via CSS for itembox
    expect(tcolorbox.title).toEqual([{ type: "text", text: "定理" }]);
    expect(tcolorbox.frame?.decorations).toContainEqual(expect.objectContaining({ type: "titleBand" }));
    expect(noteBox).toMatchObject({ type: "boxBlock", styleId: "tcolorbox-note" });
    expect(collectTextFromBlock(noteBox)).toBe("");
    expect(noteBox.frame?.decorations).toContainEqual(expect.objectContaining({ type: "notebookRules" }));
    expect(dashedbox.frame?.borderStyle).toBe("dashed");
    expect(ovalbox.frame?.radiusPx).toBe(18);
  });

  it("merges official box materials without accepting user spoofed official ids", () => {
    const userMaterial = materialItem("material_user", "ユーザー素材");
    const spoofedOfficial = materialItem("official_tex_box_framed", "上書き");

    const merged = mergeOfficialMaterials([userMaterial, spoofedOfficial]);

    expect(merged).toHaveLength(1);
    expect(merged.at(-1)).toMatchObject({ id: "material_user", name: "ユーザー素材" });
    expect(merged.some((material) => material.name === "上書き")).toBe(false);
    expect(isOfficialMaterial(spoofedOfficial)).toBe(true);
  });

  it("rejects invalid material content", () => {
    expect(parseMaterialContent({ blocks: [], overlaySnapshot: { version: 1, shapes: [], assets: {} } })).not.toBeNull();
    expect(parseMaterialContent({ blocks: [{ type: "unknown" }], overlaySnapshot: { version: 1, shapes: [], assets: {} } })).toBeNull();
    expect(parseMaterialContent({ blocks: [], overlaySnapshot: { version: 1, shapes: [{ id: "bad" }], assets: {} } })).toBeNull();
  });

  it("clones blocks, shapes, image assets, and anchors for insertion", () => {
    const content = createMaterialContent({
      blocks: [paragraph("block_original", "素材本文")],
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "shape_geo",
            type: "geo",
            x: 10,
            y: 15,
            anchor: { type: "block", blockId: "block_original", dy: 4 },
            props: {
              w: 80,
              h: 40,
              geo: "rectangle",
              fill: "none",
              color: "black",
              labelColor: "black",
              dash: "solid",
              size: "m",
            },
          },
          {
            id: "shape_label",
            type: "text",
            x: 24,
            y: 28,
            anchor: { type: "shape", shapeId: "shape_geo", dx: 12, dy: 8 },
            props: {
              w: 40,
              h: 16,
              blocks: [{ type: "paragraph", id: "materials_test_33", children: [{ type: "text", text: "A" }] }],
              color: "black",
              size: "s",
            },
          },
          {
            id: "shape_image",
            type: "image",
            x: 0,
            y: 6,
            props: {
              assetId: "asset_original",
              w: 32,
              h: 24,
            },
          },
        ],
        assets: {
          asset_original: imageAsset("asset_original"),
        },
      },
    });

    const inserted = cloneMaterialContentForInsert(content, { origin: { x: 100, y: 200 } });
    const insertedBlockId = inserted.blocks[0]?.id;
    expect(insertedBlockId).toBeTruthy();
    expect(insertedBlockId).not.toBe("block_original");
    expect(inserted.blockIdMap.get("block_original")).toBe(insertedBlockId);

    const geo = inserted.overlaySnapshot.shapes.find((shape) => shape.type === "geo");
    const label = inserted.overlaySnapshot.shapes.find((shape) => shape.type === "text");
    const image = inserted.overlaySnapshot.shapes.find((shape): shape is Extract<OverlayShape, { type: "image" }> => shape.type === "image");
    expect(geo).toMatchObject({
      x: 110,
      y: 209,
      anchor: { type: "block", blockId: insertedBlockId },
    });
    expect(geo?.id).not.toBe("shape_geo");
    expect(label?.anchor).toMatchObject({ type: "shape", shapeId: geo?.id });
    expect(image?.props.assetId).not.toBe("asset_original");
    expect(Object.keys(inserted.overlaySnapshot.assets)).toEqual([image?.props.assetId]);
  });

  it("detaches figure-only orphan block anchors so @ origin controls placement", () => {
    const content = createMaterialContent({
      blocks: [],
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "shape_geo",
            type: "geo",
            x: 0,
            y: 0,
            anchor: { type: "block", blockId: "source_block", dy: 0 },
            props: {
              w: 80,
              h: 40,
              geo: "rectangle",
              fill: "none",
              color: "black",
              labelColor: "black",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    });

    const inserted = cloneMaterialContentForInsert(content, {
      origin: { x: 12, y: 34 },
    });
    expect(inserted.overlaySnapshot.shapes[0]).toMatchObject({
      x: 12,
      y: 34,
      anchor: { type: "page" },
    });
  });

  it("ignores stored page coordinates for figure-only material insertion", () => {
    const content = createMaterialContent({
      blocks: [],
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "shape_geo",
            type: "geo",
            x: 420,
            y: 360,
            anchor: { type: "page" },
            props: {
              w: 80,
              h: 40,
              geo: "rectangle",
              fill: "none",
              color: "black",
              labelColor: "black",
              dash: "solid",
              size: "m",
            },
          },
          {
            id: "shape_label",
            type: "text",
            x: 440,
            y: 372,
            anchor: { type: "shape", shapeId: "shape_geo", dx: 20, dy: 12 },
            props: {
              w: 40,
              h: 16,
              blocks: [{ type: "paragraph", id: "materials_test_34", children: [{ type: "text", text: "A" }] }],
              color: "black",
              size: "s",
            },
          },
        ],
        assets: {},
      },
    });

    const inserted = cloneMaterialContentForInsert(content, { origin: { x: 12, y: 34 } });
    const geo = inserted.overlaySnapshot.shapes.find((shape) => shape.type === "geo");
    const label = inserted.overlaySnapshot.shapes.find((shape) => shape.type === "text");

    expect(geo).toMatchObject({
      x: 12,
      y: 34,
      anchor: { type: "page" },
    });
    expect(label).toMatchObject({
      x: 32,
      y: 46,
      anchor: { type: "shape", shapeId: geo?.id },
    });
  });

  it("matches materials by usage and visual concepts and exposes AI catalog summaries", () => {
    const springMaterial = materialItem("material_spring", "バネ素材", createMaterialContent({
      blocks: [paragraph("p_spring", "バネ定数 k")],
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: "spring_shape",
          type: "line",
          x: 10,
          y: 20,
          props: {
            points: [{ x: 0, y: 0 }, { x: 80, y: 0 }],
            closed: false,
            color: "black",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    }));
    springMaterial.description = "力学の台車・ばね振動で使うコイルばね";
    springMaterial.usage = {
      useCases: ["小球や台車に接続するバネを描くとき"],
      avoidWhen: ["実物写真として扱うとき"],
      aliases: ["spring", "coil"],
    };
    springMaterial.visualConcepts = ["バネ", "コイル", "spring"];

    expect(materialMatchesQuery(springMaterial, "ばね振動")).toBe(true);
    expect(materialMatchesQuery(springMaterial, "coil")).toBe(true);
    expect(materialMatchesConcepts(springMaterial, ["バネ"])).toBe(true);
    expect(materialMatchesConcepts(springMaterial, ["三角形"])).toBe(false);

    const catalog = createMaterialCatalogEntry(springMaterial);
    expect(catalog).toMatchObject({
      id: "material_spring",
      description: "力学の台車・ばね振動で使うコイルばね",
      usage: {
        aliases: ["spring", "coil"],
      },
      visualConcepts: ["バネ", "コイル", "spring"],
      contentSummary: {
        blockCount: 1,
        shapeCount: 1,
        shapeTypes: ["line"],
      },
    });
    expect(catalog.contentSummary.representativeText).toContain("バネ定数");
  });

  it("scales figure material placement and infers simple ports", () => {
    const content = createMaterialContent({
      blocks: [],
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: "spring_shape",
          type: "geo",
          x: 0,
          y: 0,
          anchor: { type: "page" },
          props: {
            w: 80,
            h: 24,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    });

    const inserted = cloneMaterialContentForInsert(content, {
      origin: { x: 100, y: 120 },
      scaleX: 1.5,
      scaleY: 2,
    });

    expect(inserted.overlaySnapshot.shapes[0]).toMatchObject({
      x: 100,
      y: 120,
      props: {
        w: 120,
        h: 48,
      },
    });
    expect(inferDefaultMaterialPorts(content)).toEqual([
      { id: "leftEnd", label: "左端", kind: "leftEnd", x: 0, y: 12 },
      { id: "rightEnd", label: "右端", kind: "rightEnd", x: 80, y: 12 },
      { id: "center", label: "中央", kind: "center", x: 40, y: 12 },
    ]);
  });

  it("normalizes selected figure materials to origin and strips block anchors", () => {
    const normalized = normalizeMaterialOverlayToOrigin({
      version: 1,
      shapes: [
        {
          id: "shape_geo",
          type: "geo",
          x: 30,
          y: 40,
          anchor: { type: "block", blockId: "source_block", dx: 10, dy: 20 },
          props: {
            w: 80,
            h: 40,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
      extensions: {
        "vendor.example": { preserved: true },
      },
    }, { x: 20, y: 25 }, { detachBlockAnchors: true });

    expect(normalized.shapes[0]).toMatchObject({
      x: 10,
      y: 15,
      anchor: { type: "page" },
    });
    expect(normalized.extensions).toEqual({
      "vendor.example": { preserved: true },
    });
  });

  it("clones grouped shape materials with remapped parent ids", () => {
    const content = createMaterialContent({
      blocks: [],
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "group_original",
            type: "group",
            x: 0,
            y: 0,
            props: { w: 120, h: 80 },
          },
          {
            id: "shape_child",
            type: "geo",
            x: 10,
            y: 20,
            parentId: "group_original",
            props: {
              w: 80,
              h: 40,
              geo: "rectangle",
              fill: "none",
              color: "black",
              labelColor: "black",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    });

    const inserted = cloneMaterialContentForInsert(content, { origin: { x: 50, y: 60 } });
    const group = inserted.overlaySnapshot.shapes.find((shape) => shape.type === "group");
    const child = inserted.overlaySnapshot.shapes.find((shape) => shape.type === "geo");

    expect(group?.id).toBeTruthy();
    expect(group?.id).not.toBe("group_original");
    expect(child).toMatchObject({
      x: 60,
      y: 80,
      parentId: group?.id,
    });
  });

  it("replaces the trigger block with material blocks", () => {
    const trigger = paragraph("trigger_block", "@foo");
    const materialBlock = paragraph("material_block", "差し込み");
    const document = createDocument([paragraph("before", "前"), trigger, paragraph("after", "後")]);

    const replaced = replaceMaterialTriggerWithBlocks(document, "trigger_block", [materialBlock]);

    expect(replaced.document.content.map((block) => block.id)).toEqual(["before", "material_block", "after"]);
    expect(replaced.selectedId).toBe("material_block");
  });
});

function createMaterialContent(content: MaterialContent): MaterialContent {
  return content;
}

function materialItem(id: string, name: string, content: MaterialContent = emptyMaterialContent()): MaterialItem {
  return {
    version: 1,
    id,
    name,
    source: "user",
    content,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function emptyMaterialContent(): MaterialContent {
  return {
    blocks: [],
    overlaySnapshot: {
      version: 1,
      shapes: [],
      assets: {},
    },
  };
}

function collectTextFromBlock(block: SigmaBlock | undefined): string {
  if (!block) {
    return "";
  }
  if (block.type === "layoutSection") {
    return block.children.map((child) => collectTextFromBlock(child as SigmaBlock)).join("");
  }
  if (block.type === "boxBlock") {
    return block.blocks.map((child) => collectTextFromBlock(child as SigmaBlock)).join("");
  }
  if (block.type === "paragraph" || block.type === "heading") {
    return block.children.map((child) => child.type === "text" ? child.text : "").join("");
  }
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "list") {
    return block.items.map((item) => item.children.map((child) => child.type === "text" ? child.text : "").join("")).join("");
  }
  return "";
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text }],
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc",
    metadata: { title: "教材" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function imageAsset(id: string): OverlayAsset {
  return {
    id,
    type: "image",
    props: {
      w: 32,
      h: 24,
      name: "image.png",
      isAnimated: false,
      mimeType: "image/png",
      src: "data:image/png;base64,",
      fileSize: 0,
    },
  };
}
