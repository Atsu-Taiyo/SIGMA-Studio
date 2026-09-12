import { describe, expect, it } from "vitest";

import { boundsIntersect, getRotatedShapeVisualBounds, getShapeSelectionBounds } from "@/features/drawing";

import { getMarqueeSelectionIds } from "./marquee-selection";
import { normalizeOverlayGroups } from "./grouping";
import type { OverlayArcShape, OverlayLineShape, OverlayShape } from "./types";

const HALF_PI = Math.PI / 2;
const QUARTER_PI = Math.PI / 4;
// size "m" draws a 2px stroke, so the visible box grows by 1px on every side.
const HALF_STROKE_M = 1;

function arc(props: Partial<OverlayArcShape["props"]> = {}): OverlayArcShape {
  // An arc stores "centre - r" in x/y (`arc-creation.ts`), so the reference box is the whole
  // ellipse. r = 50 / centre (150, 150).
  return {
    id: "arc",
    type: "arc",
    x: 100,
    y: 100,
    props: {
      r: 50,
      startAngle: 0,
      endAngle: HALF_PI,
      color: "#111111",
      dash: "solid",
      size: "m",
      ...props,
    },
  };
}

function line(props: Partial<OverlayLineShape["props"]> = {}): OverlayLineShape {
  return {
    id: "line",
    type: "line",
    x: 10,
    y: 20,
    props: {
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      closed: false,
      color: "#111111",
      dash: "solid",
      size: "m",
      ...props,
    },
  };
}

function rect(id: string, x: number, y: number, overrides: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    ...overrides,
    props: {
      w: 20,
      h: 20,
      geo: "rectangle",
      fill: "none",
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      ...(overrides.props as Record<string, unknown> | undefined),
    },
  } as OverlayShape;
}

function group(id: string): OverlayShape {
  return {
    id,
    type: "group",
    x: 0,
    y: 0,
    props: { w: 1, h: 1 },
  } as OverlayShape;
}

function select(
  shapes: OverlayShape[],
  marquee: { x: number; y: number; w: number; h: number },
  options: { focusedGroupId?: string | null; currentIds?: string[]; additive?: boolean } = {},
) {
  return getMarqueeSelectionIds({
    shapes,
    marquee,
    focusedGroupId: options.focusedGroupId ?? null,
    currentIds: options.currentIds ?? [],
    additive: options.additive ?? false,
  });
}

