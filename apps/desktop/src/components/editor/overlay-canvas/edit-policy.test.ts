import { describe, expect, it } from "vitest";

import {
  getOverlayActionTargetShapeIds,
  isOverlayActionBlockedByEditPolicy,
  isOverlaySelectionBlockedByEditPolicy,
} from "./edit-policy";
import { normalizeOverlayGroups } from "./grouping";
import type { OverlayInteractionAction } from "./interaction-mode";
import type { OverlayShape } from "./types";

function rect(id: string, parentId?: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
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

function group(id: string, parentId?: string): OverlayShape {
  return {
    id,
    type: "group",
    x: 0,
    y: 0,
    ...(parentId ? { parentId } : {}),
    props: { w: 1, h: 1 },
  };
}

describe("getOverlayActionTargetShapeIds", () => {
  it("returns every shape id for group-transform actions", () => {
    const shapes = [rect("a"), rect("b")];

    expect(getOverlayActionTargetShapeIds({
      type: "startMove",
      shapes,
      start: { x: 0, y: 0 },
    })).toEqual(["a", "b"]);
    expect(getOverlayActionTargetShapeIds({
      type: "startResize",
      shapes,
      handle: "se",
      start: { x: 0, y: 0 },
      bounds: { x: 0, y: 0, w: 10, h: 10 },
    })).toEqual(["a", "b"]);
    expect(getOverlayActionTargetShapeIds({
      type: "startRotate",
      shapes,
      center: { x: 0, y: 0 },
      startAngle: 0,
    })).toEqual(["a", "b"]);
  });

  it("returns the shape id for single-shape drag actions", () => {
    const shape = rect("solo");

    expect(getOverlayActionTargetShapeIds({
      type: "startAnchorDrag",
      shape,
      start: { x: 0, y: 0 },
      origin: { x: 0, y: 0 },
    })).toEqual(["solo"]);
    expect(getOverlayActionTargetShapeIds({
      type: "startPoint",
      shape,
      handle: { type: "triangleApex" },
      pivot: { x: 5, y: 5 },
      rotation: 0,
    })).toEqual(["solo"]);
  });

  it("returns the shape id for edit-mode entry actions", () => {
    expect(getOverlayActionTargetShapeIds({ type: "editText", shapeId: "s1" })).toEqual(["s1"]);
    expect(getOverlayActionTargetShapeIds({ type: "editImageCrop", shapeId: "s1" })).toEqual(["s1"]);
    expect(getOverlayActionTargetShapeIds({ type: "editGraph", shapeId: "s1" })).toEqual(["s1"]);
    expect(getOverlayActionTargetShapeIds({ type: "editGraph3D", shapeId: "s1" })).toEqual(["s1"]);
    expect(getOverlayActionTargetShapeIds({ type: "editTable", shapeId: "s1" })).toEqual(["s1"]);
    expect(getOverlayActionTargetShapeIds({ type: "pickOrigin", shapeId: "s1" })).toEqual(["s1"]);
    expect(getOverlayActionTargetShapeIds({ type: "pickGraphFill", shapeId: "s1" })).toEqual(["s1"]);
  });

  it("returns no target for selection-only and non-editing actions", () => {
    const actions: OverlayInteractionAction[] = [
      { type: "select" },
      { type: "setTool", tool: { kind: "select" } },
      { type: "startMarquee", start: { x: 0, y: 0 }, additive: false },
      { type: "updateMarquee", current: { x: 0, y: 0 } },
      { type: "updateAnchorDrag", current: { x: 0, y: 0 } },
    ];

    for (const action of actions) {
      expect(getOverlayActionTargetShapeIds(action)).toEqual([]);
    }
  });
});

describe("isOverlayActionBlockedByEditPolicy", () => {
  it("blocks an edit-mode action targeting a reserved shape", () => {
    const shapes = [rect("reserved-shape"), rect("free-shape")];
    const reservedIds = new Set(["reserved-shape"]);

    expect(isOverlayActionBlockedByEditPolicy(
      { type: "editGraph", shapeId: "reserved-shape" },
      shapes,
      reservedIds,
    )).toBe(true);
    expect(isOverlayActionBlockedByEditPolicy(
      { type: "editGraph", shapeId: "free-shape" },
      shapes,
      reservedIds,
    )).toBe(false);
  });

  it("blocks a group transform when any target shape is reserved", () => {
    const shapes = [rect("a"), rect("b")];
    const reservedIds = new Set(["b"]);

    expect(isOverlayActionBlockedByEditPolicy(
      { type: "startMove", shapes, start: { x: 0, y: 0 } },
      shapes,
      reservedIds,
    )).toBe(true);
    expect(isOverlayActionBlockedByEditPolicy(
      { type: "startMove", shapes: [rect("a")], start: { x: 0, y: 0 } },
      shapes,
      reservedIds,
    )).toBe(false);
  });

  it("does not block selection-only actions or any action without reservations", () => {
    const shapes = [rect("a")];

    expect(isOverlayActionBlockedByEditPolicy(
      { type: "select" },
      shapes,
      new Set(["a"]),
    )).toBe(false);
    expect(isOverlayActionBlockedByEditPolicy(
      { type: "editGraph", shapeId: "a" },
      shapes,
      new Set(),
    )).toBe(false);
  });

  it("blocks editing a shape whose ancestor group is reserved", () => {
    const shapes = normalizeOverlayGroups([
      group("outer"),
      rect("child", "outer"),
      rect("sibling", "outer"),
    ]);

    expect(isOverlayActionBlockedByEditPolicy(
      { type: "editText", shapeId: "child" },
      shapes,
      new Set(["outer"]),
    )).toBe(true);
  });
});

describe("isOverlaySelectionBlockedByEditPolicy", () => {
  it("blocks a selection when it or a group descendant is reserved", () => {
    const shapes = normalizeOverlayGroups([
      group("outer"),
      rect("child", "outer"),
      rect("sibling", "outer"),
      rect("standalone"),
    ]);

    expect(isOverlaySelectionBlockedByEditPolicy(
      shapes,
      ["outer"],
      new Set(["outer"]),
    )).toBe(true);
    expect(isOverlaySelectionBlockedByEditPolicy(
      shapes,
      ["outer"],
      new Set(["child"]),
    )).toBe(true);
    expect(isOverlaySelectionBlockedByEditPolicy(
      shapes,
      ["standalone"],
      new Set(["outer"]),
    )).toBe(false);
  });

  it("does not block an empty selection or a selection without reservations", () => {
    const shapes = [rect("a")];

    expect(isOverlaySelectionBlockedByEditPolicy(
      shapes,
      [],
      new Set(["a"]),
    )).toBe(false);
    expect(isOverlaySelectionBlockedByEditPolicy(
      shapes,
      ["a"],
      new Set(),
    )).toBe(false);
  });
});
