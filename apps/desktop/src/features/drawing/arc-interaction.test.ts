import { describe, expect, it } from "vitest";

import type { OverlayArcShape } from "@/features/document";

import {
  getArcMidAngle,
  getSnappedArcInsertDragPoint,
  scaleArcRadiusFromDrag,
} from "./arc-interaction";

describe("getArcMidAngle", () => {
  it("returns the midpoint of the positive sweep", () => {
    const shape = createTestArc({
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    expect(getArcMidAngle(shape)).toBeCloseTo(Math.PI / 4);
  });

  it("handles sweeps that wrap past pi", () => {
    const shape = createTestArc({
      startAngle: Math.PI / 2,
      endAngle: 0,
    });
    // 正方向 sweep は 270° → 中間角は 90° + 135° = 225°
    expect(getArcMidAngle(shape)).toBeCloseTo(
      Math.PI / 2 + (3 * Math.PI) / 4,
    );
  });
});

describe("scaleArcRadiusFromDrag", () => {
  it("scales the radii proportionally around a fixed center", () => {
    const shape = createTestArc({
      rx: 100,
      ry: 50,
      r: 100,
      startAngle: 0,
      endAngle: Math.PI,
    });
    // 中間角90° → ハンドルは中心の真下 (距離 ry=50)。距離150へドラッグ = 3倍
    const next = scaleArcRadiusFromDrag(shape, {
      x: 100,
      y: 50 + 150,
    });

    expect(next.props.rx).toBeCloseTo(300);
    expect(next.props.ry).toBeCloseTo(150);
    expect(next.props.r).toBeCloseTo(300);
    expect(next.x + next.props.rx!).toBeCloseTo(100);
    expect(next.y + next.props.ry!).toBeCloseTo(50);
  });

  it("clamps the minimum radius without distorting the aspect ratio", () => {
    const shape = createTestArc({
      rx: 100,
      ry: 50,
      r: 100,
      startAngle: 0,
      endAngle: Math.PI,
    });
    const next = scaleArcRadiusFromDrag(shape, { x: 100, y: 50 });

    expect(next.props.ry).toBeCloseTo(8);
    expect(next.props.rx).toBeCloseTo(16);
  });
});

describe("getSnappedArcInsertDragPoint", () => {
  it("snaps the drag direction to 15 degree steps while preserving distance", () => {
    const start = { x: 0, y: 0 };
    const angle = (52 * Math.PI) / 180;
    const point = {
      x: Math.cos(angle) * 80,
      y: Math.sin(angle) * 80,
    };

    const snapped = getSnappedArcInsertDragPoint(start, point, true);
    const snappedAngle = Math.atan2(
      snapped.y - start.y,
      snapped.x - start.x,
    );

    expect(snappedAngle).toBeCloseTo((45 * Math.PI) / 180);
    expect(
      Math.hypot(snapped.x - start.x, snapped.y - start.y),
    ).toBeCloseTo(80);
  });

  it("returns the raw point without shift", () => {
    const point = { x: 73, y: 19 };
    expect(
      getSnappedArcInsertDragPoint({ x: 0, y: 0 }, point, false),
    ).toEqual(point);
  });
});

function createTestArc(
  props: Partial<OverlayArcShape["props"]>,
): OverlayArcShape {
  const rx = props.rx ?? props.r ?? 100;
  const ry = props.ry ?? props.r ?? 100;
  // x/y=0 → 中心は (rx, ry)
  return {
    id: "shape_arc",
    type: "arc",
    x: 0,
    y: 0,
    rotation: 0,
    props: {
      kind: "arc",
      r: props.r ?? Math.max(rx, ry),
      startAngle: 0,
      endAngle: Math.PI / 2,
      color: "black",
      dash: "solid",
      size: "m",
      ...props,
    },
  };
}
