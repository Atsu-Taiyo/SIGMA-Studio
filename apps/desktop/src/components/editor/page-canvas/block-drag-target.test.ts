import { describe, expect, it } from "vitest";

import type { BlockDropTarget } from "@/lib/block-drag-move";

import {
  clusterColumnsByLeft,
  resolveDropFromHit,
  resolveEdgeZonePx,
  sameDropResolution,
  type DragHit,
} from "./block-drag-target";

const box = { top: 100, bottom: 140, left: 80, right: 480 };

function unit(overrides: Partial<Extract<DragHit, { kind: "unit" }>> = {}): Extract<DragHit, { kind: "unit" }> {
  return {
    kind: "unit",
    id: "p1",
    type: "paragraph",
    box,
    ownBox: box,
    containerKind: "content",
    isFirstInContainer: false,
    isLastInContainer: false,
    ancestors: [],
    section: null,
    ...overrides,
  };
}

const allow = () => true;
const targets = (accepted: (target: BlockDropTarget) => boolean) => ({ columnEligible: true, canDrop: accepted });

describe("resolveDropFromHit", () => {
  it("resolves before/after by the midpoint of the unit's own line", () => {
    const before = resolveDropFromHit(unit(), { x: 200, y: 110 }, targets(allow));
    expect(before?.target).toEqual({ kind: "sibling", anchorId: "p1", position: "before" });
    expect(before?.indicator).toEqual({ orientation: "horizontal", top: 100, left: 80, width: 400 });

    const after = resolveDropFromHit(unit(), { x: 200, y: 135 }, targets(allow));
    expect(after?.target).toEqual({ kind: "sibling", anchorId: "p1", position: "after" });
    expect(after?.indicator).toMatchObject({ top: 140 });
  });

  it("uses the gap edge instead of the midpoint when the pointer sat in a gap", () => {
    const hit = unit({ gapEdge: "bottom" });
    expect(resolveDropFromHit(hit, { x: 200, y: 101 }, targets(allow))?.target).toMatchObject({ position: "after" });
  });

  it("creates columns at the left/right edge when the container allows it", () => {
    const right = resolveDropFromHit(unit(), { x: 470, y: 120 }, targets(allow));
    expect(right?.target).toEqual({ kind: "newColumns", anchorId: "p1", side: "right" });
    expect(right?.indicator).toEqual({ orientation: "vertical", left: 486, top: 100, height: 40 });

    const left = resolveDropFromHit(unit(), { x: 85, y: 120 }, targets(allow));
    expect(left?.target).toEqual({ kind: "newColumns", anchorId: "p1", side: "left" });
  });

  it("falls back to before/after at the edge when the units cannot go into columns", () => {
    const result = resolveDropFromHit(unit(), { x: 470, y: 120 }, { columnEligible: false, canDrop: allow });
    expect(result?.target).toEqual({ kind: "sibling", anchorId: "p1", position: "after" });
  });

  it("never offers columns beside a problem or inside a quote", () => {
    expect(resolveDropFromHit(unit({ type: "problem" }), { x: 470, y: 120 }, targets(allow))?.target).toMatchObject({ kind: "sibling" });
    expect(resolveDropFromHit(unit({ containerKind: "quote" }), { x: 470, y: 120 }, targets(allow))?.target).toMatchObject({ kind: "sibling" });
  });

  it("adds a column to the enclosing section, drawing the line along the whole column", () => {
    const columnBox = { top: 100, bottom: 140, left: 80, right: 280 };
    const hit = unit({
      box: columnBox,
      ownBox: columnBox,
      containerKind: "layout",
      section: { id: "sec", childId: "p1", columnBox: { top: 60, bottom: 400, left: 80, right: 280 } },
    });
    const result = resolveDropFromHit(hit, { x: 275, y: 120 }, targets(allow));
    expect(result?.target).toEqual({ kind: "insertColumn", sectionId: "sec", anchorChildId: "p1", side: "right" });
    expect(result?.indicator).toEqual({ orientation: "vertical", left: 286, top: 60, height: 340 });
  });

  it("uses the list's container to decide whether an item can form columns", () => {
    const item = unit({ type: "listItem", containerKind: "list", listContainerKind: "quote" });
    expect(resolveDropFromHit(item, { x: 470, y: 120 }, targets(allow))?.target).toMatchObject({ kind: "sibling" });
    const topItem = unit({ type: "listItem", containerKind: "list", listContainerKind: "content" });
    expect(resolveDropFromHit(topItem, { x: 470, y: 120 }, targets(allow))?.target).toMatchObject({ kind: "newColumns" });
  });

  it("escalates to the container when the pointer is at the container's top or bottom edge", () => {
    const containerBox = { top: 96, bottom: 300, left: 60, right: 500 };
    const first = unit({ isFirstInContainer: true, ancestors: [{ id: "box", box: containerBox }] });
    const atEdge = resolveDropFromHit(first, { x: 200, y: 102 }, targets(allow));
    expect(atEdge?.target).toEqual({ kind: "sibling", anchorId: "box", position: "before" });
    expect(atEdge?.indicator).toMatchObject({ top: 96, left: 60, width: 440 });

    const inside = resolveDropFromHit(first, { x: 200, y: 112 }, targets(allow));
    expect(inside?.target).toEqual({ kind: "sibling", anchorId: "p1", position: "before" });
  });

  it("walks outward through the ancestors when the inner drop is refused", () => {
    const hit = unit({
      type: "listItem",
      containerKind: "list",
      ancestors: [
        { id: "nested_list", box: { top: 90, bottom: 150, left: 100, right: 480 } },
        { id: "parent_item", box: { top: 70, bottom: 150, left: 80, right: 480 } },
      ],
    });
    const refuseNested = (target: BlockDropTarget) => (
      target.kind === "sibling" && target.anchorId === "parent_item"
    );
    const result = resolveDropFromHit(hit, { x: 200, y: 135 }, targets(refuseNested));
    expect(result?.target).toEqual({ kind: "sibling", anchorId: "parent_item", position: "after" });
    expect(result?.indicator).toMatchObject({ top: 150, left: 80 });
  });

  it("returns null when nothing accepts the drop", () => {
    expect(resolveDropFromHit(unit(), { x: 200, y: 120 }, targets(() => false))).toBeNull();
    expect(resolveDropFromHit(null, { x: 0, y: 0 }, targets(allow))).toBeNull();
  });

  it("appends to an empty problem area", () => {
    const hit: DragHit = { kind: "area", problemId: "prob", area: "solution", box };
    const result = resolveDropFromHit(hit, { x: 200, y: 120 }, targets(allow));
    expect(result?.target).toEqual({ kind: "areaEnd", problemId: "prob", area: "solution" });
    expect(result?.indicator).toMatchObject({ orientation: "horizontal", top: 140 });
  });
});

