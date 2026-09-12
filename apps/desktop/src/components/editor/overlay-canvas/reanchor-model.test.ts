import { describe, expect, it } from "vitest";

import { resolveShapesPosition } from "@/features/drawing";

import type { MeasuredBlock } from "./anchor";
import {
  areOverlayAnchorsEqual,
  attachUnanchoredShapesToMeasuredBlocks,
  inheritGroupAnchorsForMembers,
  reanchorShapesAgainstMeasuredBlocks,
  reanchorShapesByPosition,
  syncMovedOverlayShapeAnchor,
} from "./reanchor-model";
import type { OverlayAnchor, OverlayShape } from "./types";

function rect(
  id: string,
  x: number,
  y: number,
  anchor?: OverlayAnchor,
  size: { w: number; h: number } = { w: 20, h: 10 },
): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    ...(anchor ? { anchor } : {}),
    props: {
      ...size,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function line(id: string, x: number, y: number, anchor?: OverlayAnchor): OverlayShape {
  return {
    id,
    type: "line",
    x,
    y,
    ...(anchor ? { anchor } : {}),
    props: {
      kind: "polyline",
      points: [
        { x: 0, y: -60 },
        { x: 20, y: -50 },
      ],
      closed: false,
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

/** A smoothed curve: its drawn extent is the Bézier, not the control points. */
function curve(id: string, x: number, y: number): OverlayShape {
  return {
    id,
    type: "line",
    x,
    y,
    props: {
      kind: "curve",
      points: [
        { x: 0, y: 0 },
        { x: 40, y: -80 },
        { x: 80, y: 0 },
      ],
      closed: false,
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  } as OverlayShape;
}

/**
 * A shallow arc that bulges downwards: it is stored as `centre - r`, so its reference box starts
 * a whole radius above any ink. `x`/`y` = (100, 100) with r = 60 stores a 120x120 box, while the
 * sweep from 60° to 120° only draws between y = 152 and y = 220.
 */
function arc(id: string, x: number, y: number, anchor?: OverlayAnchor): OverlayShape {
  return {
    id,
    type: "arc",
    x,
    y,
    ...(anchor ? { anchor } : {}),
    props: {
      r: 60,
      startAngle: Math.PI / 3,
      endAngle: (Math.PI * 2) / 3,
      color: "black",
      dash: "solid",
      size: "m",
    },
  } as OverlayShape;
}

describe("areOverlayAnchorsEqual", () => {
  it("treats an absent anchor as the page anchor", () => {
    expect(areOverlayAnchorsEqual(undefined, { type: "page" })).toBe(true);
    expect(areOverlayAnchorsEqual({ type: "page" }, { type: "block", blockId: "a", dy: 0 })).toBe(false);
  });

  it("compares every persisted shape-anchor field", () => {
    const anchor = { type: "shape", shapeId: "parent", dx: 1, dy: 2, rx: 0.5, ry: 0.25 } as const;

    expect(areOverlayAnchorsEqual(anchor, { ...anchor })).toBe(true);
    expect(areOverlayAnchorsEqual(anchor, { ...anchor, rx: 0.6 })).toBe(false);
    expect(areOverlayAnchorsEqual(anchor, { ...anchor, shapeId: "other" })).toBe(false);
  });

  it("compares block offsets, reserve-space state, and line offsets", () => {
    const anchor = {
      type: "block",
      blockId: "a",
      dx: 3,
      dy: 4,
      reserveSpace: false,
      line: { index: 1, dy: 5 },
    } as const;

    expect(areOverlayAnchorsEqual(anchor, { ...anchor, line: { ...anchor.line } })).toBe(true);
    expect(areOverlayAnchorsEqual(anchor, { ...anchor, reserveSpace: true })).toBe(false);
    expect(areOverlayAnchorsEqual(anchor, { ...anchor, line: { index: 2, dy: 5 } })).toBe(false);
  });
});

describe("reanchorShapesAgainstMeasuredBlocks", () => {
  it("keeps the exact shape array when no blocks were measured", () => {
    const shapes = [rect("shape", 20, 30)];

    expect(reanchorShapesAgainstMeasuredBlocks(shapes, [])).toBe(shapes);
  });

  it("anchors an unanchored shape to the measured block above it", () => {
    const shapes = [rect("shape", 50, 130)];
    const blocks: MeasuredBlock[] = [{ id: "a", top: 100, left: 40, width: 200 }];

    const next = reanchorShapesAgainstMeasuredBlocks(shapes, blocks);

    expect(next[0]).toMatchObject({
      anchor: { type: "block", blockId: "a", dx: 10, dy: 30 },
    });
    expect(next[0].anchor).not.toHaveProperty("reserveSpace");
  });

  it("keeps an existing block when its line still exists", () => {
    const shapes = [
      rect("shape", 50, 310, {
        type: "block",
        blockId: "a",
        dx: 10,
        dy: 210,
        line: { index: 0, dy: 210 },
      }),
    ];
    const blocks: MeasuredBlock[] = [
      { id: "a", top: 100, left: 40, width: 200, lines: [{ index: 0, top: 100, height: 20 }] },
      { id: "b", top: 300, left: 40, width: 200, lines: [{ index: 0, top: 300, height: 20 }] },
    ];

    expect(reanchorShapesAgainstMeasuredBlocks(shapes, blocks)[0]).toMatchObject({
      anchor: { type: "block", blockId: "a" },
    });
  });

  it("falls back across all blocks when the stored line is stale", () => {
    const shapes = [
      rect("shape", 50, 310, {
        type: "block",
        blockId: "a",
        dx: 10,
        dy: 210,
        line: { index: 9, dy: 210 },
      }),
    ];
    const blocks: MeasuredBlock[] = [
      { id: "a", top: 100, left: 40, width: 200, lines: [{ index: 0, top: 100, height: 20 }] },
      { id: "b", top: 300, left: 40, width: 200, lines: [{ index: 0, top: 300, height: 20 }] },
    ];

    expect(reanchorShapesAgainstMeasuredBlocks(shapes, blocks)[0]).toMatchObject({
      anchor: { type: "block", blockId: "b", dx: 10, dy: 10, line: { index: 0, dy: 10 } },
    });
  });

  it("replaces a missing block anchor with a surviving measured block", () => {
    const shapes = [
      rect("shape", 50, 130, {
        type: "block",
        blockId: "missing",
        dx: 10,
        dy: 30,
      }),
    ];

    expect(reanchorShapesAgainstMeasuredBlocks(
      shapes,
      [{ id: "survivor", top: 100, left: 40, width: 200 }],
    )[0]).toMatchObject({
      anchor: { type: "block", blockId: "survivor", dx: 10, dy: 30 },
    });
  });

  it("migrates an anchor that names an editor-only block onto a real one", () => {
    // 既に壊れている教材 (SigmaDoc に無い id を指すアンカー) を、次の再アンカーで直す。
    const shape = rect("shape", 50, 130, { type: "block", blockId: "placeholder", dx: 10, dy: 30 });
    const blocks: MeasuredBlock[] = [
      { id: "real", top: 60, left: 40, width: 200 },
      { id: "placeholder", top: 100, left: 40, width: 200, derived: true },
    ];

    const next = reanchorShapesAgainstMeasuredBlocks([shape], blocks);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "real" });
  });

  it("keeps explicit reserve-space flags and compensates for the current gap", () => {
    const reserveTrue = rect("true", 50, 130, {
      type: "block",
      blockId: "a",
      dx: 10,
      dy: 30,
      reserveSpace: true,
    });
    const reserveFalse = rect("false", 80, 140, {
      type: "block",
      blockId: "a",
      dx: 40,
      dy: 40,
      reserveSpace: false,
    });
    const blocks: MeasuredBlock[] = [{ id: "a", top: 100, left: 40, width: 200 }];

    const next = reanchorShapesAgainstMeasuredBlocks(
      [reserveTrue, reserveFalse],
      blocks,
      { a: 20 },
    );

    expect(next[0].anchor).toEqual({
      type: "block",
      blockId: "a",
      dx: 10,
      dy: 50,
      reserveSpace: true,
    });
    expect(next[1].anchor).toEqual({
      type: "block",
      blockId: "a",
      dx: 40,
      dy: 40,
      reserveSpace: false,
    });
  });

  it("preserves page and shape anchors and the input array when nothing changes", () => {
    const page = rect("page", 10, 20, { type: "page" });
    const parent = rect("parent", 100, 100, { type: "page" });
    const child = rect("child", 110, 115, { type: "shape", shapeId: "parent", dx: 10, dy: 15 });
    const stableBlock = rect("block", 50, 130, { type: "block", blockId: "a", dx: 10, dy: 30 });
    const shapes = [page, parent, child, stableBlock];

    const next = reanchorShapesAgainstMeasuredBlocks(
      shapes,
      [{ id: "a", top: 100, left: 40, width: 200 }],
    );

    expect(next).toBe(shapes);
    expect(next[0]).toBe(page);
    expect(next[2]).toBe(child);
  });
});

describe("attachUnanchoredShapesToMeasuredBlocks", () => {
  it("attaches only shapes with no anchor and preserves explicit page anchors", () => {
    const unanchored = rect("unanchored", 50, 130);
    const pageAnchored = rect("page", 80, 140, { type: "page" });
    const shapes = [unanchored, pageAnchored];

    const next = attachUnanchoredShapesToMeasuredBlocks(
      shapes,
      [{ id: "body", top: 100, left: 40, width: 200 }],
    );

    expect(next[0]).toMatchObject({
      x: 50,
      y: 130,
      anchor: { type: "block", blockId: "body", dx: 10, dy: 30 },
    });
    expect(next[1]).toBe(pageAnchored);
  });

  it("returns the input when every shape already has an anchor", () => {
    const shapes = [rect("page", 10, 20, { type: "page" })];

    expect(attachUnanchoredShapesToMeasuredBlocks(
      shapes,
      [{ id: "body", top: 100, left: 40, width: 200 }],
    )).toBe(shapes);
  });

  it("does not infer an anchor from a block on another page", () => {
    const unanchored = rect("unanchored", 50, 130);

    expect(attachUnanchoredShapesToMeasuredBlocks(
      [unanchored],
      [{ id: "far-away", top: 1_250, left: 40, width: 200 }],
      1_000,
    )).toEqual([unanchored]);
  });

  it("preserves a bulk page-positioned overlay instead of inferring hundreds of anchors", () => {
    const shapes = Array.from({ length: 65 }, (_, index) => rect(`shape-${index}`, 50, 130));

    expect(attachUnanchoredShapesToMeasuredBlocks(
      shapes,
      [{ id: "body", top: 100, left: 40, width: 200 }],
    )).toBe(shapes);
  });
});

describe("reanchorShapesByPosition", () => {
  it("returns the exact array immediately for an empty target set", () => {
    const shapes = [rect("shape", 20, 30)];

    expect(reanchorShapesByPosition(shapes, new Set(), [])).toBe(shapes);
  });

  it("leaves page anchors and dangling shape anchors unchanged", () => {
    const page = rect("page", 10, 20, { type: "page" });
    const dangling = rect("dangling", 30, 40, { type: "shape", shapeId: "missing", dx: 2, dy: 3 });
    const shapes = [page, dangling];

    const next = reanchorShapesByPosition(shapes, new Set(["page", "dangling"]), []);

    expect(next).toBe(shapes);
  });

  it("recalculates a target shape anchor against its parent", () => {
    const parent = rect("parent", 100, 200, { type: "page" }, { w: 50, h: 40 });
    const child = rect("child", 130, 250, {
      type: "shape",
      shapeId: "parent",
      dx: 0,
      dy: 0,
      rx: 0.5,
      ry: 0.25,
    });

    const next = reanchorShapesByPosition([parent, child], new Set(["child"]), []);

    expect(next[1].anchor).toEqual({
      type: "shape",
      shapeId: "parent",
      dx: 5,
      dy: 40,
      rx: 0.5,
      ry: 0.25,
    });
  });

  it("uses visual bounds to choose a block but the shape origin for stored offsets", () => {
    const shape = line("line", 100, 150);
    const blocks: MeasuredBlock[] = [
      { id: "visual", top: 50, left: 0, width: 300 },
      { id: "origin", top: 120, left: 0, width: 300 },
    ];

    const next = reanchorShapesByPosition([shape], new Set(["line"]), blocks);

    expect(next[0].anchor).toEqual({
      type: "block",
      blockId: "visual",
      dx: 100,
      dy: 100,
    });
  });

  it("hangs a shallow arc off the block above its ink, not above the ellipse it is stored in", () => {
    // 保存箱の上端 (100) の上にあるのは far-above だけ。実際に描かれているのは y≈212 からなので
    // near-ink の方が「図形のすぐ上のブロック」。
    const shape = arc("arc", 100, 100);
    const blocks: MeasuredBlock[] = [
      { id: "far-above", top: 50, left: 0, width: 400 },
      { id: "near-ink", top: 200, left: 0, width: 400 },
    ];

    const next = reanchorShapesByPosition([shape], new Set(["arc"]), blocks);

    // dy は保存原点そのままなので、解決したときの y は元のまま。
    expect(next[0].anchor).toEqual({ type: "block", blockId: "near-ink", dx: 100, dy: -100 });
  });

  it("puts an arc in the column its ink is drawn in, not the one its centre falls in", () => {
    // 中心 (210,300) / r=100 の 0°→90° 弧。保存箱の中心 x=210 は段の隙間で左段寄り、
    // 実際に描かれるのは x=210..310 なので右段。
    const shape = {
      ...arc("arc", 110, 200),
      props: {
        ...(arc("arc", 110, 200) as Extract<OverlayShape, { type: "arc" }>).props,
        r: 100,
        startAngle: 0,
        endAngle: Math.PI / 2,
      },
    } as OverlayShape;
    const blocks: MeasuredBlock[] = [
      { id: "left", top: 250, left: 0, width: 200 },
      { id: "right", top: 250, left: 240, width: 200 },
    ];

    const next = reanchorShapesByPosition([shape], new Set(["arc"]), blocks);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "right" });
  });

  it("reanchors only targeted block shapes and preserves an explicit false flag", () => {
    const targeted = rect("targeted", 50, 130, {
      type: "block",
      blockId: "old",
      dx: 0,
      dy: 0,
      reserveSpace: false,
    });
    const untouched = rect("untouched", 80, 140);
    const shapes = [targeted, untouched];

    const next = reanchorShapesByPosition(
      shapes,
      new Set(["targeted"]),
      [{ id: "a", top: 100, left: 40, width: 200 }],
    );

    expect(next[0].anchor).toEqual({
      type: "block",
      blockId: "a",
      dx: 10,
      dy: 30,
      reserveSpace: false,
    });
    expect(next[1]).toBe(untouched);
  });

  it("still resolves stale shape-child coordinates for a nonempty unmatched target set", () => {
    const parent = rect("parent", 100, 200, { type: "page" });
    const child = rect("child", 0, 0, { type: "shape", shapeId: "parent", dx: 10, dy: 15 });
    const shapes = [parent, child];

    const next = reanchorShapesByPosition(shapes, new Set(["missing"]), []);

    expect(next).not.toBe(shapes);
    expect(next[0]).toBe(parent);
    expect(next[1]).toMatchObject({ x: 110, y: 215 });
  });
});

describe("a group is the unit that hangs from body text", () => {
  function group(id: string, x: number, y: number, size: { w: number; h: number }, anchor?: OverlayAnchor): OverlayShape {
    return {
      id,
      type: "group",
      x,
      y,
      ...(anchor ? { anchor } : {}),
      props: size,
    } as OverlayShape;
  }

  function member(id: string, parentId: string, x: number, y: number, anchor?: OverlayAnchor): OverlayShape {
    return { ...rect(id, x, y, anchor), parentId } as OverlayShape;
  }

  /** Two paragraphs far enough apart that a tall group straddles both. */
  const blocks: MeasuredBlock[] = [
    { id: "first", top: 100, left: 40, width: 200, height: 20, lines: [{ index: 0, top: 100, height: 20 }] },
    { id: "second", top: 300, left: 40, width: 200, height: 20, lines: [{ index: 0, top: 300, height: 20 }] },
  ];
  const blockRects = new Map(blocks.map((block) => [block.id, block]));

  it("binds every member to the group's block instead of one paragraph each", () => {
    // 上端はひとつ目の段落の下、下端はふたつ目の段落の下。個別に選ばせると 2 つの段落に
    // 分かれて紐づき、間の行が増えた瞬間にグループが割れる。
    const shapes = [
      group("g", 50, 130, { w: 60, h: 250 }),
      member("top", "g", 50, 130),
      member("bottom", "g", 90, 370),
    ];

    const next = reanchorShapesAgainstMeasuredBlocks(shapes, blocks);

    expect(next.map((shape) => (shape.anchor as { blockId?: string }).blockId))
      .toEqual(["first", "first", "first"]);
    expect(next[2].anchor).toMatchObject({ type: "block", blockId: "first", dy: 270, dx: 50 });
    // 追従先を揃えるだけで、座標は 1px も動かない。
    expect(resolveShapesPosition(next, blockRects).map((shape) => ({ x: shape.x, y: shape.y })))
      .toEqual(shapes.map((shape) => ({ x: shape.x, y: shape.y })));
  });

  it("keeps the group rigid when the block it hangs from moves", () => {
    const shapes = reanchorShapesAgainstMeasuredBlocks(
      [
        group("g", 50, 130, { w: 60, h: 250 }),
        member("top", "g", 50, 130),
        member("bottom", "g", 90, 370),
      ],
      blocks,
    );

    const reflowed = new Map(blockRects);
    reflowed.set("first", { ...blocks[0], top: 160, lines: [{ index: 0, top: 160, height: 20 }] });

    expect(resolveShapesPosition(shapes, reflowed).map((shape) => shape.y)).toEqual([190, 190, 430]);
  });

  it("re-picks the block for the whole group when only its members were dragged", () => {
    const shapes = [
      group("g", 50, 130, { w: 60, h: 60 }, { type: "block", blockId: "first", dy: 30, dx: 10 }),
      member("a", "g", 50, 130, { type: "block", blockId: "first", dy: 30, dx: 10 }),
      member("b", "g", 90, 170, { type: "block", blockId: "first", dy: 70, dx: 50 }),
    ];
    // ドラッグで動くのはメンバーだけ (グループは normalize が後から追いつく)。
    const dragged = [
      shapes[0],
      { ...shapes[1], y: 330 },
      { ...shapes[2], y: 370 },
    ];

    const next = reanchorShapesByPosition(dragged, new Set(["a", "b"]), blocks);

    expect(next.map((shape) => (shape.anchor as { blockId?: string }).blockId))
      .toEqual(["second", "second", "second"]);
    expect(next[1].anchor).toMatchObject({ blockId: "second", dy: 30 });
    expect(next[2].anchor).toMatchObject({ blockId: "second", dy: 70 });
  });

  it("hands a member the group's line, not the line the member sits on", () => {
    const twoLineBlock: MeasuredBlock[] = [{
      id: "first",
      top: 100,
      left: 40,
      width: 200,
      height: 40,
      lines: [
        { index: 0, top: 100, height: 20 },
        { index: 1, top: 120, height: 20 },
      ],
    }];
    const shapes = [
      group("g", 50, 110, { w: 60, h: 40 }),
      member("a", "g", 50, 110),
      member("b", "g", 50, 145),
    ];

    const next = reanchorShapesAgainstMeasuredBlocks(shapes, twoLineBlock);

    expect(next.map((shape) => (shape.anchor as { line?: { index: number } }).line?.index))
      .toEqual([0, 0, 0]);
    expect(next[2].anchor).toMatchObject({ line: { index: 0, dy: 45 } });
  });

  it("leaves members alone while the group's own anchor is unusable", () => {
    const memberAnchor = { type: "block", blockId: "second", dy: 30 } as const;
    const shapes = [
      group("g", 50, 130, { w: 60, h: 60 }, { type: "block", blockId: "gone", dy: 30 }),
      member("a", "g", 50, 330, memberAnchor),
    ];

    expect(inheritGroupAnchorsForMembers(shapes, blocks)[1].anchor).toBe(memberAnchor);
  });

  it("propagates an explicit page anchor so a pinned group cannot drift apart", () => {
    const shapes = [
      group("g", 50, 130, { w: 60, h: 60 }, { type: "page" }),
      member("a", "g", 50, 130, { type: "block", blockId: "first", dy: 30 }),
    ];

    expect(inheritGroupAnchorsForMembers(shapes, blocks)[1].anchor).toEqual({ type: "page" });
  });

  it("returns the exact array when every member already follows its group", () => {
    const shapes = reanchorShapesAgainstMeasuredBlocks(
      [
        group("g", 50, 130, { w: 60, h: 250 }),
        member("top", "g", 50, 130),
        member("bottom", "g", 90, 370),
      ],
      blocks,
    );

    expect(inheritGroupAnchorsForMembers(shapes, blocks)).toBe(shapes);
    expect(reanchorShapesAgainstMeasuredBlocks(shapes, blocks)).toBe(shapes);
  });
});

describe("re-anchoring never moves a figure", () => {
  const blocks: MeasuredBlock[] = [
    { id: "a", top: 100, left: 40, width: 200, lines: [{ index: 0, top: 100, height: 20 }] },
    { id: "b", top: 300, left: 40, width: 200, lines: [{ index: 0, top: 300, height: 20 }] },
  ];
  const blockRects = new Map(blocks.map((block) => [block.id, block]));
  const document: OverlayShape[] = [
    arc("arc", 100, 100),
    curve("curve", 60, 240),
    rect("rect", 60, 320),
    rect("anchored", 80, 150, { type: "block", blockId: "a", dx: 40, dy: 50 }),
  ];

  const positions = (shapes: OverlayShape[]) => shapes.map((shape) => ({ id: shape.id, x: shape.x, y: shape.y }));

  it("resolves back to the exact same coordinates, and settles after one pass", () => {
    // アンカーの選び方を変えてよいのは「今後どのブロックに追従するか」だけ。取り直した瞬間に
    // 座標が動くと、既存教材が最初の編集で図形ごとずれる。
    let current = document;
    let previousAnchors: string | null = null;

    for (let round = 0; round < 3; round += 1) {
      const reanchored = reanchorShapesAgainstMeasuredBlocks(current, blocks);
      current = resolveShapesPosition(reanchored, blockRects);

      expect(`round ${round}:${JSON.stringify(positions(current))}`)
        .toBe(`round ${round}:${JSON.stringify(positions(document))}`);
      const anchors = JSON.stringify(current.map((shape) => shape.anchor));
      if (previousAnchors !== null) {
        expect(`round ${round}:${anchors}`).toBe(`round ${round}:${previousAnchors}`);
      }
      previousAnchors = anchors;
    }
  });

  it("keeps coordinates when a moved shape re-syncs its anchor", () => {
    const before = arc("arc", 100, 100, { type: "block", blockId: "a", dx: 60, dy: 0 });
    const after = { ...before, x: 140, y: 180 };

    const next = syncMovedOverlayShapeAnchor(after, before, [after], blockRects);

    expect({ x: next.x, y: next.y }).toEqual({ x: 140, y: 180 });
    expect(next.anchor).toMatchObject({ type: "block", blockId: "a", dy: 80 });
  });
});

describe("syncMovedOverlayShapeAnchor", () => {
  it("returns the exact next shape for page anchors and missing targets", () => {
    const pageBefore = rect("page", 10, 20, { type: "page" });
    const pageAfter = { ...pageBefore, x: 30 };
    const danglingBefore = rect("dangling", 10, 20, { type: "shape", shapeId: "missing", dx: 0, dy: 0 });
    const danglingAfter = { ...danglingBefore, x: 30 };
    const missingBlockBefore = rect("block", 10, 20, { type: "block", blockId: "missing", dy: 0 });
    const missingBlockAfter = { ...missingBlockBefore, x: 30 };

    expect(syncMovedOverlayShapeAnchor(pageAfter, pageBefore, [], new Map())).toBe(pageAfter);
    expect(syncMovedOverlayShapeAnchor(danglingAfter, danglingBefore, [], new Map())).toBe(danglingAfter);
    expect(syncMovedOverlayShapeAnchor(missingBlockAfter, missingBlockBefore, [], new Map())).toBe(missingBlockAfter);
  });

  it("recalculates shape anchors when their parent exists", () => {
    const parent = rect("parent", 100, 200, { type: "page" });
    const before = rect("child", 110, 215, { type: "shape", shapeId: "parent", dx: 10, dy: 15 });
    const after = { ...before, x: 140, y: 260 };

    const next = syncMovedOverlayShapeAnchor(after, before, [parent, before], new Map());

    expect(next).not.toBe(after);
    expect(next.anchor).toEqual({
      type: "shape",
      shapeId: "parent",
      dx: 40,
      dy: 60,
    });
  });

  it("recalculates block anchors and preserves reserve-space state", () => {
    const before = rect("shape", 50, 130, {
      type: "block",
      blockId: "a",
      dx: 10,
      dy: 30,
      reserveSpace: true,
    });
    const after = { ...before, x: 80, y: 160 };
    const blocks = new Map<string, MeasuredBlock>([
      ["a", { id: "a", top: 100, left: 40, width: 200 }],
    ]);

    const next = syncMovedOverlayShapeAnchor(after, before, [before], blocks);

    expect(next.anchor).toEqual({
      type: "block",
      blockId: "a",
      dx: 40,
      dy: 60,
      reserveSpace: true,
    });
  });
});
