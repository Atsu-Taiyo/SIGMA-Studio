import { describe, expect, it } from "vitest";

import {
  convertOverlayToWhiteboard,
  createOverlaySelectionCommentAnchor,
} from "@/components/editor/editor-shell/overlay-helpers";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { ensurePageLayout } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { createTranslator } from "@/lib/i18n";
import type {
  InlineNode,
  ListItemNode,
  OverlayShape,
  OverlayTextBlock,
  SigmaCommentAnchor,
  SigmaCommentThread,
  SigmaDocument,
} from "@/features/document";

describe("convertOverlayToWhiteboard", () => {
  it("uses measured body geometry while removing paper and body anchors", () => {
    const blockId = sampleDocument.content[0]?.id;
    expect(blockId).toBeTruthy();
    const pageShape = rectangle("page_shape", 40, 60, { type: "page" });
    const blockShape = rectangle("block_shape", 12, 16, {
      type: "block",
      blockId: blockId!,
      dx: 12,
      dy: 16,
    });
    const childShape = rectangle("child_shape", 0, 0, {
      type: "shape",
      shapeId: "page_shape",
      dx: 8,
      dy: 8,
    });
    const source: SigmaDocument = {
      ...ensurePageLayout(sampleDocument),
      pageLayout: {
        ...ensurePageLayout(sampleDocument).pageLayout!,
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [pageShape, blockShape, childShape],
            assets: {},
          },
        },
      },
    };

    const shapes = convertOverlayToWhiteboard(source, new Map([[
      blockId!,
      { id: blockId!, top: 500, left: 200, width: 420, height: 80 },
    ]])).pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];

    expect(shapes.find((shape) => shape.id === "page_shape")).toMatchObject({ x: 40, y: 60 });
    expect(shapes.find((shape) => shape.id === "page_shape")).not.toHaveProperty("anchor");
    expect(shapes.find((shape) => shape.id === "block_shape")).not.toHaveProperty("anchor");
    expect(shapes.find((shape) => shape.id === "block_shape")).toMatchObject({ x: 212, y: 516 });
    expect(shapes.find((shape) => shape.id === "child_shape")?.anchor).toEqual({
      type: "shape",
      shapeId: "page_shape",
      dx: 8,
      dy: 8,
    });
  });

  it("falls back to estimated geometry when measured rectangles are unavailable", () => {
    const blockId = sampleDocument.content[0]!.id;
    const source: SigmaDocument = {
      ...ensurePageLayout(sampleDocument),
      pageLayout: {
        ...ensurePageLayout(sampleDocument).pageLayout!,
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [rectangle("block_shape", 12, 16, {
              type: "block",
              blockId,
              dx: 12,
              dy: 16,
            })],
            assets: {},
          },
        },
      },
    };

    const shape = convertOverlayToWhiteboard(source).pageLayout?.overlay?.overlaySnapshot?.shapes[0];

    expect(shape?.y).toBeGreaterThan(16);
    expect(shape).not.toHaveProperty("anchor");
  });

  it("drops every body comment anchor and keeps only comments targeting existing overlay shapes", () => {
    const blockId = sampleDocument.content[0]!.id;
    const anchors: Array<[string, SigmaCommentAnchor]> = [
      ["block", { type: "block", blockId }],
      ["text", {
        type: "textRange",
        start: { blockId, offset: 0 },
        end: { blockId, offset: 1 },
        quote: "本",
      }],
      ["inline", { type: "inlineMath", blockId, mathInlineId: "math_1" }],
      ["shape", { type: "overlayShape", shapeIds: ["page_shape"] }],
      ["overlay_math", { type: "overlayMath", shapeId: "page_shape", mathInlineId: "overlay_math_1" }],
      ["unresolved_overlay_math", { type: "overlayMath", mathInlineId: "unresolved_math" }],
      ["missing_shape", { type: "overlayShape", shapeIds: ["missing"] }],
      ["missing_overlay_math", { type: "overlayMath", shapeId: "missing", mathInlineId: "missing_math" }],
    ];
    const comments = anchors.map(([id, anchor]) => comment(id, anchor));
    const source: SigmaDocument = {
      ...ensurePageLayout(sampleDocument),
      comments,
      pageLayout: {
        ...ensurePageLayout(sampleDocument).pageLayout!,
        overlay: {
          overlaySnapshot: {
            version: 1,
            shapes: [rectangle("page_shape", 40, 60, { type: "page" })],
            assets: {},
          },
        },
      },
    };

    const converted = convertOverlayToWhiteboard(source);

    expect(converted.content).toEqual([]);
    expect(converted.comments?.map((thread) => thread.id)).toEqual(["shape", "overlay_math"]);
  });
});