describe("marquee selection", () => {
  it("ignores the part of the ellipse an arc never draws", () => {
    const shape = arc();
    // The visible box is the sweep (150..200 on both axes) plus half a stroke.
    const marquee = { x: 104, y: 104, w: 30, h: 30 };

    // The reference box is the whole ellipse, so the old rule selected this arc here.
    expect(boundsIntersect(getShapeSelectionBounds(shape), marquee)).toBe(true);
    expect(select([shape], marquee)).toEqual([]);
  });

  it("selects an arc whose visible box the marquee touches", () => {
    expect(select([arc()], { x: 190, y: 140, w: 20, h: 20 })).toEqual(["arc"]);
  });

  it("includes the centre of a sector but not of a plain arc", () => {
    // A 45 degree sweep: a 90 degree one puts the centre on a corner of the end-point box, where
    // the sector and the plain arc would have the same visible box.
    const marquee = { x: 152, y: 152, w: 10, h: 10 };

    expect(select([arc({ kind: "sector", endAngle: Math.PI / 4 })], marquee)).toEqual(["arc"]);
    expect(select([arc({ endAngle: Math.PI / 4 })], marquee)).toEqual([]);
  });

  it("ignores a rotated shape the marquee only reaches before the rotation", () => {
    const shape = rect("rect", 100, 100, { rotation: HALF_PI, props: { w: 200, h: 20 } });

    expect(select([shape], { x: 110, y: 104, w: 20, h: 8 })).toEqual([]);
  });

  it("selects a rotated shape where the marquee reaches it after the rotation", () => {
    const shape = rect("rect", 100, 100, { rotation: HALF_PI, props: { w: 200, h: 20 } });

    expect(select([shape], { x: 195, y: 20, w: 10, h: 10 })).toEqual(["rect"]);
  });

  it("ignores the empty corner an eighth turn leaves inside the axis-aligned box", () => {
    // 100..300 x 100..120 turned 45 degrees: the corners of the box that contains the result are
    // blank, and the marquee sits in one of them.
    const shape = rect("rect", 100, 100, { rotation: QUARTER_PI, props: { w: 200, h: 20 } });
    const marquee = { x: 122.5, y: 32.5, w: 5, h: 5 };

    expect(boundsIntersect(getRotatedShapeVisualBounds(shape), marquee)).toBe(true);
    expect(select([shape], marquee)).toEqual([]);
  });

  it("selects a shape turned an eighth of a circle where the marquee is over its ink", () => {
    const shape = rect("rect", 100, 100, { rotation: QUARTER_PI, props: { w: 200, h: 20 } });

    expect(select([shape], { x: 250, y: 150, w: 10, h: 10 })).toEqual(["rect"]);
  });

  it("follows a rotated arc to where its ink ends up", () => {
    // The arc turns around the centre of the quarter circle it draws (175, 175), and that ink is
    // square, so a quarter turn leaves the box where it was: 149..201. It used to turn around the
    // centre of the stored ellipse (150, 150), which threw the ink out to x 99..151.
    const shape = { ...arc(), rotation: HALF_PI } as OverlayShape;

    expect(select([shape], { x: 100, y: 150, w: 45, h: 45 })).toEqual([]);
    expect(select([shape], { x: 160, y: 150, w: 40, h: 40 })).toEqual(["arc"]);
  });

  it("selects a line by the caption drawn above it", () => {
    // The caption sits on `points[1]` (110, 20), eight pixels up, and is drawn centred on it.
    const shape = line({ label: "AB" });
    const marquee = { x: 106, y: 4, w: 8, h: 4 };

    expect(select([line()], marquee)).toEqual([]);
    expect(select([shape], marquee)).toEqual(["line"]);
  });

  it("drops the fixed padding the reference box adds around a line", () => {
    const shape = line();
    const marquee = { x: 1, y: 11, w: 5, h: 5 };

    expect(boundsIntersect(getShapeSelectionBounds(shape), marquee)).toBe(true);
    expect(select([shape], marquee)).toEqual([]);
  });

  it("counts a marquee that only touches the visible box as a hit", () => {
    // The arc's visible box starts at 150 - HALF_STROKE_M.
    const marquee = { x: 129, y: 160, w: 20, h: 10 };
    expect(marquee.x + marquee.w).toBe(150 - HALF_STROKE_M);

    expect(select([arc()], marquee)).toEqual(["arc"]);
  });

  it("leaves a marquee that stops short of the visible box unselected", () => {
    expect(select([arc()], { x: 128.9, y: 160, w: 20, h: 10 })).toEqual([]);
  });

  it("promotes a shape inside a group to the group", () => {
    const shapes = normalizeOverlayGroups([
      group("group_1"),
      rect("a", 0, 0, { parentId: "group_1" }),
      rect("b", 500, 500, { parentId: "group_1" }),
    ]);

    expect(select(shapes, { x: 5, y: 5, w: 10, h: 10 })).toEqual(["group_1"]);
  });

  it("keeps leaves when the marquee runs inside the focused group", () => {
    const shapes = normalizeOverlayGroups([
      group("group_1"),
      rect("a", 0, 0, { parentId: "group_1" }),
      rect("b", 500, 500, { parentId: "group_1" }),
    ]);

    expect(select(shapes, { x: 5, y: 5, w: 10, h: 10 }, { focusedGroupId: "group_1" })).toEqual(["a"]);
  });

  it("adds to the current selection instead of replacing it when additive", () => {
    const shapes = [rect("a", 0, 0), rect("b", 100, 100)];
    const marquee = { x: 105, y: 105, w: 10, h: 10 };

    expect(select(shapes, marquee, { currentIds: ["a"], additive: true })).toEqual(["a", "b"]);
    expect(select(shapes, marquee, { currentIds: ["a"], additive: false })).toEqual(["b"]);
  });

  it("does not repeat an id the additive selection already holds", () => {
    const shapes = [rect("a", 0, 0), rect("b", 100, 100)];

    expect(select(shapes, { x: 5, y: 5, w: 10, h: 10 }, { currentIds: ["a"], additive: true }))
      .toEqual(["a"]);
  });

  it("never picks up a hidden shape", () => {
    const shape = rect("a", 0, 0, { hidden: true });

    expect(select([shape], { x: 5, y: 5, w: 10, h: 10 })).toEqual([]);
  });
});
