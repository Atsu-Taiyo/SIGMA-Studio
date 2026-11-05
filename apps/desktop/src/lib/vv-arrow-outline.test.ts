import { describe, expect, it } from "vitest";

import {
  VV_ARROW_DESIGN,
  VV_ARROW_HEIGHT,
  VV_ARROW_LEFT_SLICE_PATHS,
  VV_ARROW_RIGHT_SLICE_PATHS,
  VV_ARROW_RISE,
  VV_ARROW_SLICE_WIDTH,
} from "@/lib/vv-arrow-outline";
import { VV_KATEX_DEF, VV_MATHLIVE_DEF } from "@/lib/vv-vector";

/** End points of every segment (M, H, V, L, C, A, Z), in SVG coordinates. */
function endPoints(d: string): [number, number][] {
  const points: [number, number][] = [];
  let x = 0, y = 0;
  for (const [, command, args] of d.matchAll(/([MHVLCAZ])([^MHVLCAZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (command === "H") x = n[0];
    else if (command === "V") y = n[0];
    else if (command !== "Z") [x, y] = n.slice(-2) as [number, number];
    // Bézier control points bound their curve, so they must stay inside too.
    if (command === "C") for (let i = 0; i < 4; i += 2) points.push([n[i], n[i + 1]]);
    points.push([x, y]);
  }
  return points;
}

describe("the \\vv arrow outline", () => {
  const axis = VV_ARROW_HEIGHT / 2;
  const shaftTop = axis - VV_ARROW_DESIGN.shaft / 2;
  const shaftBottom = axis + VV_ARROW_DESIGN.shaft / 2;

  it("has a centred shaft with a round start at the inset", () => {
    const [shaft] = VV_ARROW_LEFT_SLICE_PATHS;
    const start = VV_ARROW_DESIGN.inset + VV_ARROW_DESIGN.shaft / 2;
    expect(shaft).toBe(`M${start} ${shaftTop}H${VV_ARROW_SLICE_WIDTH}V${shaftBottom}H${start}A20 20 0 0 1 ${start} ${shaftTop}Z`);
    expect(VV_ARROW_RIGHT_SLICE_PATHS[0]).toMatch(new RegExp(`^M0 ${shaftTop}H[\\d.]+V${shaftBottom}H0Z$`));
  });

  it("ends in a sharp tip flush with the right edge, and keeps all ink inside the box", () => {
    const head = VV_ARROW_RIGHT_SLICE_PATHS[1];
    expect(head).toContain(`L${VV_ARROW_SLICE_WIDTH} ${axis}L`);
    const points = [...VV_ARROW_LEFT_SLICE_PATHS, ...VV_ARROW_RIGHT_SLICE_PATHS].flatMap(endPoints);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(VV_ARROW_SLICE_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(VV_ARROW_HEIGHT);
    }
    // The head is symmetric about the shaft's axis.
    const ys = endPoints(head).map(([, y]) => Math.round((y - axis) * 100) / 100);
    expect(Math.max(...ys)).toBeCloseTo(-Math.min(...ys), 1);
    // Its barbs reach back by the design's length and out to nearly the box's edge.
    const xs = endPoints(head).map(([x]) => x);
    expect(VV_ARROW_SLICE_WIDTH - Math.min(...xs)).toBeGreaterThan(VV_ARROW_DESIGN.barbBack);
    expect(Math.max(...ys)).toBeGreaterThan(axis - 3);
  });

  it("fits in the head room each engine can reserve in every style", () => {
    expect(VV_ARROW_RISE).toBe(VV_ARROW_DESIGN.clearance + VV_ARROW_HEIGHT / 2);
    // Each slot rule is a real, positive box: the arrow is never lower than the engines' own gap.
    for (const def of [VV_MATHLIVE_DEF, VV_KATEX_DEF]) {
      const rules = [...def.matchAll(/\\rule\{([\d.]+)em\}\{(-?[\d.]+)em\}/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(rules).toHaveLength(4);
      for (const [width, height] of rules) {
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
      }
    }
  });
});
