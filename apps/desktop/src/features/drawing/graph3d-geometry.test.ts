import { describe, expect, it } from "vitest";

import type { Graph3DObject } from "@/features/document";

import {
  MAX_PRIMITIVE_RING_SAMPLES,
  MIN_PRIMITIVE_RING_SAMPLES,
  buildGraph3DObjectGeometry,
  graph3DMeshIsClosed,
  graph3DPrimitiveRingSamples,
  intersectGraph3DMeshWithPlane,
  polygonArea2D,
  triangulateGraph3DPolygon,
} from "./graph3d-geometry";
import { resolveGraph3DPlane } from "./graph3d-plane";

describe("graph 3D headless geometry", () => {
  it("samples a height field written as a parametric surface", () => {
    const object: Graph3DObject = {
      id: "surface",
      kind: "parametricSurface",
      x: "u",
      y: "v",
      z: "u^2 + v^2 + s",
      u: { min: "-1", max: "1", samples: 2 },
      v: { min: "-1", max: "1", samples: 2 },
    };
    const geometry = buildGraph3DObjectGeometry(object, { s: 0.5 });
    expect(geometry.positions).toHaveLength(9);
    expect(geometry.triangles).toHaveLength(8);
    expect(geometry.positions).toContainEqual({ x: 1, y: 1, z: 2.5 });
  });

  it("builds a capped solid of revolution", () => {
    const revolution = buildGraph3DObjectGeometry({
      id: "revolution",
      kind: "solidOfRevolution",
      axis: "z",
      radius: "1 - abs(z)",
      axisRange: { min: "-1", max: "1", samples: 4 },
      angleRange: { min: "0", max: "2*pi", samples: 12 },
      capped: true,
    }, {});
    expect(revolution.positions.length).toBeGreaterThanOrEqual(60);
    expect(revolution.triangles.length).toBeGreaterThan(80);
  });

  it("uses the intersection of x=y and z=0 as a straight rotation axis", () => {
    const revolution = buildGraph3DObjectGeometry({
      id: "diagonal-revolution",
      kind: "solidOfRevolution",
      axis: {
        kind: "planeIntersection",
        equations: ["x = y", "z = 0"],
        parameter: "t",
      },
      radius: "1",
      axisRange: { min: "-1", max: "1", samples: 2 },
      angleRange: { min: "0", max: "2*pi", samples: 12 },
      capped: true,
    }, {});

    const firstRing = revolution.positions.slice(0, 12);
    const firstCenter = firstRing.reduce((sum, point) => ({
      x: sum.x + point.x / firstRing.length,
      y: sum.y + point.y / firstRing.length,
      z: sum.z + point.z / firstRing.length,
    }), { x: 0, y: 0, z: 0 });
    expect(firstCenter.x).toBeCloseTo(firstCenter.y);
    expect(firstCenter.z).toBeCloseTo(0);
    expect(Math.abs(firstCenter.x)).toBeCloseTo(1 / Math.sqrt(2));
    const lastRing = revolution.positions.slice(24, 36);
    const lastCenter = lastRing.reduce((sum, point) => ({
      x: sum.x + point.x / lastRing.length,
      y: sum.y + point.y / lastRing.length,
      z: sum.z + point.z / lastRing.length,
    }), { x: 0, y: 0, z: 0 });
    expect(lastCenter.x).toBeCloseTo(lastCenter.y);
    expect(lastCenter.z).toBeCloseTo(0);
    expect(lastCenter.x).toBeCloseTo(-firstCenter.x);
  });

  it("builds common teaching primitives and affine inequality solids", () => {
    for (const primitive of ["sphere", "cylinder", "cone"] as const) {
      const geometry = buildGraph3DObjectGeometry({
        id: primitive,
        kind: "primitive",
        primitive,
        center: { x: "0", y: "0", z: "0" },
        size: { x: "2", y: "2", z: "3" },
      }, {});
      expect(geometry.positions.length).toBeGreaterThan(20);
      expect(geometry.triangles.length).toBeGreaterThan(20);
    }

    const tetrahedron = buildGraph3DObjectGeometry({
      id: "tetrahedron",
      kind: "boundedSolid",
      inequalities: ["x >= 0", "y >= 0", "z >= 0", "x + y + z <= 1"],
      bounds: {
        x: { min: "-2", max: "2" },
        y: { min: "-2", max: "2" },
        z: { min: "-2", max: "2" },
      },
    }, {});
    expect(tetrahedron.positions).toHaveLength(4);
    expect(tetrahedron.triangles).toHaveLength(4);

    const parabolic = buildGraph3DObjectGeometry({
      id: "parabolic",
      kind: "boundedSolid",
      inequalities: ["z >= 0", "x^2 <= y", "x^2 + y^2 <= 4"],
      bounds: {
        x: { min: "-3", max: "3" },
        y: { min: "-3", max: "3" },
        z: { min: "-1", max: "3" },
      },
      resolution: 16,
    }, {});
    expect(parabolic.triangles.length).toBeGreaterThan(20);
    expect(parabolic.positions.every((point) => point.z >= -0.15)).toBe(true);

    const torus = buildGraph3DObjectGeometry({
      id: "torus",
      kind: "parametricSurface",
      x: "(2 + cos(v))*cos(u)",
      y: "(2 + cos(v))*sin(u)",
      z: "sin(v)",
      u: { min: "0", max: "2*pi", samples: 16 },
      v: { min: "0", max: "2*pi", samples: 12 },
    }, {});
    expect(graph3DMeshIsClosed(torus)).toBe(true);
  });

  it("gives a bigger sphere more segments, so its silhouette stays as smooth", () => {
    const sphere = (size: string): Graph3DObject => ({
      id: `sphere_${size}`,
      kind: "primitive",
      primitive: "sphere",
      center: { x: "0", y: "0", z: "0" },
      size: { x: size, y: size, z: size },
    });
    const small = buildGraph3DObjectGeometry(sphere("2"), {});
    const large = buildGraph3DObjectGeometry(sphere("20"), {});
    expect(large.positions.length).toBeGreaterThan(small.positions.length * 4);

    // The gap between the drawn chord and the true circle is what reads as faceting. It is held
    // roughly fixed relative to the radius, which is the whole point of scaling the count.
    const sagitta = (geometry: { positions: Array<{ x: number; y: number; z: number }> }, radius: number) => {
      const equator = geometry.positions.filter((point) => Math.abs(point.z) < 1e-9);
      const angles = equator.map((point) => Math.atan2(point.y, point.x)).sort((a, b) => a - b);
      const step = angles[1] - angles[0];
      return radius * (1 - Math.cos(step / 2));
    };
    expect(sagitta(small, 1)).toBeLessThan(0.005);
    expect(sagitta(large, 10)).toBeLessThan(0.005);
  });

  it("lets an authored plot count override the radius, within the same bounds", () => {
    const cylinder = (resolution?: number): Graph3DObject => ({
      id: "cylinder",
      kind: "primitive",
      primitive: "cylinder",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "20", y: "20", z: "2" },
      ...(resolution === undefined ? {} : { resolution }),
    });
    const automatic = buildGraph3DObjectGeometry(cylinder(), {});
    const pinned = buildGraph3DObjectGeometry(cylinder(24), {});
    expect(pinned.positions.length).toBeLessThan(automatic.positions.length);

    expect(graph3DPrimitiveRingSamples(10, undefined)).toBeGreaterThan(MIN_PRIMITIVE_RING_SAMPLES);
    expect(graph3DPrimitiveRingSamples(10, 4)).toBe(MIN_PRIMITIVE_RING_SAMPLES);
    expect(graph3DPrimitiveRingSamples(1e6, undefined)).toBe(MAX_PRIMITIVE_RING_SAMPLES);
  });

  it("extracts an implicit zero-level surface inside its declared bounds", () => {
    const sphere = buildGraph3DObjectGeometry({
      id: "implicit_sphere",
      kind: "implicitSurface",
      expression: "x^2 + y^2 + z^2 = 1",
      bounds: {
        x: { min: "-1.2", max: "1.2" },
        y: { min: "-1.2", max: "1.2" },
        z: { min: "-1.2", max: "1.2" },
      },
      resolution: 8,
    }, {});
    expect(sphere.positions.length).toBeGreaterThan(100);
    expect(sphere.triangles.length).toBeGreaterThan(50);
    expect(Math.max(...sphere.positions.map((point) => Math.hypot(point.x, point.y, point.z)))).toBeLessThan(1.15);
  });

  it("builds display planes and authored polyhedra", () => {
    const plane = buildGraph3DObjectGeometry({
      id: "plane",
      kind: "plane",
      plane: {
        kind: "pointNormal",
        point: { x: "0", y: "0", z: "s" },
        normal: { x: "0", y: "0", z: "1" },
      },
      size: { x: "4", y: "2", z: "0" },
    }, { s: 0.5 });
    expect(plane.positions).toHaveLength(4);
    expect(plane.positions.every((point) => point.z === 0.5)).toBe(true);
    expect(plane.triangles).toHaveLength(2);

    const tetrahedron = buildGraph3DObjectGeometry({
      id: "polyhedron",
      kind: "polyhedron",
      vertices: [
        { x: "0", y: "0", z: "0" },
        { x: "1", y: "0", z: "0" },
        { x: "0", y: "1", z: "0" },
        { x: "0", y: "0", z: "1" },
      ],
      faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
    }, {});
    expect(tetrahedron.positions).toHaveLength(4);
    expect(tetrahedron.triangles).toHaveLength(4);
  });

  it("turns a box-plane intersection into a filled, flattened 2D section", () => {
    const cube = buildGraph3DObjectGeometry({
      id: "cube",
      kind: "primitive",
      primitive: "box",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    }, {});
    const section = intersectGraph3DMeshWithPlane(
      cube,
      resolveGraph3DPlane({ kind: "equation", expression: "z = 0" }, {}),
    );
    expect(section.loops).toHaveLength(1);
    expect(section.loops[0].points3D).toHaveLength(4);
    expect(Math.abs(polygonArea2D(section.loops[0].points2D))).toBeCloseTo(4);
    expect(section.loops[0].triangles).toHaveLength(2);
  });

  it("cuts the same mesh with an oblique equation", () => {
    const cube = buildGraph3DObjectGeometry({
      id: "cube",
      kind: "primitive",
      primitive: "box",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    }, {});
    const section = intersectGraph3DMeshWithPlane(
      cube,
      resolveGraph3DPlane({ kind: "equation", expression: "x + y = 0" }, {}),
    );
    expect(section.loops).toHaveLength(1);
    expect(Math.abs(polygonArea2D(section.loops[0].points2D))).toBeCloseTo(4 * Math.sqrt(2));
  });

  it("triangulates a concave enclosed region without filling its notch", () => {
    const polygon = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
      { x: 1.5, y: 1.5 },
      { x: 0, y: 3 },
    ];
    const triangles = triangulateGraph3DPolygon(polygon);
    const triangleArea = triangles.reduce((total, [a, b, c]) => total + Math.abs(polygonArea2D([
      polygon[a], polygon[b], polygon[c],
    ])), 0);
    expect(triangles).toHaveLength(3);
    expect(triangleArea).toBeCloseTo(Math.abs(polygonArea2D(polygon)));
  });
});
