import { describe, expect, it } from "vitest";

import {
  patchShape,
  type OverlayBounds,
  type OverlayTextBlock,
  type OverlayShape,
} from "@/features/document";

import {
  getRotatedResizeTopLeftDelta,
  preserveRotatedTextResizeTopLeft,
} from "./shape-transform";
import { resolveShapePosition, type MeasuredBlock } from "./anchor-position";
import { getShapeBounds } from "./shape-bounds";
import { getShapeRotationPivot } from "./shape-visual-bounds";

const blocksOf = (text: string): OverlayTextBlock[] => ([{ type: "paragraph", id: "shape_transform_test_65", children: [{ type: "text", text }] }]);

function textShape(
  rotation: number,
  bounds: OverlayBounds,
): Extract<OverlayShape, { type: "text" }> {
  return {
    id: "text_1",
    type: "text",
    x: bounds.x,
    y: bounds.y,
    rotation,
    props: {
      w: bounds.w,
      h: bounds.h,
      color: "#111827",
      size: "m",
      blocks: blocksOf("one line"),
    },
  };
}

function pagePositionOfLocalTopLeft(shape: Extract<OverlayShape, { type: "text" }>) {
  const bounds = getShapeBounds(shape);
  const pivot = getShapeRotationPivot(shape);
  const cos = Math.cos(shape.rotation ?? 0);
  const sin = Math.sin(shape.rotation ?? 0);
  const localX = bounds.x - pivot.x;
  const localY = bounds.y - pivot.y;
  return {
    x: pivot.x + localX * cos - localY * sin,
    y: pivot.y + localX * sin + localY * cos,
  };
}

describe("getRotatedResizeTopLeftDelta", () => {
  it("returns zero at rotation 0 for any size change", () => {
    expect(getRotatedResizeTopLeftDelta(
      { w: 17, h: 81 },
      { w: 403, h: 9 },
      0,
    )).toEqual({ dx: 0, dy: 0 });
  });

  it.each([
    [Math.PI / 4, { w: 200, h: 24 }, { w: 200, h: 48 }, { dx: -8.48528137423857, dy: -3.5147186257614305 }],
    [Math.PI / 2, { w: 200, h: 24 }, { w: 200, h: 200 }, { dx: -88, dy: -88 }],
    [-1.1, { w: 120, h: 60 }, { w: 90, h: 30 }, { dx: -5.17205222230519, dy: 21.56416857953787 }],
  ])("keeps the local top-left fixed at rotation %s", (rotation, previousSize, nextSize, expectedDelta) => {
    const previous = textShape(rotation, { x: 40, y: 70, ...previousSize });
    const next = textShape(rotation, { x: 40, y: 70, ...nextSize });
    const delta = getRotatedResizeTopLeftDelta(previousSize, nextSize, rotation);
    const corrected = preserveRotatedTextResizeTopLeft(previous, next);

    expect(delta.dx).toBeCloseTo(expectedDelta.dx, 10);
    expect(delta.dy).toBeCloseTo(expectedDelta.dy, 10);
    expect(pagePositionOfLocalTopLeft(corrected).x).toBeCloseTo(pagePositionOfLocalTopLeft(previous).x, 10);
    expect(pagePositionOfLocalTopLeft(corrected).y).toBeCloseTo(pagePositionOfLocalTopLeft(previous).y, 10);
  });
});

describe("preserveRotatedTextResizeTopLeft", () => {
  it("keeps a rotated text shape fixed when a richText patch adds a line", () => {
    const previous = {
      ...textShape(Math.PI / 4, { x: 40, y: 70, w: 200, h: 16 }),
      props: {
        ...textShape(0, { x: 0, y: 0, w: 200, h: 16 }).props,
      },
    };
    const patched = patchShape([previous], {
      id: previous.id,
      type: "text",
      props: { blocks: blocksOf("first\nsecond") },
    })[0] as Extract<OverlayShape, { type: "text" }>;

    expect(getShapeBounds(patched).h).toBeGreaterThan(getShapeBounds(previous).h);
    const corrected = preserveRotatedTextResizeTopLeft(previous, patched);
    expect(pagePositionOfLocalTopLeft(corrected).x).toBeCloseTo(pagePositionOfLocalTopLeft(previous).x, 10);
    expect(pagePositionOfLocalTopLeft(corrected).y).toBeCloseTo(pagePositionOfLocalTopLeft(previous).y, 10);
  });

  it("moves x/y and every block-anchor offset together so neither derivation undoes it", () => {
    const blocks = new Map<string, MeasuredBlock>([[
      "block_1",
      {
        id: "block_1",
        top: 300,
        left: 120,
        lines: [{ index: 0, top: 312, left: 120, height: 24 }],
      },
    ]]);
    const previous = {
      ...textShape(Math.PI / 4, { x: 130, y: 312, w: 200, h: 24 }),
      anchor: {
        type: "block" as const,
        blockId: "block_1",
        dx: 10,
        dy: 40,
        line: { index: 0, dy: 0 },
      },
    };
    const next = {
      ...previous,
      props: { ...previous.props, h: 48 },
    };
    const corrected = preserveRotatedTextResizeTopLeft(previous, next);

    expect(corrected.anchor?.type).toBe("block");
    if (corrected.anchor?.type !== "block") {
      return;
    }
    expect(corrected.x).toBeCloseTo(121.5147186257614305, 10);
    expect(corrected.y).toBeCloseTo(308.4852813742385695, 10);
    expect(corrected.anchor.dx).toBeCloseTo(1.5147186257614305, 10);
    expect(corrected.anchor.dy).toBeCloseTo(36.4852813742385695, 10);
    expect(corrected.anchor.line?.dy).toBeCloseTo(-3.5147186257614305, 10);

    // Rendering derives x/y from the anchor; saving derives the anchor back from x/y. Correcting
    // only one side is what silently reverted on every save, so assert the pair still agrees.
    const block = blocks.get("block_1")!;
    expect(corrected.x - block.left!).toBeCloseTo(corrected.anchor.dx!, 10);
    expect(corrected.y - block.lines![0].top).toBeCloseTo(corrected.anchor.line!.dy, 10);

    const resolvedPrevious = resolveShapePosition(previous, blocks);
    const resolvedCorrected = resolveShapePosition(corrected, blocks);
    expect(pagePositionOfLocalTopLeft(resolvedCorrected).x).toBeCloseTo(pagePositionOfLocalTopLeft(resolvedPrevious).x, 10);
    expect(pagePositionOfLocalTopLeft(resolvedCorrected).y).toBeCloseTo(pagePositionOfLocalTopLeft(resolvedPrevious).y, 10);
  });
});
