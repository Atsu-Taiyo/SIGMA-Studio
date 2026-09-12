import {
  add,
  subtract,
  scale,
  dot,
  cross,
  length,
  type Graph3DPoint2,
  type Graph3DPoint3,
} from "./graph3d-vector";
import type {
  Graph3DExpressionVector3,
  Graph3DPlaneDefinition,
} from "@/features/document";

import {
  evaluateMathEquation,
  evaluateMathExpression,
  type MathExpressionVariables,
} from "./math-expression";
import { Graph3DModelError, type Graph3DModelErrorCode } from "./graph3d-errors";

export type { Graph3DPoint2, Graph3DPoint3 } from "./graph3d-vector";

const EPSILON = 1e-10;

export interface ResolvedGraph3DPlane {
  /** Unit normal in canonical z-up mathematical coordinates. */
  normal: Graph3DPoint3;
  /** Plane equation: `dot(normal, point) = constant`. */
  constant: number;
  point: Graph3DPoint3;
}

export interface Graph3DPlaneBasis {
  origin: Graph3DPoint3;
  u: Graph3DPoint3;
  v: Graph3DPoint3;
  normal: Graph3DPoint3;
}

export function resolveGraph3DPlane(
  definition: Graph3DPlaneDefinition,
  variables: MathExpressionVariables,
): ResolvedGraph3DPlane {
  if (definition.kind === "equation") {
    return resolveEquationPlane(definition.expression, variables);
  }
  if (definition.kind === "threePoints") {
    const [p, q, r] = definition.points.map((point) => evaluateVector(point, variables)) as [
      Graph3DPoint3,
      Graph3DPoint3,
      Graph3DPoint3,
    ];
    const normal = normalize(cross(subtract(q, p), subtract(r, p)), "planePointsCollinear");
    return { normal, constant: dot(normal, p), point: p };
  }

  const point = evaluateVector(definition.point, variables);
  const normal = normalize(
    evaluateVector(definition.normal, variables),
    "planeNormalZero",
  );
  return { normal, constant: dot(normal, point), point };
}

export function createGraph3DPlaneBasis(
  p: Graph3DPoint3,
  q: Graph3DPoint3,
  r: Graph3DPoint3,
): Graph3DPlaneBasis {
  const u = normalize(subtract(q, p), "planeFirstPointsEqual");
  const normal = normalize(cross(subtract(q, p), subtract(r, p)), "planePointsCollinear");
  const v = normalize(cross(normal, u), "planeBasisFailed");
  return { origin: p, u, v, normal };
}

export function createGraph3DPlaneBasisFromPlane(
  plane: ResolvedGraph3DPlane,
): Graph3DPlaneBasis {
  const reference = leastParallelAxis(plane.normal);
  const u = normalize(cross(reference, plane.normal), "planeBasisFailed");
  const v = normalize(cross(plane.normal, u), "planeBasisFailed");
  return { origin: plane.point, u, v, normal: plane.normal };
}

export function flattenGraph3DPoint(
  point: Graph3DPoint3,
  basis: Graph3DPlaneBasis,
): Graph3DPoint2 {
  const relative = subtract(point, basis.origin);
  return { x: dot(relative, basis.u), y: dot(relative, basis.v) };
}

export function unflattenGraph3DPoint(
  point: Graph3DPoint2,
  basis: Graph3DPlaneBasis,
): Graph3DPoint3 {
  return add(basis.origin, add(scale(basis.u, point.x), scale(basis.v, point.y)));
}

function resolveEquationPlane(
  expression: string,
  variables: MathExpressionVariables,
): ResolvedGraph3DPlane {
  const evaluateAt = (point: Graph3DPoint3) => evaluateMathEquation(expression, {
    ...variables,
    x: point.x,
    y: point.y,
    z: point.z,
  });
  const zero = { x: 0, y: 0, z: 0 };
  const offset = evaluateAt(zero);
  const coefficients = {
    x: evaluateAt({ x: 1, y: 0, z: 0 }) - offset,
    y: evaluateAt({ x: 0, y: 1, z: 0 }) - offset,
    z: evaluateAt({ x: 0, y: 0, z: 1 }) - offset,
  };

  for (const sample of [
    { x: 2, y: 0, z: 0 },
    { x: 0, y: -1.5, z: 0 },
    { x: 0, y: 0, z: 2.5 },
    { x: 0.5, y: -0.75, z: 1.25 },
    { x: 1, y: 1, z: 1 },
  ]) {
    const expected = offset + dot(coefficients, sample);
    const actual = evaluateAt(sample);
    if (Math.abs(actual - expected) > 1e-8 * Math.max(1, Math.abs(actual), Math.abs(expected))) {
      throw new Graph3DModelError("planeEquationNotLinear");
    }
  }

  const magnitude = length(coefficients);
  if (magnitude <= EPSILON) {
    throw new Graph3DModelError("planeFromEquationFailed");
  }
  const normal = scale(coefficients, 1 / magnitude);
  const constant = -offset / magnitude;
  return { normal, constant, point: scale(normal, constant) };
}

function evaluateVector(
  vector: Graph3DExpressionVector3,
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  return {
    x: evaluateMathExpression(vector.x, variables),
    y: evaluateMathExpression(vector.y, variables),
    z: evaluateMathExpression(vector.z, variables),
  };
}

function leastParallelAxis(normal: Graph3DPoint3): Graph3DPoint3 {
  const absolute = { x: Math.abs(normal.x), y: Math.abs(normal.y), z: Math.abs(normal.z) };
  if (absolute.x <= absolute.y && absolute.x <= absolute.z) return { x: 1, y: 0, z: 0 };
  if (absolute.y <= absolute.z) return { x: 0, y: 1, z: 0 };
  return { x: 0, y: 0, z: 1 };
}

function normalize(vector: Graph3DPoint3, errorCode: Graph3DModelErrorCode): Graph3DPoint3 {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) throw new Graph3DModelError(errorCode);
  return scale(vector, 1 / magnitude);
}
