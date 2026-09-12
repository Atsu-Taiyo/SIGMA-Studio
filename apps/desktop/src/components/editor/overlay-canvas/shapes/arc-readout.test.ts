import { describe, expect, it } from "vitest";

import type { OverlayArcShape } from "@/features/document";

import { getArcDragReadoutText } from "./arc-readout";

describe("getArcDragReadoutText", () => {
  it("shows radius and sweep for insert drags", () => {
    const shape = createTestArc({
      rx: 85,
      ry: 85,
      r: 85,
      startAngle: 0,
      endAngle: (2 * Math.PI) / 3,
    });
    expect(getArcDragReadoutText(shape, "both")).toBe("r=85  120°");
  });

  it("shows rx×ry for elliptical arcs", () => {
    const shape = createTestArc({
      rx: 85,
      ry: 60,
      r: 85,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    expect(getArcDragReadoutText(shape, "radius")).toBe("85×60");
  });

  it("shows only the sweep while dragging an angle handle", () => {
    const shape = createTestArc({
      rx: 85,
      ry: 60,
      r: 85,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    expect(getArcDragReadoutText(shape, "angle")).toBe("90°");
  });
});

function createTestArc(
  props: Partial<OverlayArcShape["props"]>,
): OverlayArcShape {
  const rx = props.rx ?? props.r ?? 100;
  const ry = props.ry ?? props.r ?? 100;
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
