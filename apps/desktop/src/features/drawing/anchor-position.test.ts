import { describe, expect, it } from "vitest";

import type { OverlayAnchor, OverlayShape } from "@/features/document";

import {
  pageIndexForY,
  resolveShapeAnchorPositions,
  resolveShapePosition,
  resolveShapesPosition,
  type MeasuredBlock,
} from "./anchor-position";

describe("pageIndexForY", () => {
  it("keeps exact page-stride boundaries in the following page", () => {
    expect(pageIndexForY(0, 100)).toEqual({ pageIndex: 0, localY: 0 });
    expect(pageIndexForY(99.999, 100)).toEqual({ pageIndex: 0, localY: 99.999 });
    expect(pageIndexForY(100, 100)).toEqual({ pageIndex: 1, localY: 0 });
    expect(pageIndexForY(200, 100)).toEqual({ pageIndex: 2, localY: 0 });
  });

  it("clamps the page index but preserves a negative local coordinate", () => {
    expect(pageIndexForY(-1, 100)).toEqual({ pageIndex: 0, localY: -1 });
  });
});

describe("block anchor position resolution", () => {
  it("resolves x and y from a measured block", () => {
    const shape = {
      id: "figure",
      x: 10,
      y: 20,
      anchor: {
        type: "block",
        blockId: "paragraph",
        dx: 24,
        dy: 16,
      } satisfies OverlayAnchor,
    };
    const blockRects = new Map<string, MeasuredBlock>([
      ["paragraph", { id: "paragraph", top: 320, left: 80, width: 240 }],
    ]);

    expect(resolveShapePosition(shape, blockRects)).toMatchObject({
      x: 104,
      y: 336,
    });
  });

  it("keeps a dangling block anchor and its object reference unchanged", () => {
    const shape = {
      id: "figure",
      x: 10,
      y: 20,
      anchor: {
        type: "block",
        blockId: "missing",
        dx: 24,
        dy: 16,
      } satisfies OverlayAnchor,
    };

    expect(resolveShapePosition(shape, new Map())).toBe(shape);
  });

  it("follows an overflowed anchor line into the next sibling block", () => {
    const shape = {
      id: "figure",
      x: 10,
      y: 20,
      anchor: {
        type: "block",
        blockId: "first",
        dx: 0,
        dy: 0,
        line: { index: 1, dy: 4 },
      } satisfies OverlayAnchor,
    };

    // "first" lost its second line, so line 1 now lives in the block after it.
    expect(resolveShapePosition(shape, new Map<string, MeasuredBlock>([
      ["first", { id: "first", top: 100, left: 80, width: 240, lines: [line(0, 100)] }],
      ["second", { id: "second", top: 120, left: 80, width: 240, lines: [line(0, 120)] }],
    ])).y).toBe(124);
  });

  it("counts a container's lines once when an anchor line overflows past it", () => {
    const shape = {
      id: "figure",
      x: 10,
      y: 20,
      anchor: {
        type: "block",
        blockId: "first",
        dx: 0,
        dy: 0,
        line: { index: 3, dy: 4 },
      } satisfies OverlayAnchor,
    };

    // A list reports one line box per item, and each item repeats its own. Line
    // 3 of the flow is first→line 0, list→lines 0 and 1, then the tail
    // paragraph. Counting both levels would consume the list twice and drop the
    // figure back up inside it.
    expect(resolveShapePosition(shape, new Map<string, MeasuredBlock>([
      ["first", { id: "first", top: 100, left: 80, width: 240, lines: [line(0, 100)] }],
      ["list", { id: "list", top: 120, left: 80, width: 240, lines: [line(0, 120), line(1, 140)] }],
      ["item_1", { id: "item_1", top: 120, left: 96, width: 224, lines: [line(0, 120)], containerId: "list" }],
      ["item_2", { id: "item_2", top: 140, left: 96, width: 224, lines: [line(0, 140)], containerId: "list" }],
      ["tail", { id: "tail", top: 160, left: 80, width: 240, lines: [line(0, 160)] }],
    ])).y).toBe(164);
  });

  it("applies reserve-space gaps only when the compatibility flag is enabled", () => {
    const blockRects = new Map<string, MeasuredBlock>([
      ["paragraph", { id: "paragraph", top: 400, left: 80, width: 240 }],
    ]);
    const reserved = {
      id: "reserved",
      x: 104,
      y: 0,
      anchor: {
        type: "block",
        blockId: "paragraph",
        dx: 24,
        dy: 25,
        reserveSpace: true,
      } satisfies OverlayAnchor,
    };
    const unreserved = {
      ...reserved,
      id: "unreserved",
      anchor: {
        ...reserved.anchor,
        reserveSpace: false,
      },
    };

    expect(resolveShapePosition(reserved, blockRects, { paragraph: 60 }).y).toBe(365);
    expect(resolveShapePosition(unreserved, blockRects, { paragraph: 60 }).y).toBe(425);
  });
});

