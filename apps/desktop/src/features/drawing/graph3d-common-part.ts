/**
 * What several objects share once the answer stops being a body.
 *
 * `graph3d-solid` asks "which points belong to all of these objects at once". As soon as the
 * members constrain one another the shared set drops a dimension: two planes meet along a line,
 * three meet at a point, a curved surface and a solid meet along a contour. Those answers are not
 * meshes, so they cannot be sampled on a grid — they need exact linear algebra and clipping, which
 * is what this module holds. Keeping it here leaves `graph3d-solid` a readable list of cases.
 */
import {
  add,
  subtract,
  scale,
  type Graph3DPoint3,
} from "./graph3d-vector";
import type { ResolvedGraph3DPlane } from "./graph3d-plane";
import { Graph3DModelError } from "./graph3d-errors";

const EPSILON = 1e-9;

export interface Graph3DParameterInterval {
  min: number;
  max: number;
}

export type Graph3DPlaneSystemSolution =
  /** The planes have no point in common — parallel and distinct somewhere in the system. */
  | { kind: "empty" }
  /** Every plane is the same plane, so the shared set is still two-dimensional. */
  | { kind: "plane"; plane: ResolvedGraph3DPlane }
  | { kind: "line"; point: Graph3DPoint3; direction: Graph3DPoint3 }
  | { kind: "point"; point: Graph3DPoint3 };

/**
 * Solves `dot(normal, p) = constant` for every plane at once.
 *
 * Gauss-Jordan with partial pivoting on the 3-column system: the rank says what the answer is
 * (a plane, a line, a point), and a surviving row of the form `0 = c` says the planes never meet.
 * Solving all the planes together is what lets three of them answer with the single point they
 * share instead of being taken two at a time.
 */
export function solveGraph3DPlaneSystem(
  planes: readonly ResolvedGraph3DPlane[],
): Graph3DPlaneSystemSolution {
  if (planes.length === 0) throw new Graph3DModelError("planeRequired");
  const rows = planes.map((plane) => [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant]);
  // Normals arrive normalized, so only the constants set the scale the tolerance has to survive.
  const scale = Math.max(1, ...planes.map((plane) => Math.abs(plane.constant)));
  const tolerance = 1e-7 * scale;
  const pivotColumns: number[] = [];
  let pivotRow = 0;

  for (let column = 0; column < 3 && pivotRow < rows.length; column += 1) {
    let best = pivotRow;
    for (let row = pivotRow + 1; row < rows.length; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[best][column])) best = row;
    }
    if (Math.abs(rows[best][column]) <= 1e-9) continue;
    [rows[pivotRow], rows[best]] = [rows[best], rows[pivotRow]];
    const divisor = rows[pivotRow][column];
    for (let entry = 0; entry < 4; entry += 1) rows[pivotRow][entry] /= divisor;
    for (let row = 0; row < rows.length; row += 1) {
      if (row === pivotRow) continue;
      const factor = rows[row][column];
      if (factor === 0) continue;
      for (let entry = 0; entry < 4; entry += 1) rows[row][entry] -= factor * rows[pivotRow][entry];
    }
    pivotColumns.push(column);
    pivotRow += 1;
  }

  for (let row = pivotRow; row < rows.length; row += 1) {
    const magnitude = Math.max(Math.abs(rows[row][0]), Math.abs(rows[row][1]), Math.abs(rows[row][2]));
    if (magnitude <= 1e-9 && Math.abs(rows[row][3]) > tolerance) return { kind: "empty" };
  }

  if (pivotColumns.length <= 1) return { kind: "plane", plane: planes[0] };
  if (pivotColumns.length === 3) {
    return { kind: "point", point: { x: rows[0][3], y: rows[1][3], z: rows[2][3] } };
  }

  // Rank 2: the one column without a pivot is free, and moving it traces the shared line.
  const freeColumn = [0, 1, 2].find((column) => !pivotColumns.includes(column)) ?? 2;
  const particular = [0, 0, 0];
  const direction = [0, 0, 0];
  direction[freeColumn] = 1;
  pivotColumns.forEach((column, index) => {
    particular[column] = rows[index][3];
    direction[column] = -rows[index][freeColumn];
  });
  const magnitude = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(magnitude > EPSILON)) return { kind: "plane", plane: planes[0] };
  return {
    kind: "line",
    point: { x: particular[0], y: particular[1], z: particular[2] },
    direction: { x: direction[0] / magnitude, y: direction[1] / magnitude, z: direction[2] / magnitude },
  };
}

/** The stretch of a line that stays inside an axis-aligned box, as a parameter interval. */
export function clipGraph3DLineToBox(
  origin: Graph3DPoint3,
  direction: Graph3DPoint3,
  box: { min: Graph3DPoint3; max: Graph3DPoint3 },
): Graph3DParameterInterval | null {
  let min = -Infinity;
  let max = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const along = direction[axis];
    if (Math.abs(along) <= 1e-12) {
      if (origin[axis] < box.min[axis] - 1e-9 || origin[axis] > box.max[axis] + 1e-9) return null;
      continue;
    }
    const first = (box.min[axis] - origin[axis]) / along;
    const second = (box.max[axis] - origin[axis]) / along;
    min = Math.max(min, Math.min(first, second));
    max = Math.min(max, Math.max(first, second));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
  return { min, max };
}

