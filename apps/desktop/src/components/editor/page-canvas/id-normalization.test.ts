import { describe, expect, it } from "vitest";

import type {
  LayoutSectionChildBlock,
  ProblemAreaBlock,
} from "@/types/sigma-doc";

import type { TextFlowBlock } from "../text-flow/types";
import {
  uniqueLayoutSectionBlocks,
  uniqueProblemAreaBlocks,
} from "./id-normalization";

describe("page-canvas id normalization", () => {
  it("regenerates reserved and duplicate ids throughout nested box, layout, and list content", () => {
    const reservedIds = new Set(["taken"]);
    const blocks: TextFlowBlock[] = [{
      id: "taken",
      type: "boxBlock",
      styleId: "frame",
      blocks: [{
        id: "taken",
        type: "layoutSection",
        layout: { columnCount: 2 },
        children: [{
          id: "taken",
          type: "list",
          listType: "bullet",
          items: [{
            id: "taken",
            type: "listItem",
            children: [],
            nested: [{
              id: "taken",
              type: "list",
              listType: "bullet",
              items: [{
                id: "taken",
                type: "listItem",
                children: [{ type: "text", text: "nested" }],
              }],
            }],
          }],
        }],
      }],
    }];

    const [box] = uniqueLayoutSectionBlocks(blocks, reservedIds);
    expect(box?.type).toBe("boxBlock");
    if (!box || box.type !== "boxBlock") {
      return;
    }
    const layout = box.blocks[0];
    expect(layout?.type).toBe("layoutSection");
    if (!layout || layout.type !== "layoutSection") {
      return;
    }
    const list = layout.children[0];
    expect(list?.type).toBe("list");
    if (!list || list.type !== "list") {
      return;
    }
    const item = list.items[0];
    const nestedList = item?.nested?.[0];
    const nestedItem = nestedList?.items[0];
    const ids = [
      box.id,
      layout.id,
      list.id,
      item?.id,
      nestedList?.id,
      nestedItem?.id,
    ];

    expect(ids.every((id): id is string => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("taken");
    expect(reservedIds).toEqual(new Set(["taken"]));
  });

  it("normalizes collisions across problem-area layout children without mutating the reserved set", () => {
    const reservedIds = new Set(["reserved"]);
    const blocks: ProblemAreaBlock[] = [
      paragraph("reserved", "first"),
      {
        id: "reserved",
        type: "layoutSection",
        layout: { columnCount: 2 },
        children: [
          paragraph("reserved", "left"),
          paragraph("reserved", "right"),
        ],
      },
    ];

    const normalized = uniqueProblemAreaBlocks(blocks, reservedIds);
    const layout = normalized[1];
    expect(layout?.type).toBe("layoutSection");
    if (!layout || layout.type !== "layoutSection") {
      return;
    }
    const ids = [
      normalized[0]?.id,
      layout.id,
      ...layout.children.map((child) => child.id),
    ];

    expect(ids.every((id): id is string => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("reserved");
    expect(reservedIds).toEqual(new Set(["reserved"]));
  });

  it("normalizes ids recursively inside a problem-area box block", () => {
    const reservedIds = new Set(["reserved"]);
    const blocks: ProblemAreaBlock[] = [{
      id: "reserved",
      type: "boxBlock",
      styleId: "itembox",
      title: [{ type: "text", text: "箱" }],
      blocks: [paragraph("reserved", "本文")],
    }];

    const [box] = uniqueProblemAreaBlocks(blocks, reservedIds);
    expect(box?.type).toBe("boxBlock");
    if (!box || box.type !== "boxBlock") {
      return;
    }

    expect(box.id).toMatch(/^box_/);
    expect(box.blocks[0]?.id).toMatch(/^p_/);
    expect(box.blocks[0]?.id).not.toBe(box.id);
    expect(reservedIds).toEqual(new Set(["reserved"]));
  });
});

function paragraph(
  id: string,
  text: string,
): Extract<LayoutSectionChildBlock, { type: "paragraph" }> {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}