describe("shape anchor position resolution", () => {
  it("resolves normalized shape anchors from semantic parent bounds", () => {
    const parent = rectShape("parent", 100, 120, 200, 80);
    const child = {
      ...rectShape("child", 0, 0, 20, 10),
      anchor: {
        type: "shape",
        shapeId: parent.id,
        rx: 0.5,
        ry: 0.25,
        dx: 8,
        dy: -4,
      } satisfies OverlayAnchor,
    };

    expect(resolveShapeAnchorPositions([parent, child])[1]).toMatchObject({
      x: 208,
      y: 136,
    });
  });

  it("resolves a shape-anchor chain after its block-anchored parent moves", () => {
    const parent = {
      ...rectShape("parent", 0, 0, 200, 80),
      anchor: {
        type: "block",
        blockId: "paragraph",
        dx: 12,
        dy: 18,
      } satisfies OverlayAnchor,
    };
    const child = {
      ...rectShape("child", 20, 20, 20, 10),
      anchor: {
        type: "shape",
        shapeId: parent.id,
        dx: 20,
        dy: 20,
      } satisfies OverlayAnchor,
    };
    const blockRects = new Map<string, MeasuredBlock>([
      ["paragraph", { id: "paragraph", top: 300, left: 40, width: 240 }],
    ]);

    const resolved = resolveShapesPosition([parent, child], blockRects);

    expect(resolved[0]).toMatchObject({ x: 52, y: 318 });
    expect(resolved[1]).toMatchObject({ x: 72, y: 338 });
  });

  it("keeps dangling shape anchors and the unchanged array by reference", () => {
    const child = {
      ...rectShape("child", 20, 20, 20, 10),
      anchor: {
        type: "shape",
        shapeId: "missing",
        dx: 20,
        dy: 20,
      } satisfies OverlayAnchor,
    };
    const shapes = [child];

    const resolved = resolveShapeAnchorPositions(shapes);

    expect(resolved).toBe(shapes);
    expect(resolved[0]).toBe(child);
  });

  it("preserves unchanged references and clones only a relocated child", () => {
    const parent = rectShape("parent", 100, 120, 200, 80);
    const alignedChild = {
      ...rectShape("aligned", 148, 152, 20, 10),
      anchor: {
        type: "shape",
        shapeId: parent.id,
        dx: 48,
        dy: 32,
      } satisfies OverlayAnchor,
    };
    const alignedShapes = [parent, alignedChild];

    expect(resolveShapeAnchorPositions(alignedShapes)).toBe(alignedShapes);

    const staleChild = { ...alignedChild, x: 0, y: 0 };
    const staleShapes = [parent, staleChild];
    const resolved = resolveShapeAnchorPositions(staleShapes);

    expect(resolved).not.toBe(staleShapes);
    expect(resolved[0]).toBe(parent);
    expect(resolved[1]).not.toBe(staleChild);
    expect(resolved[1]).toMatchObject({ x: 148, y: 152 });
  });
});

function line(index: number, top: number, height = 20) {
  return { index, top, height, left: 80, width: 240 };
}

function rectShape(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    props: {
      w,
      h,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}
