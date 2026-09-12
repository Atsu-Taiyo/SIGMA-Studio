import { describe, expect, it } from "vitest";

import {
  createArcShapeFromCenterDrag,
  createArcShapeFromThreePoints,
} from "./arc-creation";

describe("arc creation", () => {
  it("creates the circle passing through three points", () => {
    const shape = createArcShapeFromThreePoints(
      "arc_1",
      { x: 0, y: 0 },
      { x: 50, y: -50 },
      { x: 100, y: 0 },
      { arrowheadStart: "dot", arrowheadEnd: "arrow" },
    );

    expect(shape).not.toBeNull();
    expect(shape).toMatchObject({
      id: "arc_1",
      type: "arc",
      x: 0,
      y: -50,
      props: {
        r: 50,
        kind: "arc",
        arrowheadStart: "dot",
        arrowheadEnd: "arrow",
      },
    });
  });

  it("chooses the opposite sweep when the middle point is on the other side", () => {
    const start = { x: 0, y: 0 };
    const through = { x: 50, y: 50 };
    const end = { x: 100, y: 0 };

    const shape = createArcShapeFromThreePoints(
      "arc_1",
      start,
      through,
      end,
    );

    expect(shape).not.toBeNull();
    expect(getEndpoint(shape!, "start").x).toBeCloseTo(end.x);
    expect(getEndpoint(shape!, "start").y).toBeCloseTo(end.y);
    expect(getEndpoint(shape!, "end").x).toBeCloseTo(start.x);
    expect(getEndpoint(shape!, "end").y).toBeCloseTo(start.y);
  });

  it("rejects collinear three-point input", () => {
    expect(createArcShapeFromThreePoints(
      "arc_1",
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    )).toBeNull();
  });

  it("preserves elliptical center-drag geometry and sector defaults", () => {
    const shape = createArcShapeFromCenterDrag(
      "sector_1",
      { x: 100, y: 100 },
      { x: 180, y: 140 },
      "sector",
    );

    expect(shape.x + shape.props.rx!).toBe(100);
    expect(shape.y + shape.props.ry!).toBe(100);
    expect(shape.props).toMatchObject({
      kind: "sector",
      r: 80,
      rx: 80,
      ry: 40,
      fill: "solid",
      fillColor: "#e5e7eb",
      fillOpacity: 0.35,
    });
  });

  it("creates a center-drag arc around the selected center", () => {
    const shape = createArcShapeFromCenterDrag(
      "arc_1",
      { x: 120, y: 80 },
      { x: 180, y: 80 },
      "arc",
      { arrowheadEnd: "bar" },
    );

    expect(shape.x).toBeCloseTo(60);
    expect(shape.y).toBeCloseTo(20);
    expect(shape.props.r).toBeCloseTo(60);
    expect(shape.x + shape.props.rx!).toBeCloseTo(120);
    expect(shape.y + shape.props.ry!).toBeCloseTo(80);
    expect(shape.props.startAngle).toBeCloseTo(-Math.PI / 4);
    expect(shape.props.endAngle).toBeCloseTo(Math.PI / 4);
    expect(shape.props.arrowheadEnd).toBe("bar");
  });
});

function getEndpoint(
  shape: NonNullable<ReturnType<typeof createArcShapeFromThreePoints>>,
  endpoint: "start" | "end",
): { x: number; y: number } {
  const angle = endpoint === "start"
    ? shape.props.startAngle
    : shape.props.endAngle;
  const rx = shape.props.rx ?? shape.props.r;
  const ry = shape.props.ry ?? shape.props.r;
  return {
    x: shape.x + rx + Math.cos(angle) * rx,
    y: shape.y + ry + Math.sin(angle) * ry,
  };
}
