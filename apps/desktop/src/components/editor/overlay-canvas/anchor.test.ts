import { describe, expect, it } from "vitest";

import {
  buildBlockAnchorAtBoundary,
  ensureShapeAnchorDx,
  getAnchorBoundaryForAnchor,
  getBlockAnchorBoundaries,
  getMeasuredLineBreakOffsets,
  getShapeAnchorBoundaryInBlock,
  pickAnchorBoundaryAtPoint,
  pickBlockAnchor,
  pickShapeAnchor,
  reanchorAfterDeletion,
  resolveShapeAnchorPositions,
  resolveShapePosition,
  resolveShapesPosition,
  type BlockExtent,
  type MeasuredBlock,
} from "./anchor";
import type { OverlayAnchor, OverlayShape } from "./types";

type TestShape = { id: string; x?: number; y: number; anchor?: OverlayAnchor };

const blockAnchor = (blockId: string, dy: number): OverlayAnchor => ({ type: "block", blockId, dy });

describe("getMeasuredLineBreakOffsets", () => {
  it("cuts in line leading instead of at a glyph edge", () => {
    expect(getMeasuredLineBreakOffsets([
      { top: 10, height: 17 },
      { top: 32, height: 17 },
      { top: 54, height: 17 },
    ])).toEqual([29.5, 51.5, 71]);
  });
});

// Pre-deletion geometry: heading h, paragraph a (figure's anchor), paragraph b.
const pre = (): Map<string, BlockExtent> =>
  new Map<string, BlockExtent>([
    ["h", { top: 50, height: 20 }],
    ["a", { top: 100, height: 20 }],
    ["b", { top: 200, height: 20 }],
  ]);

