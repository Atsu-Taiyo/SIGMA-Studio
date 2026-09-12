import {
  add,
  subtract,
  scale,
  type Graph3DPoint3,
} from "./graph3d-vector";
import type { Graph3DExpressionVector3, Graph3DObject } from "@/features/document";

import type { Graph3DMeshGeometry } from "./graph3d-geometry";
import { evaluateMathExpression, type MathExpressionVariables } from "./math-expression";
import { Graph3DModelError } from "./graph3d-errors";

const EPSILON = 1e-9;
const FIFTEEN_DEGREES_RADIANS = Math.PI / 12;
const MIN_ROTATION_PIXELS_PER_RADIAN = 4;
const ROTATION_PROJECTION_FLOOR_RATIO = 0.3;

export function snapGraph3DRotationAngle(angle: number, constrained: boolean): number {
  if (!constrained || !Number.isFinite(angle)) return angle;
  return Math.round(angle / FIFTEEN_DEGREES_RADIANS) * FIFTEEN_DEGREES_RADIANS;
}

/**
 * Incremental turn of one local axis, stored as the same intrinsic x→y→z Euler that
 * primitives already persist. Dragging the object's own x-axis must rotate around that
 * displayed axis, not around world x after the object has already been turned.
 */
export function addGraph3DLocalAxisRotation(
  euler: Graph3DPoint3,
  axis: "x" | "y" | "z",
  angle: number,
): Graph3DPoint3 {
  if (!Number.isFinite(angle) || Math.abs(angle) <= EPSILON) return euler;
  const current = graph3DEulerToMatrix(euler);
  const increment = graph3DAxisAngleMatrix(axis, angle);
  return graph3DMatrixToEuler(multiplyGraph3DMatrix(current, increment));
}

export function graph3DEulerToMatrix(euler: Graph3DPoint3): Graph3DMatrix3 {
  const cosX = Math.cos(euler.x);
  const sinX = Math.sin(euler.x);
  const cosY = Math.cos(euler.y);
  const sinY = Math.sin(euler.y);
  const cosZ = Math.cos(euler.z);
  const sinZ = Math.sin(euler.z);
  const aroundX: Graph3DMatrix3 = [
    [1, 0, 0],
    [0, cosX, -sinX],
    [0, sinX, cosX],
  ];
  const aroundY: Graph3DMatrix3 = [
    [cosY, 0, sinY],
    [0, 1, 0],
    [-sinY, 0, cosY],
  ];
  const aroundZ: Graph3DMatrix3 = [
    [cosZ, -sinZ, 0],
    [sinZ, cosZ, 0],
    [0, 0, 1],
  ];
  return multiplyGraph3DMatrix(multiplyGraph3DMatrix(aroundZ, aroundY), aroundX);
}

export function graph3DMatrixToEuler(matrix: Graph3DMatrix3): Graph3DPoint3 {
  const sy = Math.hypot(matrix[0][0], matrix[1][0]);
  if (sy <= 1e-7) {
    return {
      x: Math.atan2(-matrix[1][2], matrix[1][1]),
      y: Math.atan2(-matrix[2][0], sy),
      z: 0,
    };
  }
  return {
    x: Math.atan2(matrix[2][1], matrix[2][2]),
    y: Math.atan2(-matrix[2][0], sy),
    z: Math.atan2(matrix[1][0], matrix[0][0]),
  };
}

export function rotateGraph3DEuler(point: Graph3DPoint3, rotation: Graph3DPoint3): Graph3DPoint3 {
  return transformGraph3DPoint(graph3DEulerToMatrix(rotation), point);
}

/** Inverse of {@link rotateGraph3DEuler}: the same x→y→z Euler, undone. */
export function unrotateGraph3DEuler(point: Graph3DPoint3, rotation: Graph3DPoint3): Graph3DPoint3 {
  return transformGraph3DPoint(transposeGraph3DMatrix(graph3DEulerToMatrix(rotation)), point);
}

export function evaluateGraph3DObjectRotation(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  return object.rotation ? evaluateGraph3DExpressionVector(object.rotation, variables) : { x: 0, y: 0, z: 0 };
}

