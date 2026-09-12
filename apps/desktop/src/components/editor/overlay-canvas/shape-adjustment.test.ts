import { describe, expect, it } from "vitest";

import { getShapeAdjustmentReadout } from "./shape-adjustment";
import type { OverlayCalloutShape, OverlayGeoShape } from "./types";

function createGeoShape(geo: "triangle" | "blockArrow", props: Partial<OverlayGeoShape["props"]> = {}): OverlayGeoShape {
  return {
    id: `shape_${geo}`,
    type: "geo",
    x: 10,
    y: 20,
    props: {
      w: 200,
      h: 100,
      geo,
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
      ...props,
    },
  };
}

describe("shape adjustment readouts", () => {
  it("reports the triangle apex position", () => {
    const shape = createGeoShape("triangle", { apexX: 80 });
    expect(getShapeAdjustmentReadout(shape, { type: "triangleApex" })).toEqual({ id: "apex", values: { value: "40%" } });
  });

  it("reports block-arrow head and shaft ratios", () => {
    const shape = createGeoShape("blockArrow", { headLengthRatio: 0.35, shaftRatio: 0.6 });
    expect(getShapeAdjustmentReadout(shape, { type: "blockArrowHead" })).toEqual({ id: "arrowHead", values: { value: "35%" } });
    expect(getShapeAdjustmentReadout(shape, { type: "blockArrowShaft" })).toEqual({ id: "arrowShaft", values: { value: "60%" } });
  });

  it("reports the callout corner radius", () => {
    const shape: OverlayCalloutShape = {
      id: "shape_callout",
      type: "callout",
      x: 0,
      y: 0,
      props: {
        w: 160,
        h: 72,
        radius: 24,
        tail: {
          baseStart: { x: 36, y: 72 },
          baseEnd: { x: 68, y: 72 },
          tip: { x: 24, y: 100 },
        },
        blocks: [{ type: "paragraph", id: "shape_adjustment_test_31", children: [] }],
        color: "black",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    };

    expect(getShapeAdjustmentReadout(shape, { type: "calloutCornerRadius" })).toEqual({ id: "cornerRadius", values: { value: 24 } });
  });
});
