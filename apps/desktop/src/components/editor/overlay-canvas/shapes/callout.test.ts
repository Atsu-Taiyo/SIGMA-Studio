import { describe, expect, it } from "vitest";

import type { OverlayCalloutShape } from "../types";
import {
  getCalloutCornerRadiusHandlePoint,
  getCalloutGeometry,
  getCalloutPath,
  moveCalloutTailToTip,
  snapCalloutTailBasePoint,
} from "./callout";

function callout(props: Partial<OverlayCalloutShape["props"]> = {}): OverlayCalloutShape {
  return {
    id: "shape_callout",
    type: "callout",
    x: 10,
    y: 20,
    props: {
      w: 160,
      h: 72,
      radius: 18,
      tail: {
        baseStart: { x: 36, y: 72 },
        baseEnd: { x: 68, y: 72 },
        tip: { x: 24, y: 100 },
      },
      blocks: [{ type: "paragraph", id: "callout_test_29", children: [{ type: "text", text: "説明" }] }],
      color: "#111111",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
      ...props,
    },
  };
}

describe("callout shape geometry", () => {
  it("keeps the tip free and includes it in the overall bounds", () => {
    const geometry = getCalloutGeometry(callout({
      tail: {
        baseStart: { x: 36, y: 72 },
        baseEnd: { x: 68, y: 72 },
        tip: { x: -24, y: 118 },
      },
    }));

    expect(geometry.tip).toEqual({ x: -24, y: 118 });
    expect(geometry.bounds).toEqual({ x: -24, y: 0, w: 184, h: 118 });
    expect(getCalloutPath(callout())).toContain("L 24 100");
  });

  it("snaps each base independently to its nearest body edge", () => {
    const shape = callout();

    expect(snapCalloutTailBasePoint(shape, 80, -20)).toMatchObject({ side: "top", y: 0 });
    expect(snapCalloutTailBasePoint(shape, 180, 30)).toMatchObject({ side: "right", x: 160 });
    expect(snapCalloutTailBasePoint(shape, 80, 100)).toMatchObject({ side: "bottom", y: 72 });
    expect(snapCalloutTailBasePoint(shape, -20, 30)).toMatchObject({ side: "left", x: 0 });
  });

  it("draws one continuous outline when the bases are on different edges", () => {
    const shape = callout({
      tail: {
        baseStart: { x: 40, y: 72 },
        baseEnd: { x: 160, y: 30 },
        tip: { x: 190, y: 92 },
      },
    });
    const geometry = getCalloutGeometry(shape);
    const path = getCalloutPath(shape);

    expect(geometry.baseStart.side).toBe("bottom");
    expect(geometry.baseEnd.side).toBe("right");
    expect(path).toContain("190 92");
    expect(path.endsWith("Z")).toBe(true);
  });

  it("uses the stored corner radius and exposes a single adjustment point sitting on the rounded corner's outline", () => {
    const shape = callout({ radius: 30 });
    const expectedOffset = 30 * (1 - Math.SQRT1_2);

    expect(getCalloutGeometry(shape).radius).toBe(30);
    const handlePoint = getCalloutCornerRadiusHandlePoint(shape);
    expect(handlePoint.x).toBeCloseTo(expectedOffset);
    expect(handlePoint.y).toBeCloseTo(expectedOffset);
    // 対角45°の点は角丸の中心(30,30)からちょうど半径30の距離にある(=輪郭線上)。
    expect(Math.hypot(30 - handlePoint.x, 30 - handlePoint.y)).toBeCloseTo(30);
    expect(getCalloutPath(shape)).toContain("Q 160 0 160 30");
  });

  it("moves the bases to the perimeter nearest the tip while preserving their spread", () => {
    const shape = callout();

    expect(moveCalloutTailToTip(shape, { x: 200, y: 36 })).toEqual({
      baseStart: { x: 160, y: 20 },
      baseEnd: { x: 160, y: 52 },
      tip: { x: 200, y: 36 },
    });
  });

  it("keeps both bases on a single edge (never split across a corner) no matter where the tip lands", () => {
    const shape = callout();
    const nearCornerTips = [
      { x: -30, y: -20 },
      { x: 190, y: -20 },
      { x: 190, y: 90 },
      { x: -30, y: 90 },
      { x: 150, y: 68 },
    ];

    for (const tip of nearCornerTips) {
      const tail = moveCalloutTailToTip(shape, tip);
      const sameSide = tail.baseStart.x === tail.baseEnd.x || tail.baseStart.y === tail.baseEnd.y;
      expect(sameSide, `tip ${JSON.stringify(tip)} produced bases on different edges: ${JSON.stringify(tail)}`).toBe(true);
    }
  });
});
