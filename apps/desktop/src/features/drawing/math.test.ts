import { describe, expect, it } from "vitest";

import {
  boundsIntersect,
  getAxisAlignedRotatedBounds,
  getBoundsUnion,
  getRotatedBoundsCorners,
  rotatedBoundsIntersectBounds,
} from "./math";

const QUARTER_TURN = Math.PI / 4;

/** A band 200 x 20 turned an eighth of a circle: the widest gap between its OBB and its AABB. */
const BAND = { x: 100, y: 100, w: 200, h: 20 };
const BAND_PIVOT = { x: 200, y: 110 };

describe("getBoundsUnion", () => {
  it("returns null for an empty collection", () => {
    expect(getBoundsUnion([])).toBeNull();
  });

  it("returns the smallest bounds containing every input", () => {
    expect(getBoundsUnion([
      { x: 10, y: 20, w: 30, h: 40 },
      { x: -5, y: 35, w: 20, h: 10 },
    ])).toEqual({ x: -5, y: 20, w: 45, h: 40 });
  });
});

describe("getRotatedBoundsCorners", () => {
  it("returns the four corners unmoved when there is no rotation", () => {
    expect(getRotatedBoundsCorners({ x: 10, y: 20, w: 30, h: 40 }, 0)).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
  });

  it("agrees with the axis-aligned box the same rotation produces", () => {
    const corners = getRotatedBoundsCorners(BAND, QUARTER_TURN);
    const box = getAxisAlignedRotatedBounds(BAND, QUARTER_TURN);

    expect(Math.min(...corners.map((corner) => corner.x))).toBeCloseTo(box.x, 9);
    expect(Math.min(...corners.map((corner) => corner.y))).toBeCloseTo(box.y, 9);
    expect(Math.max(...corners.map((corner) => corner.x))).toBeCloseTo(box.x + box.w, 9);
    expect(Math.max(...corners.map((corner) => corner.y))).toBeCloseTo(box.y + box.h, 9);
  });

  it("turns around the given pivot rather than the box's own centre", () => {
    const [first] = getRotatedBoundsCorners({ x: 10, y: 0, w: 10, h: 10 }, Math.PI, { x: 0, y: 0 });

    expect(first.x).toBeCloseTo(-10, 9);
    expect(first.y).toBeCloseTo(0, 9);
  });
});

describe("rotatedBoundsIntersectBounds", () => {
  const unrotated = { x: 0, y: 0, w: 10, h: 10 };

  it.each([
    ["overlapping", { x: 5, y: 5, w: 10, h: 10 }],
    ["touching", { x: 10, y: 0, w: 5, h: 5 }],
    ["disjoint", { x: 11, y: 0, w: 5, h: 5 }],
  ])("matches boundsIntersect for %s boxes when there is no rotation", (_label, other) => {
    expect(rotatedBoundsIntersectBounds(unrotated, 0, undefined, other))
      .toBe(boundsIntersect(unrotated, other));
  });

  it("misses a box that only reaches the empty corner of the axis-aligned box", () => {
    const corner = { x: 122.5, y: 32.5, w: 5, h: 5 };

    expect(boundsIntersect(getAxisAlignedRotatedBounds(BAND, QUARTER_TURN, BAND_PIVOT), corner))
      .toBe(true);
    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, corner)).toBe(false);
  });

  it("counts a box that only touches a corner of the turned rectangle as a hit", () => {
    const [top] = getRotatedBoundsCorners(BAND, QUARTER_TURN, BAND_PIVOT);
    const start = { x: top.x - 10, y: top.y - 10 };
    // Sized from the corner rather than by a literal 10, so the far edge lands on it exactly.
    const touching = { x: start.x, y: start.y, w: top.x - start.x, h: top.y - start.y };
    expect(touching.y + touching.h).toBe(top.y);

    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, touching)).toBe(true);
  });

  it("leaves a box that stops just short of the turned rectangle unhit", () => {
    const [top] = getRotatedBoundsCorners(BAND, QUARTER_TURN, BAND_PIVOT);
    const short = { x: top.x - 10.5, y: top.y - 10.5, w: 10, h: 10 };

    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, short)).toBe(false);
  });

  it("misses a box lying alongside the long edge but still inside the axis-aligned box", () => {
    // Separated along the rectangle's own short axis, unlike the corner case above.
    const alongside = { x: 123, y: 182, w: 5, h: 5 };

    expect(boundsIntersect(getAxisAlignedRotatedBounds(BAND, QUARTER_TURN, BAND_PIVOT), alongside))
      .toBe(true);
    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, alongside)).toBe(false);
  });

  it("misses a box that is nowhere near the rectangle", () => {
    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, { x: 400, y: 0, w: 10, h: 10 }))
      .toBe(false);
  });

  it("hits when the turned rectangle is wholly inside the other box", () => {
    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, { x: 0, y: 0, w: 400, h: 400 }))
      .toBe(true);
  });

  it("hits when the other box is wholly inside the turned rectangle", () => {
    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, { x: 198, y: 108, w: 4, h: 4 }))
      .toBe(true);
  });

  it("crosses the turned rectangle without containing any of its corners", () => {
    // A long thin box laid across the band: no corner of either shape sits inside the other.
    expect(rotatedBoundsIntersectBounds(BAND, QUARTER_TURN, BAND_PIVOT, { x: 190, y: 0, w: 20, h: 400 }))
      .toBe(true);
  });
});
