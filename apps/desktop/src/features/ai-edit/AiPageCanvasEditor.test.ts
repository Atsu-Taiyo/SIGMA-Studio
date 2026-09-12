import { describe, expect, it } from "vitest";

import type { AiEditPreviewState } from "./model/preview";

import { getOverlayInsertionAnchorBlockId, resolveAiEditGhostShapes } from "./AiPageCanvasEditor";
import type { MeasuredBlock } from "@/features/drawing";
import type { OverlayGeoShape, OverlayShape, OverlayTextShape } from "@/features/document";

function preview(operations: AiEditPreviewState["draft"]["operations"]): AiEditPreviewState {
  return {
    targetId: "left",
    draft: { summary: "提案", plan: [], warnings: [], operations },
    createdAt: 1,
    proposalIds: ["proposal-1"],
    baseRevision: 1,
    providers: [],
  };
}

describe("AI page canvas extension", () => {
  it("resolves only pure overlay insertions to their shared block column", () => {
    const insertion = preview([{
      operation: "insertOverlayShape",
      summary: "図形を挿入",
      targetId: "left",
      overlayShape: {
        id: "shape-1",
        type: "geo",
        x: 0,
        y: 0,
        anchor: { type: "block", blockId: "left", dx: 0, dy: 40 },
        props: {
          w: 80,
          h: 40,
          geo: "rectangle",
          fill: "none",
          color: "#111111",
          fillColor: "#ffffff",
          labelColor: "#111111",
          dash: "solid",
          size: "m",
        },
      },
      assets: {},
    }]);

    expect(getOverlayInsertionAnchorBlockId(insertion)).toBe("left");
    expect(getOverlayInsertionAnchorBlockId({
      ...insertion,
      shapeReplacements: [{ removedShapeId: "old", addedShapeId: "shape-1" }],
    })).toBeNull();
  });
});

describe("resolveAiEditGhostShapes", () => {
  const blockRects = new Map<string, MeasuredBlock>([
    ["left", { id: "left", left: 100, top: 500, width: 400, height: 40 }],
  ]);

  function geo(id: string, x: number, y: number, anchor?: OverlayShape["anchor"]): OverlayGeoShape {
    return {
      id,
      type: "geo",
      x,
      y,
      rotation: 0,
      ...(anchor ? { anchor } : {}),
      props: {
        w: 80,
        h: 40,
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

  function textGhost(id: string, anchor: OverlayShape["anchor"]): OverlayTextShape {
    return {
      id,
      type: "text",
      x: 0,
      y: 0,
      rotation: 0,
      ...(anchor ? { anchor } : {}),
      props: {
        w: 40,
        h: 16,
        blocks: [],
        color: "#111111",
        size: "m",
      },
    };
  }

  it("resolves a ghost anchored to an existing shape against that shape's resolved position", () => {
    const existing = geo("parent", 0, 0, { type: "block", blockId: "left", dx: 20, dy: 60 });
    const ghost = textGhost("child", { type: "shape", shapeId: "parent", dx: 5, dy: 7 });

    const [resolved] = resolveAiEditGhostShapes([ghost], [existing], blockRects, {});

    // parent は blockLeft(100)+20 / blockTop(500)+60 に解決され、その上に子の delta が乗る。
    expect({ x: resolved.x, y: resolved.y }).toEqual({ x: 125, y: 567 });
  });

  it("resolves block-anchored ghosts through the same invariant as the applied document", () => {
    const ghost = geo("ghost", 0, 0, { type: "block", blockId: "left", dx: 40, dy: 24 });

    const [resolved] = resolveAiEditGhostShapes([ghost], [], blockRects, {});

    expect({ x: resolved.x, y: resolved.y }).toEqual({ x: 140, y: 524 });
  });

  it("drops ghosts that the applied renderer would not draw (hidden shapes)", () => {
    const hidden = { ...geo("hidden", 0, 0), hidden: true } as OverlayShape;
    const visible = geo("visible", 0, 0);

    expect(resolveAiEditGhostShapes([hidden, visible], [], blockRects, {}).map((shape) => shape.id))
      .toEqual(["visible"]);
  });
});
