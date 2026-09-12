import { describe, expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";

const t = createTranslator("ja", "workspace");

import {
  collectMaterialShapesForBlockIds,
  collectOverlayAssetsForShapes,
  getMaterialNameFromBlock,
} from "@/components/editor/editor-shell/material-capture";
import type { OverlayAsset, OverlayShape } from "@/features/document";
import type { BoxBlockNode, ListNode, ParagraphNode, ProblemNode, SectionNode } from "@/types/sigma-doc";

function groupShape(id: string): OverlayShape {
  return {
    id,
    type: "group",
    x: 0,
    y: 0,
    props: { w: 100, h: 100 },
  };
}

function imageShape(id: string, assetId: string): OverlayShape {
  return {
    id,
    type: "image",
    x: 0,
    y: 0,
    props: { assetId, w: 100, h: 100 },
  };
}

function imageAsset(id: string): OverlayAsset {
  return {
    id,
    type: "image",
    props: {
      w: 100,
      h: 100,
      name: `${id}.png`,
      isAnimated: false,
      mimeType: "image/png",
      src: `data:image/png;base64,${id}`,
      fileSize: 10,
    },
  };
}

describe("material capture", () => {
  it("collects the complete anchored shape family without changing document order", () => {
    const unrelated = groupShape("unrelated");
    const sibling = { ...groupShape("sibling"), parentId: "group" };
    const legacyGroupedSibling = { ...groupShape("legacy-grouped-sibling"), groupId: "group" };
    const group = groupShape("group");
    const shapeAnchored = {
      ...groupShape("shape-anchored"),
      anchor: { type: "shape", shapeId: "block-anchored", dx: 0, dy: 0 } as const,
    };
    const blockAnchored = {
      ...groupShape("block-anchored"),
      parentId: "group",
      anchor: { type: "block", blockId: "block-1", dy: 0 } as const,
    };
    const shapes = [unrelated, sibling, legacyGroupedSibling, group, shapeAnchored, blockAnchored];

    expect(collectMaterialShapesForBlockIds(shapes, new Set(["block-1"])).map((shape) => shape.id)).toEqual([
      "sibling",
      "legacy-grouped-sibling",
      "group",
      "shape-anchored",
      "block-anchored",
    ]);
  });

  it("copies only assets referenced by captured image shapes", () => {
    const used = imageAsset("used");
    const unused = imageAsset("unused");
    const shapes = [
      imageShape("image-1", "used"),
      imageShape("image-2", "missing"),
      groupShape("group"),
    ];

    expect(collectOverlayAssetsForShapes(shapes, { used, unused })).toEqual({ used });
  });

  it("derives stable material names from supported block kinds and fallbacks", () => {
    const section: SectionNode = {
      id: "section",
      type: "section",
      title: "  セクション名  ",
    };
    const paragraph: ParagraphNode = {
      id: "paragraph",
      type: "paragraph",
      children: [{ type: "text", text: "  本文名  " }],
    };
    const list: ListNode = {
      id: "list",
      type: "list",
      listType: "bullet",
      items: [
        { id: "empty-item", type: "listItem", children: [] },
        { id: "later-item", type: "listItem", children: [{ type: "text", text: "後続項目" }] },
      ],
    };
    const box: BoxBlockNode = {
      id: "box",
      type: "boxBlock",
      styleId: "frame",
      blocks: [{
        id: "layout",
        type: "layoutSection",
        layout: { columnCount: 1 },
        children: [{
          id: "box-paragraph",
          type: "paragraph",
          children: [{ type: "text", text: "箱の本文" }],
        }],
      }],
    };
    const problem: ProblemNode = {
      id: "problem",
      type: "problem",
      tags: [],
      lead: [],
      prompt: [],
      solution: [],
      hints: [],
    };

    expect(getMaterialNameFromBlock(section, t)).toBe("セクション名");
    expect(getMaterialNameFromBlock(paragraph, t)).toBe("本文名");
    expect(getMaterialNameFromBlock(list, t)).toBe("リスト素材");
    expect(getMaterialNameFromBlock(box, t)).toBe("箱の本文");
    expect(getMaterialNameFromBlock(problem, t)).toBe("問題素材");
  });
});
