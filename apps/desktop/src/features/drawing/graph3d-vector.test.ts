import { describe, expect, expectTypeOf, it } from "vitest";

import type { Graph3DPoint2 as PlanePoint2, Graph3DPoint3 as PlanePoint3 } from "./graph3d-plane";
import {
  add,
  cross,
  dot,
  length,
  scale,
  subtract,
  type Graph3DPoint2,
  type Graph3DPoint3,
} from "./graph3d-vector";

describe("graph 3D vector arithmetic", () => {
  it("preserves the point types exposed by the plane module", () => {
    expectTypeOf<Graph3DPoint2>().toEqualTypeOf<PlanePoint2>();
    expectTypeOf<Graph3DPoint3>().toEqualTypeOf<PlanePoint3>();
  });

  it("composes translations without mutating or returning either input", () => {
    const point = Object.freeze({ x: 2, y: -3, z: 5 });
    const offset = Object.freeze({ x: -7, y: 11, z: 13 });

    expect(subtract(add(point, offset), offset)).toEqual(point);
    for (const result of [add(point, offset), subtract(point, offset), scale(point, 1), cross(point, offset)]) {
      expect(result).not.toBe(point);
      expect(result).not.toBe(offset);
    }
    expect(scale(point, 0)).toEqual({ x: 0, y: -0, z: 0 });
  });

  it("keeps cross products perpendicular and right handed in mathematical coordinates", () => {
    const first = { x: 2, y: -3, z: 5 };
    const second = { x: -7, y: 11, z: 13 };
    const normal = cross(first, second);

    expect(dot(normal, first)).toBe(0);
    expect(dot(normal, second)).toBe(0);
    expect(cross(second, first)).toEqual(scale(normal, -1));
    expect(cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }))
      .toEqual({ x: 0, y: 0, z: 1 });
  });

  it("measures extreme finite vectors without squaring overflow or underflow", () => {
    for (const factor of [1e-200, 1e200]) {
      expect(length({ x: 3 * factor, y: 4 * factor, z: 0 }) / factor).toBeCloseTo(5);
    }
    expect(length({ x: 0, y: 0, z: 0 })).toBe(0);
    expect(length({ x: Infinity, y: 0, z: 0 })).toBe(Infinity);
    expect(length({ x: NaN, y: 0, z: 0 })).toBeNaN();
  });
});