describe("helpers", () => {
  it("scales the edge zone with the block width within bounds", () => {
    expect(resolveEdgeZonePx({ top: 0, bottom: 0, left: 0, right: 50 })).toBe(20);
    expect(resolveEdgeZonePx({ top: 0, bottom: 0, left: 0, right: 200 })).toBe(36);
    expect(resolveEdgeZonePx({ top: 0, bottom: 0, left: 0, right: 1000 })).toBe(56);
  });

  it("clusters section children into columns by their left edge", () => {
    expect(clusterColumnsByLeft([
      { id: "a", left: 100 },
      { id: "b", left: 101 },
      { id: "c", left: 320 },
      { id: "d", left: 100.5 },
    ])).toEqual([["a", "b", "d"], ["c"]]);
  });

  it("compares resolutions by target and geometry", () => {
    const a = resolveDropFromHit(unit(), { x: 200, y: 110 }, targets(allow));
    const b = resolveDropFromHit(unit(), { x: 220, y: 112 }, targets(allow));
    const c = resolveDropFromHit(unit(), { x: 220, y: 135 }, targets(allow));
    expect(sameDropResolution(a, b)).toBe(true);
    expect(sameDropResolution(a, c)).toBe(false);
    expect(sameDropResolution(null, null)).toBe(true);
    expect(sameDropResolution(a, null)).toBe(false);
  });
});
