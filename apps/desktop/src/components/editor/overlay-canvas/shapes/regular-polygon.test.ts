import { describe, expect, it } from "vitest";

import { getRegularPolygonPoints, REGULAR_POLYGON_SIDES } from "./regular-polygon";

describe("regular polygon geometry", () => {
  it.each(REGULAR_POLYGON_SIDES)("makes the %i-gon touch all four selection bounds", (sides) => {
    const points = getRegularPolygonPoints(180, 120, sides);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(180);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(120);
  });

  it("keeps the stroke inset while still touching every inner edge", () => {
    const points = getRegularPolygonPoints(100, 80, 7, 1);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    expect(Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...xs)).toBeCloseTo(99);
    expect(Math.min(...ys)).toBeCloseTo(1);
    expect(Math.max(...ys)).toBeCloseTo(79);
  });
});