describe("reanchorAfterDeletion", () => {
  it("moves a figure up by the deleted anchor block's height and re-anchors", () => {
    const shapes: TestShape[] = [{ id: "fig", y: 150, anchor: blockAnchor("a", 50) }]; // fOld = 100 + 50
    // After deleting `a`, `b` reflows up by 20; `h` stays.
    const orderedPost: MeasuredBlock[] = [{ id: "h", top: 50 }, { id: "b", top: 180 }];

    const { shapes: next, changed } = reanchorAfterDeletion(shapes, new Set(["a"]), pre(), orderedPost);

    expect(changed).toBe(true);
    expect(next[0].y).toBe(130); // moved up by 20
    expect(next[0].anchor).toEqual({ type: "block", blockId: "h", dy: 80 }); // 50 + 80 = 130
  });

  it("sums heights for a multi-line deletion above the figure", () => {
    const shapes: TestShape[] = [{ id: "fig", y: 150, anchor: blockAnchor("a", 50) }];
    const orderedPost: MeasuredBlock[] = [{ id: "b", top: 160 }]; // h and a gone -> b up by 40

    const { shapes: next } = reanchorAfterDeletion(shapes, new Set(["h", "a"]), pre(), orderedPost);

    expect(next[0].y).toBe(110); // 150 - (20 + 20)
  });

  it("ignores deleted blocks that sit below the figure", () => {
    const preWithBelow = pre();
    preWithBelow.set("c", { top: 300, height: 20 }); // below the figure (fOld = 150)
    const shapes: TestShape[] = [{ id: "fig", y: 150, anchor: blockAnchor("a", 50) }];
    const orderedPost: MeasuredBlock[] = [{ id: "h", top: 50 }, { id: "b", top: 180 }];

    const { shapes: next } = reanchorAfterDeletion(shapes, new Set(["a", "c"]), preWithBelow, orderedPost);

    expect(next[0].y).toBe(130); // only `a`'s height removed, not `c`
  });

  it("falls back to a page anchor when every block is deleted", () => {
    const shapes: TestShape[] = [{ id: "fig", y: 150, anchor: blockAnchor("a", 50) }];

    const { shapes: next, changed } = reanchorAfterDeletion(shapes, new Set(["h", "a", "b"]), pre(), []);

    expect(changed).toBe(true);
    expect(next[0].anchor).toEqual({ type: "page" });
    expect(next[0].y).toBe(110); // 150 - (20 for h above + 20 for anchor a); b below is excluded
  });

  it("leaves page-anchored shapes untouched", () => {
    const shapes: TestShape[] = [{ id: "fig", y: 150, anchor: { type: "page" } }];

    const { shapes: next, changed } = reanchorAfterDeletion(shapes, new Set(["a"]), pre(), []);

    expect(changed).toBe(false);
    expect(next[0]).toBe(shapes[0]);
  });

  it("leaves shapes whose anchor block survived untouched", () => {
    const shapes: TestShape[] = [{ id: "fig", y: 150, anchor: blockAnchor("a", 50) }];

    const { shapes: next, changed } = reanchorAfterDeletion(shapes, new Set(["b"]), pre(), [
      { id: "h", top: 50 },
      { id: "a", top: 100 },
    ]);

    expect(changed).toBe(false);
    expect(next[0]).toBe(shapes[0]);
  });

  it("prefers the block in the same column when top positions overlap", () => {
    const anchor = pickBlockAnchor(130, 130, [
      { id: "left", top: 100, left: 40, width: 120 },
      { id: "right", top: 100, left: 220, width: 120 },
    ], 260, 250);

    expect(anchor).toEqual({ type: "block", blockId: "right", dy: 30, dx: 30 });
  });

  it("never hangs a figure off a block that only exists in the editor", () => {
    // 空の問題エリアが出すプレースホルダ段落の id は SigmaDoc に存在しない (`derived`)。
    // そこへアンカーすると書き出し・印刷でその図形が丸ごと消える。
    const anchor = pickBlockAnchor(130, 130, [
      { id: "real", top: 60, left: 40, width: 400 },
      { id: "placeholder", top: 100, left: 40, width: 400, derived: true },
    ], 240, 200);

    expect(anchor).toMatchObject({ type: "block", blockId: "real" });
  });

  it("still uses an editor-only block when it is the only measurement there is", () => {
    // 候補が消えるほうが害が大きい: 何も選べないと図形は本文に追従しなくなる。
    const anchor = pickBlockAnchor(130, 130, [
      { id: "placeholder", top: 100, left: 40, width: 400, derived: true },
    ], 240, 200);

    expect(anchor).toMatchObject({ type: "block", blockId: "placeholder" });
  });

  it("uses the nearest inferred column in an N-column layout when narrow blocks do not contain the probe", () => {
    const anchor = pickBlockAnchor(180, 180, [
      { id: "left", top: 100, left: 40, width: 80 },
      { id: "middle", top: 170, left: 220, width: 80 },
      { id: "right", top: 100, left: 400, width: 80 },
    ], 520, 510);

    expect(anchor).toEqual({ type: "block", blockId: "right", dy: 80, dx: 110 });
  });

  it("preserves one-column top-based selection when the probe is outside the measured block width", () => {
    const anchor = pickBlockAnchor(180, 180, [
      { id: "first", top: 100, left: 40, width: 80 },
      { id: "second", top: 170, left: 40, width: 80 },
    ], 520, 510);

    expect(anchor).toEqual({ type: "block", blockId: "second", dy: 10, dx: 470 });
  });

  it("preserves dx when a deleted anchor re-anchors to a block in the same column", () => {
    const shapes: TestShape[] = [{ id: "fig", x: 260, y: 150, anchor: blockAnchor("a", 50) }];
    const orderedPost: MeasuredBlock[] = [
      { id: "left", top: 50, left: 40, width: 120 },
      { id: "right", top: 50, left: 220, width: 120 },
    ];

    const { shapes: next } = reanchorAfterDeletion(shapes, new Set(["a"]), pre(), orderedPost);

    expect(next[0].anchor).toEqual({ type: "block", blockId: "right", dy: 80, dx: 40 });
  });
});

