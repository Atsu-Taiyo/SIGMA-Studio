import { describe, expect, it } from "vitest";

import type { OverlayCalloutShape, OverlayTextBlock } from "@/features/document";

import {
  getCalloutGeometry,
  getCalloutPath,
  toEffectiveCalloutPoint,
  toStoredCalloutPoint,
} from "./callout-geometry";
import { getCalloutBodySize } from "./overlay-text-box";

let blockId = 0;

function blocksOf(text: string): OverlayTextBlock[] {
  return [{ type: "paragraph", id: `p_${blockId += 1}`, children: [{ type: "text", text }] }];
}

function callout(overrides: Partial<OverlayCalloutShape["props"]> = {}): OverlayCalloutShape {
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
      blocks: blocksOf("説明"),
      color: "#111111",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
      ...overrides,
    },
  };
}

/**
 * A callout whose content occupies more lines (7 hard-broken lines at the 16px default line box,
 * plus padding on both sides) than the stored 72px height allows, so `getCalloutBodySize` grows
 * its effective height — the regime every test below cares about.
 */
function growingCallout(overrides: Partial<OverlayCalloutShape["props"]> = {}): OverlayCalloutShape {
  return callout({
    blocks: blocksOf("説明\n説明\n説明\n説明\n説明\n説明\n説明"),
    ...overrides,
  });
}

describe("getCalloutBodySize growth precondition", () => {
  it("grows the body height (but not width) for the shared growing fixture", () => {
    const shape = growingCallout();
    const body = getCalloutBodySize(shape);

    expect(body.w).toBe(shape.props.w);
    expect(body.h).toBeGreaterThan(shape.props.h);
  });
});

describe("toEffectiveCalloutPoint / toStoredCalloutPoint", () => {
  it("round-trips points on every edge, interior, and exterior of the body rect", () => {
    const shape = growingCallout();
    const h0 = shape.props.h;
    const points = [
      { x: 0, y: 0 }, // top-left corner
      { x: 80, y: 0 }, // top edge
      { x: 160, y: 0 }, // top-right corner
      { x: 160, y: 36 }, // right edge, interior
      { x: 160, y: h0 }, // bottom-right corner (on the pre-growth bottom edge)
      { x: 80, y: h0 }, // bottom edge — this is where a tail's foot is stored
      { x: 0, y: h0 }, // bottom-left corner
      { x: 0, y: 36 }, // left edge, interior
      { x: -24, y: h0 + 28 }, // free tip, outside the box below (the tail-tip default)
      { x: -100, y: -50 }, // arbitrary point outside on both axes
    ];

    for (const p of points) {
      const roundTripped = toStoredCalloutPoint(shape, toEffectiveCalloutPoint(shape, p));
      expect(roundTripped.x).toBeCloseTo(p.x, 6);
      expect(roundTripped.y).toBeCloseTo(p.y, 6);
    }
  });

  it("is idempotent: repeating the same conversion on its own output changes nothing further", () => {
    const shape = growingCallout();
    const p = { x: 80, y: shape.props.h };

    const effective = toEffectiveCalloutPoint(shape, p);
    const roundTripped = toStoredCalloutPoint(shape, effective);
    const effectiveAgain = toEffectiveCalloutPoint(shape, roundTripped);

    expect(roundTripped.x).toBeCloseTo(p.x, 6);
    expect(roundTripped.y).toBeCloseTo(p.y, 6);
    expect(effectiveAgain.x).toBeCloseTo(effective.x, 6);
    expect(effectiveAgain.y).toBeCloseTo(effective.y, 6);
  });

  it("translates a point stored exactly on the bottom edge onto the new bottom edge (not into the interior)", () => {
    const shape = growingCallout();
    const body = getCalloutBodySize(shape);
    const footOnBottomEdge = { x: 40, y: shape.props.h };

    const effective = toEffectiveCalloutPoint(shape, footOnBottomEdge);

    expect(effective.y).toBe(body.h);
  });

  it("shifts a free tip below the box by exactly the height growth, not by a ratio (no scalePoint)", () => {
    const shape = growingCallout();
    const h0 = shape.props.h;
    const body = getCalloutBodySize(shape);
    const tip = { x: 24, y: h0 + 28 };

    const effective = toEffectiveCalloutPoint(shape, tip);

    expect(effective.y).toBeCloseTo(tip.y + (body.h - h0), 6);
    // A ratio scale (`tip.y * body.h / h0`) would land somewhere very different once the box
    // has grown a lot — assert the two disagree so this test would fail if a future change
    // swapped the translate branch for a scale.
    expect(Math.abs(effective.y - (tip.y * body.h) / h0)).toBeGreaterThan(1);
  });

  it("scales an interior point on the left/right side proportionally", () => {
    const shape = growingCallout();
    const h0 = shape.props.h;
    const body = getCalloutBodySize(shape);
    const p = { x: 160, y: 36 }; // right edge, partway down — strictly interior on the y axis

    const effective = toEffectiveCalloutPoint(shape, p);

    expect(effective.y).toBeCloseTo((36 * body.h) / h0, 6);
  });

  it("leaves points unchanged when the body hasn't grown (degenerate/identity case)", () => {
    const shape = callout(); // short content, hEff === h0
    const p = { x: 40, y: shape.props.h };

    expect(toEffectiveCalloutPoint(shape, p)).toEqual(p);
    expect(toStoredCalloutPoint(shape, p)).toEqual(p);
  });
});

describe("getCalloutGeometry base-side stability after body growth (flip regression guard)", () => {
  it("keeps a tail base stored on the bottom edge classified as bottom after the body grows taller", () => {
    const shape = growingCallout();

    const geometry = getCalloutGeometry(shape);

    expect(geometry.baseStart.side).toBe("bottom");
    expect(geometry.baseEnd.side).toBe("bottom");
  });

  it("places the effective bottom edge at the grown height, not the stored height", () => {
    const shape = growingCallout();
    const body = getCalloutBodySize(shape);

    const geometry = getCalloutGeometry(shape);

    expect(body.h).toBeGreaterThan(shape.props.h);
    expect(geometry.baseStart.y).toBe(body.h);
    expect(geometry.baseEnd.y).toBe(body.h);
  });

  it("never mutates the shape it reads", () => {
    const shape = growingCallout();
    const before = structuredClone(shape);

    getCalloutGeometry(shape);

    expect(shape).toEqual(before);
  });
});

describe("getCalloutPath after body growth", () => {
  it("draws the bottom edge at the grown height, not the stored height", () => {
    const shape = growingCallout();
    const body = getCalloutBodySize(shape);

    const path = getCalloutPath(shape);

    expect(body.h).toBeGreaterThan(shape.props.h);
    expect(path).toContain(` ${body.h}`);
    expect(path).not.toContain(` ${shape.props.h} `);
  });

  it("is idempotent across repeated calls", () => {
    const shape = growingCallout();

    expect(getCalloutPath(shape)).toBe(getCalloutPath(shape));
  });
});