export function evaluateGraph3DObjectTranslation(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  return object.translation ? evaluateGraph3DExpressionVector(object.translation, variables) : { x: 0, y: 0, z: 0 };
}

export function evaluateGraph3DObjectScale(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  const value = object.scale ? evaluateGraph3DExpressionVector(object.scale, variables) : { x: 1, y: 1, z: 1 };
  if (value.x <= 0 || value.y <= 0 || value.z <= 0) {
    throw new Graph3DModelError("solidScaleNotPositive");
  }
  return value;
}

export function graph3DRotationExpression(rotation: Graph3DPoint3): Graph3DExpressionVector3 {
  return {
    x: formatGraph3DAngle(rotation.x),
    y: formatGraph3DAngle(rotation.y),
    z: formatGraph3DAngle(rotation.z),
  };
}

export function graph3DVectorExpression(vector: Graph3DPoint3): Graph3DExpressionVector3 {
  return {
    x: formatGraph3DNumber(vector.x),
    y: formatGraph3DNumber(vector.y),
    z: formatGraph3DNumber(vector.z),
  };
}

export function isZeroGraph3DRotation(rotation: Graph3DPoint3): boolean {
  return Math.abs(rotation.x) <= EPSILON && Math.abs(rotation.y) <= EPSILON && Math.abs(rotation.z) <= EPSILON;
}
export function applyGraph3DMeshRotation(
  geometry: Graph3DMeshGeometry,
  rotation: Graph3DPoint3,
  origin: Graph3DPoint3,
): Graph3DMeshGeometry {
  if (isZeroRotation(rotation)) return geometry;
  return {
    ...geometry,
    positions: geometry.positions.map((point) => add(rotateGraph3DEuler(subtract(point, origin), rotation), origin)),
  };
}

/**
 * Applies the persisted affine transform without rewriting authored equations.
 *
 * A point is scaled in the object's local frame, rotated about the same origin, then translated
 * in world coordinates. Keeping this as a semantic SigmaDoc transform means an inequality such
 * as `x+y+z<=3` stays parseable and can be evaluated through the inverse transform.
 */
export function applyGraph3DMeshTransform(
  geometry: Graph3DMeshGeometry,
  rotation: Graph3DPoint3,
  scaleFactors: Graph3DPoint3,
  translation: Graph3DPoint3,
  origin: Graph3DPoint3,
): Graph3DMeshGeometry {
  const unchangedScale = Math.abs(scaleFactors.x - 1) <= EPSILON &&
    Math.abs(scaleFactors.y - 1) <= EPSILON &&
    Math.abs(scaleFactors.z - 1) <= EPSILON;
  if (isZeroRotation(rotation) && unchangedScale && isZeroGraph3DRotation(translation)) return geometry;
  return {
    ...geometry,
    positions: geometry.positions.map((point) => {
      const local = subtract(point, origin);
      const scaled = {
        x: local.x * scaleFactors.x,
        y: local.y * scaleFactors.y,
        z: local.z * scaleFactors.z,
      };
      return add(add(rotateGraph3DEuler(scaled, rotation), origin), translation);
    }),
  };
}

/**
 * Turn implied by one pointer step, in radians.
 *
 * `screenPerRadian` is how far the grabbed point of the gizmo travels on screen while the solid
 * turns one radian about the dragged axis, so projecting the pointer step onto it converts pixels
 * back into an angle, and the handle stays under the cursor. Re-measuring it every frame keeps a
 * drag continuous through any number of turns: reading the angle between two hit points instead
 * caps a drag at the ±π that `atan2` can express, and hit points taken on a plane that contains
 * the axis can only ever report 0 or π.
 *
 * `quarterTurnScreenPerRadian` is the same measure a quarter turn further along the circle, where
 * the projection is at its widest. It sets the floor for the divisor: a circle seen edge-on
 * projects the turn around its near and far points onto almost no pixels, and dividing by that
 * would spin the solid arbitrarily fast at exactly the orientation the user cannot aim at. The
 * floor is relative because "almost no pixels" only means anything next to how large the gizmo is
 * on screen right now.
 */
