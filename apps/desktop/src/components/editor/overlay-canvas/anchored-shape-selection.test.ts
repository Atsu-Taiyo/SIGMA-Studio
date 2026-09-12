import { describe, expect, it } from "vitest";

import type { MeasuredBlock } from "@/features/drawing";

import { getAllSelectableShapeIds, getShapeIdsAnchoredToBlocks } from "./anchored-shape-selection";
import { normalizeOverlayGroups } from "./grouping";
import type { OverlayShape } from "./types";

function rect(
  id: string,
  anchor?: OverlayShape["anchor"],
  parentId?: string,
): OverlayShape {
  return {
    id,
    type: "geo",
    x: 10,
    y: 20,
    ...(anchor ? { anchor } : {}),
    ...(parentId ? { parentId } : {}),
    props: {
      w: 20,
      h: 20,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function rectAt(id: string, x: number, y: number, anchor?: OverlayShape["anchor"]): OverlayShape {
  return { ...rect(id, anchor), x, y };
}

function blockRects(...blocks: MeasuredBlock[]): ReadonlyMap<string, MeasuredBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

function group(id: string): OverlayShape {
  return { id, type: "group", x: 0, y: 0, props: { w: 1, h: 1 } };
}

function blockAnchor(blockId: string): OverlayShape["anchor"] {
  return { type: "block", blockId, dy: 12 };
}

describe("getShapeIdsAnchoredToBlocks", () => {
  it("returns the shapes hung on the given blocks and nothing else", () => {
    const shapes = [
      rect("shape_a", blockAnchor("p_1")),
      rect("shape_b", blockAnchor("p_2")),
      rect("shape_c", blockAnchor("p_9")),
      rect("shape_page", { type: "page" }),
    ];

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1", "p_2"])).toEqual(["shape_a", "shape_b"]);
  });

  it("carries a shape-anchored child along with its parent", () => {
    const shapes = [
      rect("shape_parent", blockAnchor("p_1")),
      rect("shape_label", { type: "shape", shapeId: "shape_parent", dx: 4, dy: 4 }),
      rect("shape_grandchild", { type: "shape", shapeId: "shape_label", dx: 2, dy: 2 }),
    ];

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"]))
      .toEqual(["shape_parent", "shape_label", "shape_grandchild"]);
  });

  it("selects the outermost group, not the member that carries the anchor", () => {
    const shapes = normalizeOverlayGroups([
      group("group_1"),
      rect("shape_member", blockAnchor("p_1"), "group_1"),
      rect("shape_other_member", blockAnchor("p_1"), "group_1"),
    ]);

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"])).toEqual(["group_1"]);
  });

  it("全選択: アンカーも重なりも持たない図形まで含める", () => {
    const shapes = [
      rect("shape_anchored", blockAnchor("p_1")),
      rectAt("shape_far_away", 9000, 9000),
    ];

    // 本文の全選択から来る要求。ぶら下がってもいなければ本文に重なってもいない図形
    // (余白の注記など) は、アンカー / 重なりの判定では絶対に拾えない。
    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"])).toEqual(["shape_anchored"]);
    expect(getAllSelectableShapeIds(shapes).sort()).toEqual(["shape_anchored", "shape_far_away"]);
  });

  it("全選択でも選択の単位は最外のグループ", () => {
    const shapes = normalizeOverlayGroups([
      group("group_1"),
      rect("shape_member", undefined, "group_1"),
      rect("shape_other_member", undefined, "group_1"),
      rectAt("shape_loose", 500, 500),
    ]);

    expect(getAllSelectableShapeIds(shapes).sort()).toEqual(["group_1", "shape_loose"]);
  });

  it("図形が無ければ空", () => {
    expect(getAllSelectableShapeIds([])).toEqual([]);
  });

  it("returns nothing when no block is selected", () => {
    const shapes = [rect("shape_a", blockAnchor("p_1"))];

    expect(getShapeIdsAnchoredToBlocks(shapes, [])).toEqual([]);
    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_other"])).toEqual([]);
  });

  it("carries a page-fixed shape that sits on top of the selected text", () => {
    // 取り込み由来の教材はアンカーを持たない図形が並ぶ。本文の上に載っているのに
    // コピーされない、が「図形が付いてこない」の正体。
    const shapes = [rectAt("shape_page", 30, 30, { type: "page" })];
    const rects = blockRects({ id: "p_1", top: 20, left: 0, width: 400, height: 40 });

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"], rects)).toEqual(["shape_page"]);
  });

  it("leaves a page-fixed shape that misses the selected text alone", () => {
    const shapes = [rectAt("shape_page", 30, 300, { type: "page" })];
    const rects = blockRects({ id: "p_1", top: 20, left: 0, width: 400, height: 40 });

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"], rects)).toEqual([]);
  });

  it("joins the blocks of one column into a band so a shape between two lines is caught", () => {
    const shapes = [rectAt("shape_gap", 30, 62, { type: "page" })];
    const rects = blockRects(
      { id: "p_1", top: 20, left: 0, width: 400, height: 40 },
      { id: "p_2", top: 62, left: 0, width: 400, height: 40 },
    );

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1", "p_2"], rects)).toEqual(["shape_gap"]);
  });

  it("keeps two columns apart so the gutter is not swept up", () => {
    // 段組の左右を 1 本の帯へ畳むと、段間に置いた図形まで巻き込む。
    const shapes = [rectAt("shape_gutter", 410, 30, { type: "page" })];
    const rects = blockRects(
      { id: "p_left", top: 20, left: 0, width: 400, height: 200 },
      { id: "p_right", top: 20, left: 440, width: 400, height: 200 },
    );

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_left", "p_right"], rects)).toEqual([]);
  });

  it("selects the outermost group when only one member overlaps the text", () => {
    const shapes = normalizeOverlayGroups([
      group("group_1"),
      rectAt("shape_on_text", 30, 30, undefined),
      rectAt("shape_far_away", 30, 900, undefined),
    ].map((shape) => (shape.type === "group" ? shape : { ...shape, parentId: "group_1" })));
    const rects = blockRects({ id: "p_1", top: 20, left: 0, width: 400, height: 40 });

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"], rects)).toEqual(["group_1"]);
  });

  it("falls back to anchors alone when no block rect was measured", () => {
    const shapes = [rect("shape_a", blockAnchor("p_1")), rect("shape_page", { type: "page" })];

    expect(getShapeIdsAnchoredToBlocks(shapes, ["p_1"], new Map())).toEqual(["shape_a"]);
  });
});