describe("block anchor x offsets", () => {
  it("backfills dx from the current block column before a layout change", () => {
    const shapes = [
      { id: "fig", x: 250, y: 130, anchor: { type: "block", blockId: "right", dy: 30 } satisfies OverlayAnchor },
    ];
    const blockRects = new Map<string, MeasuredBlock>([
      ["right", { id: "right", top: 100, left: 220, width: 120 }],
    ]);

    const { shapes: next, changed } = ensureShapeAnchorDx(shapes, blockRects);

    expect(changed).toBe(true);
    expect(next[0].anchor).toEqual({ type: "block", blockId: "right", dy: 30, dx: 30 });
  });

  it("resolves a block-anchored shape against the block's current column", () => {
    const shape = {
      id: "fig",
      x: 250,
      y: 130,
      anchor: { type: "block", blockId: "right", dy: 30, dx: 30 } satisfies OverlayAnchor,
    };
    const blockRects = new Map<string, MeasuredBlock>([
      ["right", { id: "right", top: 500, left: 620, width: 120 }],
    ]);

    expect(resolveShapePosition(shape, blockRects)).toMatchObject({ x: 650, y: 530 });
  });

  it("resolves many block-anchored shapes against the current layout", () => {
    const blockRects = new Map<string, MeasuredBlock>(
      Array.from({ length: 60 }, (_, index) => [
        `block_${index}`,
        { id: `block_${index}`, top: index * 25, left: index % 2 === 0 ? 40 : 260, width: 120 },
      ]),
    );
    const shapes = Array.from({ length: 60 }, (_, index): OverlayShape => ({
      id: `shape_${index}`,
      type: "geo",
      x: 0,
      y: 0,
      anchor: { type: "block", blockId: `block_${index}`, dx: 12, dy: 7 },
      props: {
        w: 20,
        h: 10,
        geo: "rectangle",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    }));

    const resolved = resolveShapesPosition(shapes, blockRects);

    expect(resolved[0]).toMatchObject({ x: 52, y: 7 });
    expect(resolved[59]).toMatchObject({ x: 272, y: 1482 });
  });

  it("stores and resolves an offset from the anchored rendered line", () => {
    const anchor = pickBlockAnchor(140, 148, [
      {
        id: "p",
        top: 100,
        left: 40,
        width: 240,
        lines: [
          { index: 0, top: 100, height: 24 },
          { index: 1, top: 140, height: 24 },
        ],
      },
    ], 80, 70);

    expect(anchor).toEqual({
      type: "block",
      blockId: "p",
      dy: 48,
      dx: 30,
      line: { index: 1, dy: 8 },
    });

    const shape = { id: "fig", x: 70, y: 148, anchor };
    const blockRects = new Map<string, MeasuredBlock>([
      [
        "p",
        {
          id: "p",
          top: 100,
          left: 40,
          width: 240,
          lines: [
            { index: 0, top: 100, height: 24 },
            { index: 1, top: 172, height: 24 },
          ],
        },
      ],
    ]);

    expect(resolveShapePosition(shape, blockRects)).toMatchObject({ x: 70, y: 180 });
  });

  it("resolves an anchored line that moved into the next block after a paragraph split", () => {
    const shape = {
      id: "fig",
      x: 70,
      y: 148,
      anchor: {
        type: "block",
        blockId: "p_before_split",
        dy: 48,
        dx: 30,
        line: { index: 1, dy: 8 },
      } satisfies OverlayAnchor,
    };
    const blockRects = new Map<string, MeasuredBlock>([
      [
        "p_before_split",
        {
          id: "p_before_split",
          top: 100,
          left: 40,
          width: 240,
          lines: [{ index: 0, top: 100, height: 24 }],
        },
      ],
      [
        "p_after_split",
        {
          id: "p_after_split",
          top: 128,
          left: 40,
          width: 240,
          lines: [{ index: 0, top: 128, height: 24 }],
        },
      ],
    ]);

    expect(resolveShapePosition(shape, blockRects)).toMatchObject({ x: 70, y: 136 });
  });
});

describe("shape anchors", () => {
  it("resolves a child shape from its parent shape position", () => {
    const shapes = [
      rectShape("parent", 100, 120, 200, 80),
      {
        ...textShape("label", 148, 152),
        anchor: { type: "shape", shapeId: "parent", dx: 48, dy: 32 } satisfies OverlayAnchor,
      },
    ];

    const moved = [
      { ...shapes[0], x: 180, y: 210 },
      shapes[1],
    ] as OverlayShape[];

    expect(resolveShapeAnchorPositions(moved)[1]).toMatchObject({ x: 228, y: 242 });
  });

  it("keeps a normalized anchor point when the parent resizes", () => {
    const shapes = [
      rectShape("parent", 100, 100, 200, 100),
      {
        ...textShape("label", 200, 150),
        anchor: { type: "shape", shapeId: "parent", rx: 0.5, ry: 0.5, dx: 0, dy: 0 } satisfies OverlayAnchor,
      },
    ];

    const resized = [
      rectShape("parent", 100, 100, 300, 160),
      shapes[1],
    ];

    expect(resolveShapeAnchorPositions(resized)[1]).toMatchObject({ x: 250, y: 180 });
  });

  it("updates a moved child shape's offset from its parent", () => {
    const parent = rectShape("parent", 100, 120, 200, 80);
    const child = {
      ...textShape("label", 172, 164),
      anchor: { type: "shape", shapeId: "parent", dx: 48, dy: 32 } satisfies OverlayAnchor,
    };

    expect(pickShapeAnchor(child, parent)).toEqual({
      type: "shape",
      shapeId: "parent",
      dx: 72,
      dy: 44,
    });
  });
});

describe("anchor boundaries", () => {
  // Two paragraphs in one column: 3 lines then 2 lines, each line 20px tall.
  const paragraph = (id: string, top: number, lineCount: number, left = 40): MeasuredBlock => ({
    id,
    top,
    left,
    width: 200,
    height: lineCount * 20 + 4, // 4px of trailing padding below the last line
    lines: Array.from({ length: lineCount }, (_, index) => ({
      index,
      top: top + index * 20,
      height: 20,
      left,
      width: 200,
    })),
  });

  const first = paragraph("p1", 100, 3); // lines at 100/120/140, bottom 164
  const second = paragraph("p2", 200, 2); // lines at 200/220, bottom 244

  it("puts one boundary after every line and ends on the block's bottom edge", () => {
    expect(getBlockAnchorBoundaries(first)).toEqual([
      { blockId: "p1", lineIndex: 0, y: 120, left: 40, width: 200 },
      { blockId: "p1", lineIndex: 1, y: 140, left: 40, width: 200 },
      // Last line reports the block bottom (164), not the line bottom (160),
      // so the rule lands in the paragraph gap rather than under the glyphs.
      { blockId: "p1", lineIndex: 2, y: 164, left: 40, width: 200 },
    ]);
  });

  it("falls back to the block's bottom edge when it has no measured lines", () => {
    expect(getBlockAnchorBoundaries({ id: "empty", top: 300, left: 40, width: 200, height: 24 }))
      .toEqual([{ blockId: "empty", y: 324, left: 40, width: 200 }]);
  });

  it("draws a line anchor after its line and a whole-block anchor at the block top", () => {
    expect(getAnchorBoundaryForAnchor(
      { type: "block", blockId: "p1", dy: 60, line: { index: 1, dy: 20 } },
      first,
    )).toMatchObject({ lineIndex: 1, y: 140 });

    expect(getAnchorBoundaryForAnchor({ type: "block", blockId: "p1", dy: 60 }, first))
      .toMatchObject({ y: 100 });
  });

  it("falls back to the block's last boundary when the anchored line is gone", () => {
    expect(getAnchorBoundaryForAnchor(
      { type: "block", blockId: "p1", dy: 60, line: { index: 9, dy: 20 } },
      first,
    )).toMatchObject({ lineIndex: 2, y: 164 });
  });

  it("hangs a figure from the line above it, or the block's end when it is below", () => {
    expect(getShapeAnchorBoundaryInBlock(first, 400)).toMatchObject({ lineIndex: 2, y: 164 });
    expect(getShapeAnchorBoundaryInBlock(first, 125)).toMatchObject({ lineIndex: 1, y: 140 });
    expect(getShapeAnchorBoundaryInBlock(first, 10)).toMatchObject({ lineIndex: 0, y: 120 });
  });

  it("offers one snap position per block so a drag picks a block, not a line", () => {
    // The figure sits below both paragraphs: each block can only offer its end.
    expect(pickAnchorBoundaryAtPoint({ x: 140, y: 130 }, [first, second], 400))
      .toMatchObject({ blockId: "p1", lineIndex: 2, y: 164 });
    expect(pickAnchorBoundaryAtPoint({ x: 140, y: 210 }, [first, second], 400))
      .toMatchObject({ blockId: "p2", lineIndex: 1, y: 244 });
  });

  it("keeps the snap inside the column the pointer is over", () => {
    const right = paragraph("r1", 100, 2, 300);

    expect(pickAnchorBoundaryAtPoint({ x: 380, y: 150 }, [first, second, right], 400))
      .toMatchObject({ blockId: "r1" });
    expect(pickAnchorBoundaryAtPoint({ x: 120, y: 150 }, [first, second, right], 400))
      .toMatchObject({ blockId: "p1" });
  });

  it("round-trips a snapped boundary through the anchor it builds", () => {
    const boundary = pickAnchorBoundaryAtPoint({ x: 140, y: 210 }, [first, second], 400)!;
    const anchor = buildBlockAnchorAtBoundary(boundary, second, 400, 60);

    // Identical to what the re-anchor pass derives, so the drop survives it.
    expect(anchor).toEqual(pickBlockAnchor(400, 400, [second], 140, 60));
    expect(getAnchorBoundaryForAnchor(anchor, second)).toEqual(boundary);
  });
});

function rectShape(id: string, x: number, y: number, w: number, h: number): OverlayShape {
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

function textShape(id: string, x: number, y: number): OverlayShape {
  return {
    id,
    type: "text",
    x,
    y,
    props: {
      w: 40,
      h: 22,
      blocks: [{ type: "paragraph", id: "anchor_test_22", children: [{ type: "text", text: id }] }],
      color: "black",
      size: "s",
    },
  };
}