/**
 * The stretches of a line where a field is at most zero.
 *
 * The field belongs to a solid, which need not be convex, so the interval is found by walking the
 * line and bisecting each sign change rather than by solving anything. The walk is what lets a
 * line through a dented body come back as several separate chords.
 */
export function clipGraph3DLineByField(
  origin: Graph3DPoint3,
  direction: Graph3DPoint3,
  range: Graph3DParameterInterval,
  value: (point: Graph3DPoint3) => number,
  samples = 192,
): Graph3DParameterInterval[] {
  const at = (parameter: number) => value(pointOnLine(origin, direction, parameter));
  const steps = Math.max(8, Math.round(samples));
  const step = (range.max - range.min) / steps;
  const intervals: Graph3DParameterInterval[] = [];
  let previousParameter = range.min;
  let previousValue = at(range.min);
  let start: number | null = previousValue <= 0 ? range.min : null;

  for (let index = 1; index <= steps; index += 1) {
    const parameter = index === steps ? range.max : range.min + step * index;
    const current = at(parameter);
    if ((previousValue > 0) !== (current > 0)) {
      const crossing = refineCrossing(
        previousParameter,
        parameter,
        previousValue,
        (candidate) => at(candidate),
      );
      if (current <= 0) start = crossing;
      else {
        if (start !== null) intervals.push({ min: start, max: crossing });
        start = null;
      }
    }
    previousParameter = parameter;
    previousValue = current;
  }
  if (start !== null) intervals.push({ min: start, max: range.max });
  const span = Math.max(1e-9, (range.max - range.min) * 1e-6);
  return intervals.filter((interval) => interval.max - interval.min > span);
}

/** Trims each segment to the part where a field is at most zero; segments outside it disappear. */
export function clipGraph3DSegmentsByField(
  segments: ReadonlyArray<readonly [Graph3DPoint3, Graph3DPoint3]>,
  value: (point: Graph3DPoint3) => number,
): Array<[Graph3DPoint3, Graph3DPoint3]> {
  const clipped: Array<[Graph3DPoint3, Graph3DPoint3]> = [];
  for (const [from, to] of segments) {
    const fromValue = value(from);
    const toValue = value(to);
    if (!Number.isFinite(fromValue) || !Number.isFinite(toValue)) continue;
    if (fromValue <= 0 && toValue <= 0) {
      clipped.push([from, to]);
      continue;
    }
    if (fromValue > 0 && toValue > 0) continue;
    const direction = subtract(to, from);
    const crossing = refineCrossing(0, 1, fromValue, (parameter) => (
      value(add(from, scale(direction, parameter)))
    ));
    const meeting = add(from, scale(direction, crossing));
    clipped.push(fromValue <= 0 ? [from, meeting] : [meeting, to]);
  }
  return clipped.filter(([from, to]) => distance(from, to) > 1e-9);
}

/** Where a field crosses zero along a run of segments — the points a third constraint leaves. */
export function findGraph3DSegmentCrossings(
  segments: ReadonlyArray<readonly [Graph3DPoint3, Graph3DPoint3]>,
  value: (point: Graph3DPoint3) => number,
): Graph3DPoint3[] {
  const crossings: Graph3DPoint3[] = [];
  for (const [from, to] of segments) {
    const fromValue = value(from);
    const toValue = value(to);
    if (!Number.isFinite(fromValue) || !Number.isFinite(toValue)) continue;
    if ((fromValue > 0) === (toValue > 0)) continue;
    const direction = subtract(to, from);
    const parameter = refineCrossing(0, 1, fromValue, (candidate) => (
      value(add(from, scale(direction, candidate)))
    ));
    crossings.push(add(from, scale(direction, parameter)));
  }
  return deduplicateGraph3DPoints(crossings);
}

export function pointOnLine(
  origin: Graph3DPoint3,
  direction: Graph3DPoint3,
  parameter: number,
): Graph3DPoint3 {
  return {
    x: origin.x + direction.x * parameter,
    y: origin.y + direction.y * parameter,
    z: origin.z + direction.z * parameter,
  };
}

/** Points closer together than a hair are the same point; a contour end meets its neighbour. */
export function deduplicateGraph3DPoints(points: readonly Graph3DPoint3[]): Graph3DPoint3[] {
  const seen = new Set<string>();
  const unique: Graph3DPoint3[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
    const key = `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function refineCrossing(
  low: number,
  high: number,
  lowValue: number,
  at: (parameter: number) => number,
): number {
  let start = low;
  let end = high;
  let startValue = lowValue;
  for (let step = 0; step < 40; step += 1) {
    const middle = (start + end) / 2;
    const value = at(middle);
    if ((startValue > 0) === (value > 0)) {
      start = middle;
      startValue = value;
    } else {
      end = middle;
    }
  }
  return (start + end) / 2;
}

function distance(a: Graph3DPoint3, b: Graph3DPoint3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