export function graph3DPointerRotationStep(
  pointerStep: Graph3DScreenVector,
  screenPerRadian: Graph3DScreenVector,
  quarterTurnScreenPerRadian: Graph3DScreenVector,
): number {
  const length = Math.hypot(screenPerRadian.x, screenPerRadian.y);
  if (!Number.isFinite(length) || length <= EPSILON) return 0;
  const widest = Math.hypot(quarterTurnScreenPerRadian.x, quarterTurnScreenPerRadian.y);
  const floor = Math.max(
    MIN_ROTATION_PIXELS_PER_RADIAN,
    Number.isFinite(widest) ? widest * ROTATION_PROJECTION_FLOOR_RATIO : 0,
  );
  const along = (pointerStep.x * screenPerRadian.x + pointerStep.y * screenPerRadian.y) / length;
  const step = along / Math.max(length, floor);
  return Number.isFinite(step) ? step : 0;
}

/** Screen-space vector in CSS pixels, y pointing down as pointer events report it. */
export type Graph3DScreenVector = { x: number; y: number };

export function graph3DMeshCentroid(positions: readonly Graph3DPoint3[]): Graph3DPoint3 {
  if (positions.length === 0) return { x: 0, y: 0, z: 0 };
  const sum = positions.reduce((total, point) => add(total, point), { x: 0, y: 0, z: 0 });
  return scale(sum, 1 / positions.length);
}

export function graph3DObjectRotationOrigin(
  object: Graph3DObject,
  positions: readonly Graph3DPoint3[],
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  if (object.kind === "primitive") {
    return evaluateGraph3DExpressionVector(object.center, variables);
  }
  if (object.kind === "point") {
    return evaluateGraph3DExpressionVector(object.position, variables);
  }
  return graph3DMeshCentroid(positions);
}

/** Origin shown by the direct-manipulation gizmo after the authored translation is applied. */
export function graph3DObjectTransformedOrigin(
  object: Graph3DObject,
  transformedPositions: readonly Graph3DPoint3[],
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  if (object.kind === "primitive") {
    return add(evaluateGraph3DExpressionVector(object.center, variables), evaluateGraph3DObjectTranslation(object, variables));
  }
  if (object.kind === "point") {
    return add(evaluateGraph3DExpressionVector(object.position, variables), evaluateGraph3DObjectTranslation(object, variables));
  }
  return graph3DMeshCentroid(transformedPositions);
}

export type Graph3DMatrix3 = [[number, number, number], [number, number, number], [number, number, number]];

function graph3DAxisAngleMatrix(axis: "x" | "y" | "z", angle: number): Graph3DMatrix3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (axis === "x") {
    return [
      [1, 0, 0],
      [0, cos, -sin],
      [0, sin, cos],
    ];
  }
  if (axis === "y") {
    return [
      [cos, 0, sin],
      [0, 1, 0],
      [-sin, 0, cos],
    ];
  }
  return [
    [cos, -sin, 0],
    [sin, cos, 0],
    [0, 0, 1],
  ];
}

function multiplyGraph3DMatrix(a: Graph3DMatrix3, b: Graph3DMatrix3): Graph3DMatrix3 {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2],
    ],
    [
      a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
      a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
      a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2],
    ],
  ];
}

function transposeGraph3DMatrix(matrix: Graph3DMatrix3): Graph3DMatrix3 {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]],
  ];
}

function transformGraph3DPoint(matrix: Graph3DMatrix3, point: Graph3DPoint3): Graph3DPoint3 {
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2] * point.z,
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2] * point.z,
    z: matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2] * point.z,
  };
}

function evaluateGraph3DExpressionVector(
  vector: Graph3DExpressionVector3,
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  return {
    x: evaluateMathExpression(vector.x, variables),
    y: evaluateMathExpression(vector.y, variables),
    z: evaluateMathExpression(vector.z, variables),
  };
}

function formatGraph3DNumber(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : `${rounded}`;
}

const formatGraph3DAngle = formatGraph3DNumber;

function isZeroRotation(rotation: Graph3DPoint3): boolean {
  return isZeroGraph3DRotation(rotation);
}
