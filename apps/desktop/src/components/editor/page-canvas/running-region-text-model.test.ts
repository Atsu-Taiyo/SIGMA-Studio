import { describe, expect, it } from "vitest";

import { getDefaultPageLayout } from "@/lib/page-layout";
import type {
  PageLayout,
  PageRunningRegion,
} from "@/types/sigma-doc";

import type { TextFlowBlock } from "../text-flow/types";
import {
  pageRunningRegionToTextFlowBlocks,
  replacePageRunningRegionTextFlow,
  textFlowBlocksToRunningBlocks,
} from "./running-region-text-model";

describe("running region text model", () => {
  it("deep-clones persisted rich blocks for the TextFlow editor", () => {
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 8,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [{
        type: "paragraph",
        id: "header_paragraph",
        children: [{
          type: "text",
          text: "見出し",
          marks: ["bold"],
        }],
      }, {
        type: "list",
        id: "header_list",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "header_item",
          children: [{
            type: "mathInline",
            id: "header_math",
            tex: "x^2",
            display: "inline",
            marks: ["underline"],
          }],
          nested: [{
            type: "list",
            id: "header_nested_list",
            listType: "ordered",
            items: [{
              type: "listItem",
              id: "header_nested_item",
              children: [{ type: "text", text: "内側" }],
            }],
          }],
        }],
      }],
    };

    const result = pageRunningRegionToTextFlowBlocks(region, "header");

    expect(result).toEqual(region.blocks);
    expect(result[0]).not.toBe(region.blocks[0]);
    expect(result[1]).not.toBe(region.blocks[1]);
    if (
      result[0]?.type !== "paragraph"
      || region.blocks[0]?.type !== "paragraph"
      || result[1]?.type !== "list"
      || region.blocks[1]?.type !== "list"
    ) {
      throw new Error("expected paragraph and list blocks");
    }
    expect(result[0].children).not.toBe(region.blocks[0].children);
    expect(result[0].children[0]).not.toBe(region.blocks[0].children[0]);
    expect(result[1].items).not.toBe(region.blocks[1].items);
    expect(result[1].items[0]).not.toBe(region.blocks[1].items[0]);
    expect(result[1].items[0]?.nested?.[0]).not.toBe(
      region.blocks[1].items[0]?.nested?.[0],
    );
    expect(result[1].items[0]?.nested?.[0]?.items[0]).not.toBe(
      region.blocks[1].items[0]?.nested?.[0]?.items[0],
    );
  });

  it("uses the stable header and footer placeholder ids for an empty region", () => {
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 8,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [],
    };

    expect(pageRunningRegionToTextFlowBlocks(region, "header")).toEqual([{
      type: "paragraph",
      id: "page_header_running_body",
      children: [],
    }]);
    expect(pageRunningRegionToTextFlowBlocks(region, "footer")).toEqual([{
      type: "paragraph",
      id: "page_footer_running_body",
      children: [],
    }]);
  });

  it("preserves section-to-h2 and untitled-box fallback conversion", () => {
    const section: TextFlowBlock = {
      type: "section",
      id: "running_section",
      title: "章見出し",
      align: "center",
      lineHeight: "1.6",
      pagination: { break: true },
    };
    const box: TextFlowBlock = {
      type: "boxBlock",
      id: "running_box",
      styleId: "frame",
      title: [],
      blocks: [{
        type: "paragraph",
        id: "running_box_body",
        children: [{ type: "text", text: "本文" }],
      }],
      pagination: { keepWithNext: true },
    };

    expect(textFlowBlocksToRunningBlocks([section, box])).toEqual([{
      type: "heading",
      id: "running_section",
      level: 2,
      children: [{ type: "text", text: "章見出し" }],
      align: "center",
      lineHeight: "1.6",
    }, {
      type: "paragraph",
      id: "running_box",
      children: [{ type: "text", text: "箱" }],
      pagination: { keepWithNext: true },
    }]);
  });

  it("enables the edited region, expands its margin, and preserves the other region", () => {
    const defaults = getDefaultPageLayout();
    const layout: PageLayout = {
      ...defaults,
      marginsMm: {
        ...defaults.marginsMm,
        top: 4,
        bottom: 6,
      },
      header: {
        enabled: false,
        heightMm: 7,
        offsetMm: 3,
        showOnFirstPage: false,
        blocks: [{
          type: "paragraph",
          id: "old_header",
          children: [{ type: "text", text: "旧" }],
        }],
      },
      footer: {
        enabled: false,
        heightMm: 6,
        offsetMm: 4,
        showOnFirstPage: false,
        blocks: [{
          type: "paragraph",
          id: "unchanged_footer",
          children: [{ type: "text", text: "脚注" }],
        }],
        overlay: {
          overlaySnapshot: {
            version: 1,
            assets: {},
            shapes: [{
              id: "footer_shape",
              type: "arc",
              x: 4,
              y: 2,
              props: { r: 8, startAngle: 0, endAngle: Math.PI, color: "#111111", dash: "solid", size: "m" },
            }],
          },
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
      },
    };
    const nextBlocks: TextFlowBlock[] = [{
      type: "section",
      id: "next_header",
      title: "新",
    }];

    const result = replacePageRunningRegionTextFlow(
      layout,
      "header",
      nextBlocks,
    );

    expect(result).not.toBeNull();
    expect(result?.marginsMm).toEqual({
      ...layout.marginsMm,
      top: 10,
    });
    expect(result?.header).toMatchObject({
      enabled: true,
      heightMm: 7,
      offsetMm: 3,
      showOnFirstPage: false,
      blocks: [{
        type: "heading",
        id: "next_header",
        level: 2,
        children: [{ type: "text", text: "新" }],
      }],
    });
    expect(result?.footer).toMatchObject({
      enabled: false,
      heightMm: 6,
      offsetMm: 4,
      showOnFirstPage: false,
      blocks: [{
        type: "paragraph",
        id: "unchanged_footer",
        children: [{ type: "text", text: "脚注" }],
      }],
    });
    expect(result?.footer?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
    expect(result?.footer?.overlay?.updatedAt).toBe("2026-07-24T00:00:00.000Z");
    expect(layout.header?.enabled).toBe(false);
    expect(layout.header?.blocks[0]?.id).toBe("old_header");
  });
});
