import { describe, expect, it } from "vitest";

import { getArcEndpoint } from "./render-attrs";
import type { OverlayArcShape } from "./types";

describe("getArcEndpoint screen-coordinate angle convention", () => {
  it("maps 0 radians east and pi/2 radians south", () => {
    const shape: OverlayArcShape = {
      id: "arc",
      type: "arc",
      x: 0,
      y: 0,
      props: {
        r: 40,
        rx: 40,
        ry: 20,
        startAngle: 0,
        endAngle: Math.PI / 2,
        kind: "arc",
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(getArcEndpoint(shape, "start")).toEqual({ x: 80, y: 20 });
    expect(getArcEndpoint(shape, "end")).toEqual({ x: 40, y: 40 });
  });
});
