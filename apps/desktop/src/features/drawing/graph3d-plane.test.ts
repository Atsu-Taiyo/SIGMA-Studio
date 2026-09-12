import { describe, expect, it } from "vitest";

import {
  createGraph3DPlaneBasis,
  flattenGraph3DPoint,
  resolveGraph3DPlane,
  unflattenGraph3DPoint,
} from "./graph3d-plane";
import { Graph3DModelError } from "./graph3d-errors";

describe("graph 3D cutting planes", () => {
  it("resolves affine equations including animated parameters", () => {
    const diagonal = resolveGraph3DPlane(
      { kind: "equation", expression: "x + y = 1" },
      {},
    );
    expect(diagonal.normal.x).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.normal.y).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.normal.z).toBeCloseTo(0);
    expect(diagonal.constant).toBeCloseTo(Math.SQRT1_2);

    const moving = resolveGraph3DPlane(
      { kind: "equation", expression: "z = s" },
      { s: 0.4 },
    );
    expect(moving.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(moving.constant).toBeCloseTo(0.4);
  });

  it("resolves three points and point-normal definitions through the same plane model", () => {
    const fromPoints = resolveGraph3DPlane({
      kind: "threePoints",
      points: [
        { x: "1", y: "2", z: "3" },
        { x: "3", y: "2", z: "3" },
        { x: "1", y: "5", z: "3" },
      ],
    }, {});
    expect(fromPoints.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(fromPoints.constant).toBe(3);

    const fromNormal = resolveGraph3DPlane({
      kind: "pointNormal",
      point: { x: "0", y: "0", z: "s" },
      normal: { x: "1", y: "1", z: "1" },
    }, { s: 2 });
    expect(fromNormal.constant).toBeCloseTo(2 / Math.sqrt(3));
  });

  it("rejects nonlinear equations and collinear three-point definitions", () => {
    let nonlinearError: unknown;
    try {
      resolveGraph3DPlane(
      { kind: "equation", expression: "x^2 + y = 1" },
      {},
      );
    } catch (error) {
      nonlinearError = error;
    }
    expect(nonlinearError).toBeInstanceOf(Graph3DModelError);
    expect((nonlinearError as Graph3DModelError).code).toBe("planeEquationNotLinear");

    let collinearError: unknown;
    try {
      resolveGraph3DPlane({
      kind: "threePoints",
      points: [
        { x: "0", y: "0", z: "0" },
        { x: "1", y: "1", z: "1" },
        { x: "2", y: "2", z: "2" },
      ],
      }, {});
    } catch (error) {
      collinearError = error;
    }
    expect(collinearError).toBeInstanceOf(Graph3DModelError);
    expect((collinearError as Graph3DModelError).code).toBe("planePointsCollinear");
  });

  it("flattens an arbitrary 3D plane into stable 2D coordinates and restores it", () => {
    const basis = createGraph3DPlaneBasis(
      { x: 1, y: 2, z: 3 },
      { x: 3, y: 2, z: 3 },
      { x: 1, y: 5, z: 3 },
    );
    const flattened = flattenGraph3DPoint({ x: 2, y: 4, z: 3 }, basis);
    expect(flattened.x).toBeCloseTo(1);
    expect(flattened.y).toBeCloseTo(2);
    expect(unflattenGraph3DPoint(flattened, basis)).toEqual({ x: 2, y: 4, z: 3 });
  });

  it("retains plane-specific direction tolerance and failure codes", () => {
    const definition = {
      kind: "pointNormal" as const,
      point: { x: "0", y: "0", z: "0" },
      normal: { x: "0", y: "0", z: "1e-10" },
    };

    expect(() => resolveGraph3DPlane(definition, {}))
      .toThrowError(expect.objectContaining({ code: "planeNormalZero" }));
    expect(resolveGraph3DPlane({
      ...definition,
      normal: { ...definition.normal, z: "2e-10" },
    }, {}).normal).toEqual({ x: 0, y: 0, z: 1 });
  });
});
