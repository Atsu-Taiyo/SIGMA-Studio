import { describe, expect, it } from "vitest";

import {
  createOverlaySnapGeometry,
  snapBoundsToGeometry,
  snapPointToGeometry,
  snapResizeBoundsToGeometry,
} from "./snapping";
import type { OverlayShape } from "@/features/document";

function rect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  flags: Partial<Pick<OverlayShape, "hidden" | "locked">> = {},
): Extract<OverlayShape, { type: "geo" }> {
  return {
    id,
    type: "geo",
    x,
    y,
    ...flags,
    props: {
      w,
      h,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function line(id: string, x: number, y: number, points: Array<{ x: number; y: number }>): OverlayShape {
  return {
    id,
    type: "line",
    x,
    y,
    props: {
      kind: "polyline",
      points,
      closed: false,
      color: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function arrow(id: string, x: number, y: number, start: { x: number; y: number }, end: { x: number; y: number }): OverlayShape {
  return {
    id,
    type: "arrow",
    x,
    y,
    props: {
      start,
      end,
      arrowheadEnd: "arrow",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

describe("overlay snapping", () => {
  it.each([
    ["left", { x: 98, y: 8, w: 20, h: 20 }, { x: 2, y: 0 }],
    ["center", { x: 129, y: 8, w: 20, h: 20 }, { x: 1, y: 0 }],
    ["right", { x: 161, y: 8, w: 20, h: 20 }, { x: -1, y: 0 }],
    ["top", { x: 8, y: 98, w: 20, h: 20 }, { x: 0, y: 2 }],
    ["middle", { x: 8, y: 129, w: 20, h: 20 }, { x: 0, y: 1 }],
    ["bottom", { x: 8, y: 161, w: 20, h: 20 }, { x: 0, y: -1 }],
  ] as const)("snaps moved bounds by %s alignment", (_label, movingBounds, expectedNudge) => {
    const geometry = createOverlaySnapGeometry([
      rect("target", 100, 100, 80, 80),
    ], { includePage: false });

    const snapped = snapBoundsToGeometry(movingBounds, geometry, { threshold: 4 });

    expect(snapped.snapped).toBe(true);
    expect(snapped.nudge).toEqual(expectedNudge);
    expect(snapped.guides).toHaveLength(1);
  });

  it("uses page edges and centers as snap targets", () => {
    const geometry = createOverlaySnapGeometry([], {
      canvasWidth: 300,
      canvasHeight: 200,
    });

    const snapped = snapBoundsToGeometry({ x: 139, y: 80, w: 20, h: 20 }, geometry, { threshold: 4 });

    expect(snapped.snapped).toBe(true);
    expect(snapped.nudge).toEqual({ x: 1, y: 0 });
    expect(snapped.bounds.x).toBe(140);
  });

  it("uses body vertical guide positions as snap targets", () => {
    const geometry = createOverlaySnapGeometry([], {
      canvasWidth: 300,
      canvasHeight: 200,
      verticalGuideValues: [48, 252],
    });

    const leftSnap = snapBoundsToGeometry({ x: 46, y: 80, w: 20, h: 20 }, geometry, { threshold: 4 });
    const rightSnap = snapBoundsToGeometry({ x: 231, y: 80, w: 20, h: 20 }, geometry, { threshold: 4 });
    const centerSnap = snapBoundsToGeometry({ x: 37, y: 80, w: 20, h: 20 }, geometry, { threshold: 4 });

    expect(leftSnap.snapped).toBe(true);
    expect(leftSnap.nudge).toEqual({ x: 2, y: 0 });
    expect(leftSnap.bounds.x).toBe(48);
    expect(rightSnap.snapped).toBe(true);
    expect(rightSnap.nudge).toEqual({ x: 1, y: 0 });
    expect(rightSnap.guides.some((guide) => guide.type === "line" && guide.axis === "x" && guide.value === 252)).toBe(true);
    expect(centerSnap.snapped).toBe(true);
    expect(centerSnap.nudge).toEqual({ x: 1, y: 0 });
  });

  it("ignores excluded and hidden shapes while allowing locked shapes as references", () => {
    const geometry = createOverlaySnapGeometry([
      rect("hidden", 100, 0, 40, 40, { hidden: true }),
      rect("selected", 150, 0, 40, 40),
      rect("locked", 200, 0, 40, 40, { locked: true }),
    ], {
      excludedShapeIds: ["selected"],
      includePage: false,
    });

    const nearHidden = snapBoundsToGeometry({ x: 101, y: 0, w: 20, h: 20 }, geometry, { threshold: 4 });
    const nearLocked = snapBoundsToGeometry({ x: 199, y: 0, w: 20, h: 20 }, geometry, { threshold: 4 });

    expect(nearHidden.snapped).toBe(false);
    expect(nearLocked.snapped).toBe(true);
    expect(nearLocked.nudge.x).toBe(1);
  });

  it("snaps only the active resize edge or corner", () => {
    const geometry = createOverlaySnapGeometry([
      rect("target", 100, 20, 40, 40),
    ], { includePage: false });

    const snapped = snapResizeBoundsToGeometry(
      { x: 20, y: 17, w: 77, h: 40 },
      "e",
      geometry,
      { threshold: 4 },
    );

    expect(snapped.snapped).toBe(true);
    expect(snapped.nudge).toEqual({ x: 3, y: 0 });
    expect(snapped.bounds).toEqual({ x: 20, y: 17, w: 80, h: 40 });
  });

  it("snaps line and arrow handles to shape corners and segment midpoints", () => {
    const geometry = createOverlaySnapGeometry([
      rect("box", 100, 100, 40, 40),
      line("line", 10, 200, [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
      arrow("arrow", 200, 0, { x: 0, y: 0 }, { x: 40, y: 40 }),
    ], { includePage: false });

    expect(snapPointToGeometry({ x: 98, y: 101 }, geometry, { threshold: 5 }).point).toEqual({ x: 100, y: 100 });
    expect(snapPointToGeometry({ x: 59, y: 202 }, geometry, { threshold: 5 }).point).toEqual({ x: 60, y: 200 });
    expect(snapPointToGeometry({ x: 219, y: 21 }, geometry, { threshold: 5 }).point).toEqual({ x: 220, y: 20 });
  });

  it("snaps drawing points to polygon vertices, edge midpoints, and arc endpoints", () => {
    const polygon = rect("polygon", 100, 100, 120, 120);
    polygon.props.geo = "regularPolygon";
    polygon.props.polygonSides = 12;
    const arc: OverlayShape = {
      id: "arc",
      type: "arc",
      x: 300,
      y: 100,
      props: {
        r: 40,
        startAngle: 0,
        endAngle: Math.PI,
        kind: "arc",
        color: "black",
        dash: "solid",
        size: "m",
      },
    };
    const geometry = createOverlaySnapGeometry([polygon, arc], { includePage: false });

    expect(snapPointToGeometry({ x: 159, y: 101 }, geometry, { threshold: 5 }).point).toEqual({ x: 160, y: 100 });
    expect(snapPointToGeometry({ x: 174, y: 104 }, geometry, { threshold: 5 }).snapped).toBe(true);
    expect(snapPointToGeometry({ x: 378, y: 141 }, geometry, { threshold: 5 }).point).toEqual({ x: 380, y: 140 });
  });

  it("returns unsnapped results when snapping is disabled", () => {
    const geometry = createOverlaySnapGeometry([
      rect("target", 100, 100, 80, 80),
    ], { includePage: false });

    const snapped = snapBoundsToGeometry(
      { x: 129, y: 129, w: 20, h: 20 },
      geometry,
      { disabled: true, threshold: 4 },
    );

    expect(snapped.snapped).toBe(false);
    expect(snapped.nudge).toEqual({ x: 0, y: 0 });
    expect(snapped.guides).toEqual([]);
  });
});
