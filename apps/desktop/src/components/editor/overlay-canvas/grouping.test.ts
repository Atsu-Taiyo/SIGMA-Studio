import { describe, expect, it } from "vitest";

import {
  getRenderableShapesInReverseVisualStackOrder,
  getRenderableShapesInVisualStackOrder,
  getMovingShapeIdsWithFullyMovingGroups,
  getShapeIdsForCurrentScope,
  getShapeSelectionIds,
  getUnlockedTransformShapes,
  groupOverlayShapes,
  isShapeEditPolicyLockedInTree,
  normalizeOverlayGroups,
  orderShapeIdsByVisualStackOrder,
  ungroupOverlayShapes,
} from "./grouping";
import type { OverlayShape } from "./types";

function rect(id: string, x: number, y: number, parentId?: string): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
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

function group(id: string, x: number, y: number, parentId?: string): OverlayShape {
  return {
    id,
    type: "group",
    x,
    y,
    ...(parentId ? { parentId } : {}),
    props: {
      w: 1,
      h: 1,
    },
  };
}

describe("overlay grouping helpers", () => {
  it("creates an explicit group shape and ungroups it back to the parent scope", () => {
    const result = groupOverlayShapes([
      rect("a", 10, 20),
      rect("b", 50, 70),
      rect("c", 100, 100),
    ], ["a", "b"], () => "group_1");

    expect(result.selectedIds).toEqual(["group_1"]);
    expect(result.shapes.map((shape) => shape.id)).toEqual(["group_1", "a", "b", "c"]);
    expect(result.shapes.find((shape) => shape.id === "group_1")).toMatchObject({
      type: "group",
      x: 10,
      y: 20,
      props: { w: 60, h: 70 },
    });
    expect(result.shapes.find((shape) => shape.id === "a")?.parentId).toBe("group_1");
    expect(result.shapes.find((shape) => shape.id === "b")?.parentId).toBe("group_1");

    const ungrouped = ungroupOverlayShapes(result.shapes, ["group_1"]);
    expect(ungrouped.shapes.map((shape) => shape.id)).toEqual(["a", "b", "c"]);
    expect(ungrouped.selectedIds).toEqual(["a", "b"]);
    expect(ungrouped.shapes.every((shape) => !shape.parentId)).toBe(true);
  });

  it("selects the outer group normally and direct focused children inside a group scope", () => {
    const shapes = normalizeOverlayGroups([
      group("outer", 0, 0),
      group("inner", 0, 0, "outer"),
      rect("child", 10, 10, "inner"),
      rect("inner_sibling", 20, 10, "inner"),
      rect("sibling", 50, 10, "outer"),
    ]);

    expect(getShapeSelectionIds(shapes, "child", null)).toEqual(["outer"]);
    expect(getShapeSelectionIds(shapes, "child", "outer")).toEqual(["inner"]);
    expect(getShapeSelectionIds(shapes, "child", "inner")).toEqual(["child"]);
    expect(getShapeIdsForCurrentScope(shapes, "outer")).toEqual(["inner", "sibling"]);
  });

  it("orders selectable ids by visual stack layer", () => {
    const shapes = [
      rect("front_bottom", 0, 0),
      { ...rect("background_late", 10, 10), stackLayer: "background" },
      rect("front_top", 20, 20),
    ] satisfies OverlayShape[];

    expect(orderShapeIdsByVisualStackOrder(shapes, [
      "front_top",
      "background_late",
      "unknown",
      "front_bottom",
    ])).toEqual([
      "background_late",
      "front_bottom",
      "front_top",
      "unknown",
    ]);
  });

  it("returns renderable shapes in paint and hit-test order", () => {
    const shapes = [
      rect("front_bottom", 0, 0),
      { ...rect("background_late", 10, 10), stackLayer: "background" },
      { ...rect("hidden_front", 20, 20), hidden: true },
      rect("front_top", 30, 30),
    ] satisfies OverlayShape[];

    expect(getRenderableShapesInVisualStackOrder(shapes).map((shape) => shape.id)).toEqual([
      "background_late",
      "front_bottom",
      "front_top",
    ]);
    expect(getRenderableShapesInReverseVisualStackOrder(shapes).map((shape) => shape.id)).toEqual([
      "front_top",
      "front_bottom",
      "background_late",
    ]);
  });

  it("dissolves groups with one child or no children", () => {
    const normalized = normalizeOverlayGroups([
      group("lonely", 0, 0),
      rect("only_child", 10, 10, "lonely"),
      group("empty", 100, 100),
    ]);

    expect(normalized.map((shape) => shape.id)).toEqual(["only_child"]);
    expect(normalized[0].parentId).toBeUndefined();
  });

  it("repairs missing parents and parent cycles", () => {
    const normalized = normalizeOverlayGroups([
      { ...group("a", 0, 0, "b") },
      { ...group("b", 0, 0, "a") },
      rect("child", 10, 10, "a"),
      rect("orphan", 40, 10, "missing"),
    ]);

    expect(normalized.map((shape) => shape.id)).toEqual(["child", "orphan"]);
    expect(normalized.every((shape) => !shape.parentId)).toBe(true);
  });

  it("treats a policy-reserved group and its descendants as locked", () => {
    // Two children -- normalizeOverlayGroups dissolves a group left with only
    // one child (see the "dissolves groups with one child" test above), so a
    // single-child fixture here would make "outer" disappear before the
    // assertions below even run.
    const shapes = normalizeOverlayGroups([
      group("outer", 0, 0),
      rect("child", 10, 10, "outer"),
      rect("sibling", 30, 10, "outer"),
      rect("standalone", 50, 50),
    ]);
    const outer = shapes.find((shape) => shape.id === "outer")!;
    const child = shapes.find((shape) => shape.id === "child")!;
    const standalone = shapes.find((shape) => shape.id === "standalone")!;

    const lockedIds = new Set(["outer"]);
    expect(isShapeEditPolicyLockedInTree(shapes, outer, lockedIds)).toBe(true);
    expect(isShapeEditPolicyLockedInTree(shapes, child, lockedIds)).toBe(true);
    expect(isShapeEditPolicyLockedInTree(shapes, standalone, lockedIds)).toBe(false);
    expect(isShapeEditPolicyLockedInTree(shapes, standalone, new Set())).toBe(false);
  });

  it("getUnlockedTransformShapes excludes policy-reserved shapes independently of the manual lock", () => {
    const shapes = [rect("a", 0, 0), rect("b", 20, 20), { ...rect("c", 40, 40), locked: true }] satisfies OverlayShape[];

    expect(getUnlockedTransformShapes(shapes, ["a", "b", "c"]).map((shape) => shape.id)).toEqual(["a", "b"]);
    expect(getUnlockedTransformShapes(shapes, ["a", "b", "c"], new Set(["a"])).map((shape) => shape.id)).toEqual(["b"]);
    expect(getUnlockedTransformShapes(shapes, ["a"], new Set(["a"]))).toEqual([]);
  });

  it("includes group ids for drag chrome when every descendant shape is moving", () => {
    const shapes = normalizeOverlayGroups([
      group("outer", 0, 0),
      group("inner", 0, 0, "outer"),
      rect("a", 10, 10, "inner"),
      rect("b", 30, 10, "inner"),
      rect("c", 50, 10, "outer"),
    ]);

    expect([...getMovingShapeIdsWithFullyMovingGroups(shapes, new Set(["a", "b", "c"]))]).toEqual([
      "a",
      "b",
      "c",
      "outer",
      "inner",
    ]);
  });

  it("keeps a group id stationary when any descendant shape is not moving", () => {
    const shapes = normalizeOverlayGroups([
      group("group", 0, 0),
      rect("moving", 10, 10, "group"),
      { ...rect("locked", 30, 10, "group"), locked: true },
    ]);

    expect([...getMovingShapeIdsWithFullyMovingGroups(shapes, new Set(["moving"]))]).toEqual(["moving"]);
  });
});