describe("createOverlaySelectionCommentAnchor", () => {
  it("uses the requested locale for the generated selection quote", () => {
    const selection = {
      selectedShapeIds: ["shape_1", "shape_2"],
      selectedShapes: [],
    } as unknown as OverlaySelectionSummary;

    expect(createOverlaySelectionCommentAnchor(selection)?.quote).toBe("選択した図形 2件");
    expect(createOverlaySelectionCommentAnchor(selection, createTranslator("en", "editor"))?.quote)
      .toBe("2 selected shapes");
  });

  /**
   * A comment on a shape that holds one formula should hang off that formula, not off the shape,
   * so it survives the shape being moved or restyled. Where the formula sits inside the blocks is
   * not the commenter's problem: a list item keeps prose in three places (its own line, the blocks
   * continuing it, the sub-lists under it) and only the first was ever looked at.
   */
  it.each([
    ["a paragraph", [paragraphBlock("p_1", math("m_para", "a+b"))]],
    ["a list item", [listBlock(listItem("li_1", [math("m_item", "a+b")]))]],
    ["a list item's continuation", [listBlock(listItem("li_1", [text("項目")], {
      continuations: [paragraphBlock("li_1_cont", math("m_cont", "a+b"))],
    }))]],
    ["a nested list item", [listBlock(listItem("li_1", [text("項目")], {
      nested: [listBlock(listItem("li_2", [math("m_nested", "a+b")]))],
    }))]],
  ])("anchors a comment to the formula inside %s", (_name, blocks) => {
    const selection = {
      selectedShapeIds: ["text_1"],
      selectedShapes: [textShape("text_1", blocks)],
    } as unknown as OverlaySelectionSummary;

    expect(createOverlaySelectionCommentAnchor(selection)).toMatchObject({
      type: "overlayMath",
      shapeId: "text_1",
      tex: "a+b",
    });
  });

  it("anchors a comment to the formula inside a callout too", () => {
    const selection = {
      selectedShapeIds: ["callout_1"],
      selectedShapes: [calloutShape("callout_1", [paragraphBlock("p_1", math("m_callout", "x>0"))])],
    } as unknown as OverlaySelectionSummary;

    expect(createOverlaySelectionCommentAnchor(selection)).toMatchObject({
      type: "overlayMath",
      shapeId: "callout_1",
      tex: "x>0",
    });
  });
});

function text(value: string): InlineNode {
  return { type: "text", text: value };
}

function math(id: string, tex: string): InlineNode {
  return { type: "mathInline", id, tex, display: "inline" };
}

function paragraphBlock(id: string, ...children: InlineNode[]): OverlayTextBlock {
  return { type: "paragraph", id, children };
}

function listItem(
  id: string,
  children: InlineNode[],
  extra: { continuations?: OverlayTextBlock[]; nested?: OverlayTextBlock[] } = {},
): ListItemNode {
  return {
    type: "listItem",
    id,
    children,
    ...(extra.continuations ? { continuations: extra.continuations as ListItemNode["continuations"] } : {}),
    ...(extra.nested ? { nested: extra.nested as ListItemNode["nested"] } : {}),
  };
}

function listBlock(...items: ListItemNode[]): OverlayTextBlock {
  return { type: "list", id: `list_${items[0]?.id ?? "1"}`, listType: "bullet", items };
}

function textShape(id: string, blocks: OverlayTextBlock[]): OverlayShape {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    rotation: 0,
    props: { w: 200, h: 32, blocks, color: "#111827", size: "m" },
  };
}

function calloutShape(id: string, blocks: OverlayTextBlock[]): OverlayShape {
  return {
    id,
    type: "callout",
    x: 0,
    y: 0,
    rotation: 0,
    props: {
      w: 160,
      h: 72,
      radius: 18,
      tail: { baseStart: { x: 36, y: 72 }, baseEnd: { x: 68, y: 72 }, tip: { x: 24, y: 100 } },
      blocks,
      color: "#111827",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
    },
  };
}

function comment(id: string, anchor: SigmaCommentAnchor): SigmaCommentThread {
  return {
    id,
    anchor,
    messages: [{
      id: `${id}_message`,
      body: [{ type: "text", text: id }],
      createdAt: "2026-08-26T00:00:00.000Z",
    }],
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function rectangle(id: string, x: number, y: number, anchor: OverlayShape["anchor"]): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    rotation: 0,
    anchor,
    props: {
      w: 100,
      h: 60,
      geo: "rectangle",
      fill: "none",
      color: "#111111",
      fillColor: "#ffffff",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  };
}
