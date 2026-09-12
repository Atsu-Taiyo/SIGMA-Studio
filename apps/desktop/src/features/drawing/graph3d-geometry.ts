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
  Graph3DExpressionRange,
  Graph3DObject,
} from "@/features/document";

import {
  createGraph3DPlaneBasisFromPlane,
  flattenGraph3DPoint,
  resolveGraph3DPlane,
  type ResolvedGraph3DPlane,
} from "./graph3d-plane";
import {
  compileMathEquation,
  compileMathExpression,
  evaluateMathExpression,
  type MathExpressionVariables,
} from "./math-expression";
import {
  applyGraph3DMeshTransform,
  evaluateGraph3DObjectRotation,
  evaluateGraph3DObjectScale,
  evaluateGraph3DObjectTranslation,
  graph3DObjectRotationOrigin,
} from "./graph3d-transform";
import { Graph3DModelError } from "./graph3d-errors";

const GEOMETRY_EPSILON = 1e-8;
const DEFAULT_SURFACE_SAMPLES = 36;
const MAX_SURFACE_SAMPLES = 256;

export interface Graph3DMeshGeometry {
  positions: Graph3DPoint3[];
  triangles: Array<[number, number, number]>;
  lineSegments: Array<[number, number]>;
}

export interface Graph3DSectionLoop {
  points3D: Graph3DPoint3[];
  points2D: Graph3DPoint2[];
  triangles: Array<[number, number, number]>;
}

export interface Graph3DMeshSection {
  segments: Array<[Graph3DPoint3, Graph3DPoint3]>;
  loops: Graph3DSectionLoop[];
}

export function buildGraph3DObjectGeometry(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const geometry = buildGraph3DObjectLocalGeometry(object, variables);
  const rotation = evaluateGraph3DObjectRotation(object, variables);
  const scale = evaluateGraph3DObjectScale(object, variables);
  const translation = evaluateGraph3DObjectTranslation(object, variables);
  const origin = graph3DObjectRotationOrigin(object, geometry.positions, variables);
  return applyGraph3DMeshTransform(geometry, rotation, scale, translation, origin);
}

/** The mesh before the authored object rotation is applied. */
export function buildGraph3DObjectLocalGeometry(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  switch (object.kind) {
    case "parametricSurface": {
      // The scope object is reused across every sample: allocating one per grid point
      // cost more than the arithmetic it carried.
      const scope = createScope(variables);
      const x = compileMathExpression(object.x);
      const y = compileMathExpression(object.y);
      const z = compileMathExpression(object.z);
      return buildGridSurface(
        object.u,
        object.v,
        variables,
        (u, v) => {
          scope.u = u;
          scope.v = v;
          return { x: x(scope), y: y(scope), z: z(scope) };
        },
      );
    }
    case "parametricCurve":
      return buildParametricCurve(object, variables);
    case "solidOfRevolution":
      return buildSolidOfRevolution(object, variables);
    case "polyhedron":
      return buildPolyhedron(object, variables);
    case "primitive":
      return buildPrimitive(object, variables);
    case "point": {
      const position = evaluateVector(object.position, variables);
      return { positions: [position], triangles: [], lineSegments: [] };
    }
    case "segment":
      return {
        positions: [evaluateVector(object.from, variables), evaluateVector(object.to, variables)],
        triangles: [],
        lineSegments: [[0, 1]],
      };
    case "plane":
      return buildPlaneObject(object, variables);
    case "implicitSurface":
      return buildImplicitSurface(object, variables);
    case "boundedSolid":
      return buildBoundedSolid(object, variables);
  }
}

export function intersectGraph3DMeshWithPlane(
  geometry: Graph3DMeshGeometry,
  plane: ResolvedGraph3DPlane,
): Graph3DMeshSection {
  const { positions } = geometry;
  const distances = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index += 1) {
    distances[index] = dot(plane.normal, positions[index]) - plane.constant;
  }
  const segments = traceGraph3DMeshLevelSet(geometry, distances);
  const basis = createGraph3DPlaneBasisFromPlane(plane);
  const loops = assembleClosedLoops(segments).map((points3D) => {
    const simplified3D = simplifyCollinearLoop(points3D);
    const points2D = simplified3D.map((point) => flattenGraph3DPoint(point, basis));
    return {
      points3D: simplified3D,
      points2D,
      triangles: triangulateGraph3DPolygon(points2D),
    };
  }).filter((loop) => loop.points3D.length >= 3);
  return { segments, loops };
}

/**
 * The curve a per-vertex scalar field traces on a mesh where it crosses zero.
 *
 * Cutting a mesh with a plane is the special case where the field is the signed distance to that
 * plane, and it is what {@link intersectGraph3DMeshWithPlane} passes in. A common part that has
 * lost a dimension — a curved surface meeting a solid, two surfaces meeting each other — is the
 * same walk over the same triangles, so both go through here and stay the same curve.
 *
 * Signed values are read once per vertex rather than once per incident triangle, and triangles
 * wholly on one side are rejected before anything is allocated: a moving section over a dense
 * solid tests tens of thousands of triangles per rebuild and nearly all of them miss.
 */
export function traceGraph3DMeshLevelSet(
  geometry: Graph3DMeshGeometry,
  values: ArrayLike<number>,
): Array<[Graph3DPoint3, Graph3DPoint3]> {
  const { positions, triangles } = geometry;
  const rawSegments: Array<[Graph3DPoint3, Graph3DPoint3]> = [];
  for (const [a, b, c] of triangles) {
    const da = values[a];
    const db = values[b];
    const dc = values[c];
    if (
      !Number.isFinite(da) || !Number.isFinite(db) || !Number.isFinite(dc) ||
      (da > GEOMETRY_EPSILON && db > GEOMETRY_EPSILON && dc > GEOMETRY_EPSILON) ||
      (da < -GEOMETRY_EPSILON && db < -GEOMETRY_EPSILON && dc < -GEOMETRY_EPSILON)
    ) {
      continue;
    }
    const segment = intersectTriangleWithPlane(
      [positions[a], positions[b], positions[c]],
      [da, db, dc],
    );
    if (segment) rawSegments.push(segment);
  }
  return deduplicateSegments(rawSegments);
}

/**
 * The piece of a mesh where a per-vertex field is at most zero, with the triangles it cuts closed
 * off along the crossing. Used to keep the part of a curved surface that lies inside the other
 * members of a common part; the winding of every kept triangle follows the one it came from.
 */
export function trimGraph3DMeshByLevelSet(
  geometry: Graph3DMeshGeometry,
  values: ArrayLike<number>,
): Graph3DMeshGeometry {
  const positions: Graph3DPoint3[] = [];
  const indexByKey = new Map<string, number>();
  const triangles: Array<[number, number, number]> = [];
  const pushPoint = (point: Graph3DPoint3): number => {
    const key = pointKey(point);
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const next = positions.length;
    positions.push(point);
    indexByKey.set(key, next);
    return next;
  };

  for (const triangle of geometry.triangles) {
    const corners = triangle.map((index) => geometry.positions[index]);
    const cornerValues = triangle.map((index) => values[index]);
    if (cornerValues.some((value) => !Number.isFinite(value))) continue;
    if (cornerValues.every((value) => value > GEOMETRY_EPSILON)) continue;

    const polygon: Graph3DPoint3[] = [];
    for (let edge = 0; edge < 3; edge += 1) {
      const next = (edge + 1) % 3;
      const current = cornerValues[edge];
      const following = cornerValues[next];
      if (current <= GEOMETRY_EPSILON) polygon.push(corners[edge]);
      if ((current < -GEOMETRY_EPSILON && following > GEOMETRY_EPSILON) ||
        (current > GEOMETRY_EPSILON && following < -GEOMETRY_EPSILON)) {
        const amount = current / (current - following);
        polygon.push(add(corners[edge], scale(subtract(corners[next], corners[edge]), amount)));
      }
    }
    const unique = deduplicatePoints(polygon);
    if (unique.length < 3) continue;
    const indices = unique.map(pushPoint);
    for (let index = 1; index < indices.length - 1; index += 1) {
      const face: [number, number, number] = [indices[0], indices[index], indices[index + 1]];
      if (new Set(face).size === 3) triangles.push(face);
    }
  }
  return { positions, triangles, lineSegments: [] };
}

export function polygonArea2D(points: readonly Graph3DPoint2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

/** Ear-clipping triangulation for a simple polygon without holes. */
export function triangulateGraph3DPolygon(
  points: readonly Graph3DPoint2[],
): Array<[number, number, number]> {
  if (points.length < 3) return [];
  const remaining = [...points.keys()];
  if (polygonArea2D(points) < 0) remaining.reverse();
  const triangles: Array<[number, number, number]> = [];
  let guard = points.length * points.length;

  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const previous = remaining[(index - 1 + remaining.length) % remaining.length];
      const current = remaining[index];
      const next = remaining[(index + 1) % remaining.length];
      if (cross2(points[previous], points[current], points[next]) <= GEOMETRY_EPSILON) continue;
      if (remaining.some((candidate) => (
        candidate !== previous &&
        candidate !== current &&
        candidate !== next &&
        pointInTriangle(points[candidate], points[previous], points[current], points[next])
      ))) continue;

      triangles.push([previous, current, next]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) triangles.push([remaining[0], remaining[1], remaining[2]]);
  return triangles;
}

function buildGridSurface(
  uRangeExpression: Graph3DExpressionRange,
  vRangeExpression: Graph3DExpressionRange,
  variables: MathExpressionVariables,
  sample: (u: number, v: number) => Graph3DPoint3,
): Graph3DMeshGeometry {
  const uRange = evaluateRange(uRangeExpression, variables);
  const vRange = evaluateRange(vRangeExpression, variables);
  const positions: Graph3DPoint3[] = [];
  const indices: number[][] = [];
  for (let uIndex = 0; uIndex <= uRange.samples; uIndex += 1) {
    const row: number[] = [];
    const u = interpolate(uRange.min, uRange.max, uIndex / uRange.samples);
    for (let vIndex = 0; vIndex <= vRange.samples; vIndex += 1) {
      const v = interpolate(vRange.min, vRange.max, vIndex / vRange.samples);
      const point = sample(u, v);
      assertFinitePoint(point);
      row.push(positions.length);
      positions.push(point);
    }
    indices.push(row);
  }

  const triangles: Array<[number, number, number]> = [];
  const uWraps = rowsMatch(positions, indices[0], indices[uRange.samples]);
  const vWraps = columnsMatch(positions, indices, 0, vRange.samples);
  const lastU = uWraps ? 0 : uRange.samples;
  const lastV = vWraps ? 0 : vRange.samples;
  const uSteps = uWraps ? uRange.samples : uRange.samples;
  const vSteps = vWraps ? vRange.samples : vRange.samples;
  for (let u = 0; u < uSteps; u += 1) {
    for (let v = 0; v < vSteps; v += 1) {
      const nextU = u + 1 === uRange.samples && uWraps ? lastU : u + 1;
      const nextV = v + 1 === vRange.samples && vWraps ? lastV : v + 1;
      const a = indices[u][v];
      const b = indices[nextU][v];
      const c = indices[nextU][nextV];
      const d = indices[u][nextV];
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return { positions, triangles, lineSegments: gridLineSegments(indices) };
}

function rowsMatch(
  positions: Graph3DPoint3[],
  first: readonly number[],
  last: readonly number[],
): boolean {
  if (first.length !== last.length || first.length === 0) return false;
  return first.every((index, column) => pointsNearlyEqual(positions[index], positions[last[column]]));
}

function columnsMatch(
  positions: Graph3DPoint3[],
  indices: readonly number[][],
  first: number,
  last: number,
): boolean {
  if (indices.length === 0) return false;
  return indices.every((row) => pointsNearlyEqual(positions[row[first]], positions[row[last]]));
}

function pointsNearlyEqual(a: Graph3DPoint3, b: Graph3DPoint3): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 1e-6;
}

/**
 * A triangle mesh is closed when every edge is shared by exactly two faces.
 * Nearby vertices are welded first so a periodic parametric grid that reused
 * the last row as a copy of the first still counts as watertight.
 */
export function graph3DMeshIsClosed(geometry: Graph3DMeshGeometry): boolean {
  if (geometry.triangles.length < 4) return false;
  const weld = new Map<string, number>();
  const remap = geometry.positions.map((point) => {
    const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    const next = weld.size;
    weld.set(key, next);
    return next;
  });
  const edges = new Map<string, number>();
  for (const triangle of geometry.triangles) {
    const vertices = [remap[triangle[0]], remap[triangle[1]], remap[triangle[2]]];
    if (new Set(vertices).size < 3) continue;
    for (let index = 0; index < 3; index += 1) {
      const a = vertices[index];
      const b = vertices[(index + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  if (edges.size === 0) return false;
  return [...edges.values()].every((count) => count === 2);
}

function buildParametricCurve(
  object: Extract<Graph3DObject, { kind: "parametricCurve" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const range = evaluateRange(object.range, variables);
  const positions: Graph3DPoint3[] = [];
  const lineSegments: Array<[number, number]> = [];
  const scope = createScope(variables);
  const parameterName = object.parameter.toLowerCase();
  const x = compileMathExpression(object.x);
  const y = compileMathExpression(object.y);
  const z = compileMathExpression(object.z);
  for (let index = 0; index <= range.samples; index += 1) {
    scope[parameterName] = interpolate(range.min, range.max, index / range.samples);
    positions.push({ x: x(scope), y: y(scope), z: z(scope) });
    if (index > 0) lineSegments.push([index - 1, index]);
  }
  return { positions, triangles: [], lineSegments };
}

function buildSolidOfRevolution(
  object: Extract<Graph3DObject, { kind: "solidOfRevolution" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const axial = evaluateRange(object.axisRange, variables);
  const angular = evaluateRange(object.angleRange ?? { min: "0", max: "2*pi", samples: 48 }, variables);
  const axis = resolveRevolutionAxis(object.axis, variables);
  const fullTurn = Math.abs(Math.abs(angular.max - angular.min) - Math.PI * 2) <= 1e-6;
  const angularPointCount = fullTurn ? angular.samples : angular.samples + 1;
  const positions: Graph3DPoint3[] = [];
  const rings: number[][] = [];

  const scope = createScope(variables);
  const radiusAt = compileMathExpression(object.radius);
  for (let axialIndex = 0; axialIndex <= axial.samples; axialIndex += 1) {
    const axisValue = interpolate(axial.min, axial.max, axialIndex / axial.samples);
    scope[axis.parameter] = axisValue;
    const radius = radiusAt(scope);
    if (!Number.isFinite(radius) || radius < 0) throw new Graph3DModelError("revolutionRadiusInvalid");
    const ring: number[] = [];
    for (let angleIndex = 0; angleIndex < angularPointCount; angleIndex += 1) {
      const angle = interpolate(angular.min, angular.max, angleIndex / angular.samples);
      ring.push(positions.length);
      positions.push(revolutionPoint(axis, axisValue, radius, angle));
    }
    rings.push(ring);
  }

  const triangles: Array<[number, number, number]> = [];
  const angularSegmentCount = fullTurn ? angularPointCount : angularPointCount - 1;
  for (let ring = 0; ring < axial.samples; ring += 1) {
    for (let angle = 0; angle < angularSegmentCount; angle += 1) {
      const next = (angle + 1) % angularPointCount;
      const a = rings[ring][angle];
      const b = rings[ring + 1][angle];
      const c = rings[ring + 1][next];
      const d = rings[ring][next];
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  if (object.capped && fullTurn) {
    addRevolutionCap(positions, triangles, rings[0], pointOnRevolutionAxis(axis, axial.min), true);
    addRevolutionCap(positions, triangles, rings[rings.length - 1], pointOnRevolutionAxis(axis, axial.max), false);
  }
  return { positions, triangles, lineSegments: gridLineSegments(rings, fullTurn) };
}

function buildPolyhedron(
  object: Extract<Graph3DObject, { kind: "polyhedron" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const positions = object.vertices.map((vertex) => evaluateVector(vertex, variables));
  const triangles: Array<[number, number, number]> = [];
  for (const face of object.faces) {
    for (let index = 1; index < face.length - 1; index += 1) {
      triangles.push([face[0], face[index], face[index + 1]]);
    }
  }
  return { positions, triangles, lineSegments: [] };
}

/**
 * How many segments go round a curved primitive, when the author has not said.
 *
 * A fixed count made a big sphere look like a polyhedron: the same 32 segments carry ten times the
 * arc, so each flat is ten times as long. The count therefore follows the radius through the gap
 * between the arc and its chord (the sagitta, `r(1 - cos(pi/n))`), which is what the eye reads as
 * faceting — a segment count that keeps that gap fixed keeps the silhouette equally smooth at any
 * size. At the default radius 1 this lands on 36, next to the 32 it replaces.
 */
const PRIMITIVE_CHORD_TOLERANCE = 0.004;
export const MIN_PRIMITIVE_RING_SAMPLES = 24;
export const MAX_PRIMITIVE_RING_SAMPLES = 256;

export function graph3DPrimitiveRingSamples(radius: number, resolution?: number): number {
  if (resolution !== undefined && Number.isFinite(resolution)) {
    return clampPrimitiveRingSamples(Math.round(resolution));
  }
  if (!Number.isFinite(radius) || radius <= 0) return MIN_PRIMITIVE_RING_SAMPLES;
  // n >= pi / acos(1 - tolerance/r), taken through the small-angle form so a huge radius does not
  // fall off the end of `acos`.
  const ratio = Math.min(1, PRIMITIVE_CHORD_TOLERANCE / radius);
  return clampPrimitiveRingSamples(Math.ceil(Math.PI / Math.sqrt(2 * ratio)));
}

function clampPrimitiveRingSamples(samples: number): number {
  return Math.min(MAX_PRIMITIVE_RING_SAMPLES, Math.max(MIN_PRIMITIVE_RING_SAMPLES, samples));
}

function buildPrimitive(
  object: Extract<Graph3DObject, { kind: "primitive" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const center = evaluateVector(object.center, variables);
  const size = evaluateVector(object.size, variables);
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) throw new Graph3DModelError("solidSizeNotPositive");
  const half = scale(size, 0.5);
  let geometry: Graph3DMeshGeometry;
  if (object.primitive === "box") {
    geometry = {
      positions: [
        { x: -half.x, y: -half.y, z: -half.z },
        { x: half.x, y: -half.y, z: -half.z },
        { x: half.x, y: half.y, z: -half.z },
        { x: -half.x, y: half.y, z: -half.z },
        { x: -half.x, y: -half.y, z: half.z },
        { x: half.x, y: -half.y, z: half.z },
        { x: half.x, y: half.y, z: half.z },
        { x: -half.x, y: half.y, z: half.z },
      ],
      triangles: [
        [0, 2, 1], [0, 3, 2],
        [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4],
        [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6],
        [3, 0, 4], [3, 4, 7],
      ],
      lineSegments: [],
    };
  } else if (object.primitive === "sphere") {
    geometry = buildEllipsoid(half, object.resolution);
  } else {
    geometry = buildCylinderOrCone(half, object.primitive === "cone", object.resolution);
  }
  return {
    ...geometry,
    positions: geometry.positions.map((point) => add(point, center)),
  };
}

function buildPlaneObject(
  object: Extract<Graph3DObject, { kind: "plane" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const plane = resolveGraph3DPlane(object.plane, variables);
  const basis = createGraph3DPlaneBasisFromPlane(plane);
  const size = object.size
    ? evaluateVector(object.size, variables)
    : { x: 4, y: 4, z: 0 };
  if (size.x <= 0 || size.y <= 0) throw new Graph3DModelError("planeSizeNotPositive");
  const u = scale(basis.u, size.x / 2);
  const v = scale(basis.v, size.y / 2);
  return {
    positions: [
      add(plane.point, add(scale(u, -1), scale(v, -1))),
      add(plane.point, add(u, scale(v, -1))),
      add(plane.point, add(u, v)),
      add(plane.point, add(scale(u, -1), v)),
    ],
    triangles: [[0, 1, 2], [0, 2, 3]],
    lineSegments: [[0, 1], [1, 2], [2, 3], [3, 0]],
  };
}

function buildEllipsoid(radius: Graph3DPoint3, resolution?: number): Graph3DMeshGeometry {
  const longitudeSamples = graph3DPrimitiveRingSamples(
    Math.max(radius.x, radius.y, radius.z),
    resolution,
  );
  // Half a ring's worth of rows: a lat/long grid whose cells stay roughly square.
  const latitudeSamples = Math.max(4, Math.round(longitudeSamples / 2));
  const positions: Graph3DPoint3[] = [];
  const rows: number[][] = [];
  for (let latitude = 0; latitude <= latitudeSamples; latitude += 1) {
    const phi = -Math.PI / 2 + Math.PI * latitude / latitudeSamples;
    const row: number[] = [];
    for (let longitude = 0; longitude < longitudeSamples; longitude += 1) {
      const theta = Math.PI * 2 * longitude / longitudeSamples;
      row.push(positions.length);
      positions.push({
        x: radius.x * Math.cos(phi) * Math.cos(theta),
        y: radius.y * Math.cos(phi) * Math.sin(theta),
        z: radius.z * Math.sin(phi),
      });
    }
    rows.push(row);
  }
  const triangles: Array<[number, number, number]> = [];
  for (let latitude = 0; latitude < latitudeSamples; latitude += 1) {
    for (let longitude = 0; longitude < longitudeSamples; longitude += 1) {
      const next = (longitude + 1) % longitudeSamples;
      triangles.push(
        [rows[latitude][longitude], rows[latitude + 1][longitude], rows[latitude + 1][next]],
        [rows[latitude][longitude], rows[latitude + 1][next], rows[latitude][next]],
      );
    }
  }
  return { positions, triangles, lineSegments: gridLineSegments(rows, true) };
}

function buildCylinderOrCone(
  half: Graph3DPoint3,
  cone: boolean,
  resolution?: number,
): Graph3DMeshGeometry {
  const samples = graph3DPrimitiveRingSamples(Math.max(half.x, half.y), resolution);
  const positions: Graph3DPoint3[] = [];
  const bottom: number[] = [];
  const top: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const angle = Math.PI * 2 * index / samples;
    bottom.push(positions.length);
    positions.push({ x: half.x * Math.cos(angle), y: half.y * Math.sin(angle), z: -half.z });
    top.push(positions.length);
    positions.push(cone
      ? { x: 0, y: 0, z: half.z }
      : { x: half.x * Math.cos(angle), y: half.y * Math.sin(angle), z: half.z });
  }
  const triangles: Array<[number, number, number]> = [];
  for (let index = 0; index < samples; index += 1) {
    const next = (index + 1) % samples;
    triangles.push([bottom[index], bottom[next], top[next]], [bottom[index], top[next], top[index]]);
  }
  addPrimitiveCap(positions, triangles, bottom, -half.z, true);
  if (!cone) addPrimitiveCap(positions, triangles, top, half.z, false);
  return { positions, triangles, lineSegments: [] };
}

function addPrimitiveCap(
  positions: Graph3DPoint3[],
  triangles: Array<[number, number, number]>,
  ring: number[],
  z: number,
  reverse: boolean,
): void {
  const center = positions.length;
  positions.push({ x: 0, y: 0, z });
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    triangles.push(reverse ? [center, ring[next], ring[index]] : [center, ring[index], ring[next]]);
  }
}

function buildBoundedSolid(
  object: Extract<Graph3DObject, { kind: "boundedSolid" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const inequalities = expandGraph3DInequalities(object.inequalities);
  const xRange = evaluateRange(object.bounds.x, variables);
  const yRange = evaluateRange(object.bounds.y, variables);
  const zRange = evaluateRange(object.bounds.z, variables);
  const min = { x: xRange.min, y: yRange.min, z: zRange.min };
  const max = { x: xRange.max, y: yRange.max, z: zRange.max };
  const affine = inequalities.map((inequality) => tryParseGraph3DAffineInequality(inequality, variables));
  if (affine.every((halfspace): halfspace is Graph3DHalfspace => halfspace !== null)) {
    return buildGraph3DHalfspacePolytope([
      ...affine,
      ...createBoxHalfspaces(min, max),
    ]);
  }
  const fields = inequalities.map((inequality) => compileGraph3DInequalityField(inequality, variables));
  return marchGraph3DScalarField(min, max, graph3DBoundedSolidResolution(object), (point) => {
    let value = boxSignedDistance(point, min, max);
    for (const field of fields) {
      value = Math.max(value, field(point));
    }
    return value;
  });
}

/**
 * How finely a curved inequality solid is sampled.
 *
 * Only the solids that need sampling pay for it: a body cut out by planes alone is solved exactly
 * as a polytope, whatever this says. The grid is cubic, so this number is the one that decides
 * both how smooth a curved wall looks and how long the mesh takes to build.
 */
export const DEFAULT_BOUNDED_SOLID_RESOLUTION = 44;

export function graph3DBoundedSolidResolution(
  object: Extract<Graph3DObject, { kind: "boundedSolid" }>,
): number {
  return object.resolution ?? DEFAULT_BOUNDED_SOLID_RESOLUTION;
}

/** The authored inequalities plus the six faces of the search box, as one half-space list. */
export function createBoundedSolidHalfspaces(
  object: Extract<Graph3DObject, { kind: "boundedSolid" }>,
  variables: MathExpressionVariables,
): Graph3DHalfspace[] {
  const inequalities = expandGraph3DInequalities(object.inequalities);
  const xRange = evaluateRange(object.bounds.x, variables);
  const yRange = evaluateRange(object.bounds.y, variables);
  const zRange = evaluateRange(object.bounds.z, variables);
  return [
    ...inequalities.map((inequality) => parseGraph3DAffineInequality(inequality, variables)),
    ...createBoxHalfspaces(
      { x: xRange.min, y: yRange.min, z: zRange.min },
      { x: xRange.max, y: yRange.max, z: zRange.max },
    ),
  ];
}

/**
 * One authored inequality becomes every clause it contains. A single field may hold
 * `z >= 0, x^2 <= y, x^2+y^2 <= 4`; those are three walls, not one broken expression.
 */
export function expandGraph3DInequalities(inequalities: readonly string[]): string[] {
  return inequalities.flatMap(splitGraph3DInequalityList);
}

export function splitGraph3DInequalityList(expression: string): string[] {
  const parts = splitTopLevelList(expression);
  return parts.length > 0 ? parts : [expression.trim()].filter(Boolean);
}

function splitTopLevelList(expression: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (character === "," || character === ";" || character === "、")) {
      const part = expression.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const last = expression.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

export function compileGraph3DInequalityField(
  expression: string,
  variables: MathExpressionVariables,
): (point: Graph3DPoint3) => number {
  const match = /^(.*?)(<=|>=|<|>)(.*)$/u.exec(expression);
  if (!match || !match[1].trim() || !match[3].trim()) {
    throw new Graph3DModelError("inequalityOperatorInvalid");
  }
  const scope = createScope(variables);
  const left = compileMathExpression(match[1]);
  const right = compileMathExpression(match[3]);
  const direction = match[2].startsWith(">") ? -1 : 1;
  return (point) => {
    scope.x = point.x;
    scope.y = point.y;
    scope.z = point.z;
    return direction * (left(scope) - right(scope));
  };
}

export function tryParseGraph3DAffineInequality(
  expression: string,
  variables: MathExpressionVariables,
): Graph3DHalfspace | null {
  try {
    return parseGraph3DAffineInequality(expression, variables);
  } catch {
    return null;
  }
}

function boxSignedDistance(point: Graph3DPoint3, min: Graph3DPoint3, max: Graph3DPoint3): number {
  return Math.max(
    min.x - point.x, point.x - max.x,
    min.y - point.y, point.y - max.y,
    min.z - point.z, point.z - max.z,
  );
}

/** The six half-spaces of an axis-aligned box. */
export function createBoxHalfspaces(min: Graph3DPoint3, max: Graph3DPoint3): Graph3DHalfspace[] {
  return [
    { normal: { x: 1, y: 0, z: 0 }, offset: -max.x },
    { normal: { x: -1, y: 0, z: 0 }, offset: min.x },
    { normal: { x: 0, y: 1, z: 0 }, offset: -max.y },
    { normal: { x: 0, y: -1, z: 0 }, offset: min.y },
    { normal: { x: 0, y: 0, z: 1 }, offset: -max.z },
    { normal: { x: 0, y: 0, z: -1 }, offset: min.z },
  ];
}

/**
 * Meshes the convex body shared by every half-space, by enumerating the vertices where three
 * boundary planes meet and keeping the ones no other half-space excludes.
 */
export function buildGraph3DHalfspacePolytope(
  halfspaces: Graph3DHalfspace[],
): Graph3DMeshGeometry {
  const vertexMap = new Map<string, Graph3DPoint3>();
  for (let a = 0; a < halfspaces.length; a += 1) {
    for (let b = a + 1; b < halfspaces.length; b += 1) {
      for (let c = b + 1; c < halfspaces.length; c += 1) {
        const point = intersectThreeHalfspacePlanes(halfspaces[a], halfspaces[b], halfspaces[c]);
        if (!point || halfspaces.some((plane) => dot(plane.normal, point) + plane.offset > 1e-7)) continue;
        vertexMap.set(pointKey(point), point);
      }
    }
  }
  const positions = [...vertexMap.values()];
  if (positions.length < 4) throw new Graph3DModelError("boundedSolidBuildFailed");
  const triangles: Array<[number, number, number]> = [];
  const seenFaces = new Set<string>();
  for (const halfspace of halfspaces) {
    const face = positions
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => Math.abs(dot(halfspace.normal, point) + halfspace.offset) <= 1e-6);
    if (face.length < 3) continue;
    const key = face.map(({ index }) => index).sort((a, b) => a - b).join(",");
    if (seenFaces.has(key)) continue;
    seenFaces.add(key);
    const centroid = scale(face.reduce((sum, item) => add(sum, item.point), { x: 0, y: 0, z: 0 }), 1 / face.length);
    const normal = normalize(halfspace.normal);
    const basis = createGraph3DPlaneBasisFromPlane({
      normal,
      constant: dot(normal, centroid),
      point: centroid,
    });
    face.sort((left, right) => {
      const a = flattenGraph3DPoint(left.point, basis);
      const b = flattenGraph3DPoint(right.point, basis);
      return Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x);
    });
    for (let index = 1; index < face.length - 1; index += 1) {
      triangles.push([face[0].index, face[index].index, face[index + 1].index]);
    }
  }
  return { positions, triangles, lineSegments: [] };
}

export interface Graph3DHalfspace {
  /** Interior satisfies `dot(normal, point) + offset <= 0`. */
  normal: Graph3DPoint3;
  offset: number;
}

/** Reads `x + y <= 1` and friends as the half-space they bound. */
export function parseGraph3DAffineInequality(
  expression: string,
  variables: MathExpressionVariables,
): Graph3DHalfspace {
  const match = /^(.*?)(<=|>=|<|>)(.*)$/u.exec(expression);
  if (!match || !match[1].trim() || !match[3].trim()) throw new Graph3DModelError("inequalityOperatorInvalid");
  const scope = createScope(variables);
  const left = compileMathExpression(match[1]);
  const right = compileMathExpression(match[3]);
  const difference = (point: Graph3DPoint3) => {
    scope.x = point.x;
    scope.y = point.y;
    scope.z = point.z;
    return left(scope) - right(scope);
  };
  const zero = { x: 0, y: 0, z: 0 };
  const offset = difference(zero);
  const normal = {
    x: difference({ x: 1, y: 0, z: 0 }) - offset,
    y: difference({ x: 0, y: 1, z: 0 }) - offset,
    z: difference({ x: 0, y: 0, z: 1 }) - offset,
  };
  const direction = match[2].startsWith(">") ? -1 : 1;
  for (const sample of [{ x: 2, y: -1, z: 0.5 }, { x: -0.5, y: 1.25, z: 2 }]) {
    const expected = offset + dot(normal, sample);
    if (Math.abs(difference(sample) - expected) > 1e-8 * Math.max(1, Math.abs(expected))) {
      throw new Graph3DModelError("boundedSolidRequiresLinearInequality");
    }
  }
  if (length(normal) <= GEOMETRY_EPSILON) throw new Graph3DModelError("inequalityBoundaryPlaneFailed");
  return { normal: scale(normal, direction), offset: offset * direction };
}

function intersectThreeHalfspacePlanes(
  a: Graph3DHalfspace,
  b: Graph3DHalfspace,
  c: Graph3DHalfspace,
): Graph3DPoint3 | null {
  const denominator = dot(a.normal, cross(b.normal, c.normal));
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) return null;
  const point = scale(add(
    add(scale(cross(b.normal, c.normal), -a.offset), scale(cross(c.normal, a.normal), -b.offset)),
    scale(cross(a.normal, b.normal), -c.offset),
  ), 1 / denominator);
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z) ? point : null;
}

function buildImplicitSurface(
  object: Extract<Graph3DObject, { kind: "implicitSurface" }>,
  variables: MathExpressionVariables,
): Graph3DMeshGeometry {
  const xRange = evaluateRange(object.bounds.x, variables);
  const yRange = evaluateRange(object.bounds.y, variables);
  const zRange = evaluateRange(object.bounds.z, variables);
  const scope = createScope(variables);
  const level = compileMathEquation(object.expression);
  return marchGraph3DScalarField(
    { x: xRange.min, y: yRange.min, z: zRange.min },
    { x: xRange.max, y: yRange.max, z: zRange.max },
    object.resolution ?? 20,
    (point) => {
      scope.x = point.x;
      scope.y = point.y;
      scope.z = point.z;
      return level(scope);
    },
  );
}

/**
 * The finest grid the marcher will build.
 *
 * The work is cubic in this number, and the whole grid is evaluated before a single triangle comes
 * out, so the ceiling is what stops an authored value from freezing the editor rather than drawing
 * a smoother wall. A moving view never reaches it: `createGraph3DRenderSpec` scales the authored
 * resolution down while the camera is being dragged.
 */
export const MAX_SCALAR_FIELD_RESOLUTION = 128;

/**
 * Meshes the boundary where a scalar field crosses zero (negative inside), by marching the
 * tetrahedra of a regular grid. Shared by implicit surfaces and by the sampled common part of
 * several solids, so both stay the same surface for the same field.
 */
export function marchGraph3DScalarField(
  min: Graph3DPoint3,
  max: Graph3DPoint3,
  resolutionValue: number,
  value: (point: Graph3DPoint3) => number,
): Graph3DMeshGeometry {
  const resolution = Math.min(MAX_SCALAR_FIELD_RESOLUTION, Math.max(4, Math.round(resolutionValue)));
  const gridPoints: Graph3DPoint3[] = [];
  const gridValues: number[] = [];
  const side = resolution + 1;
  const gridIndex = (x: number, y: number, z: number) => x * side * side + y * side + z;
  for (let x = 0; x <= resolution; x += 1) {
    for (let y = 0; y <= resolution; y += 1) {
      for (let z = 0; z <= resolution; z += 1) {
        const point = {
          x: interpolate(min.x, max.x, x / resolution),
          y: interpolate(min.y, max.y, y / resolution),
          z: interpolate(min.z, max.z, z / resolution),
        };
        gridPoints.push(point);
        gridValues.push(value(point));
      }
    }
  }
  const positions: Graph3DPoint3[] = [];
  const triangles: Array<[number, number, number]> = [];
  const tetrahedra = [
    [0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
    [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7],
  ] as const;
  for (let x = 0; x < resolution; x += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let z = 0; z < resolution; z += 1) {
        const corners = [
          gridIndex(x, y, z), gridIndex(x + 1, y, z),
          gridIndex(x, y + 1, z), gridIndex(x + 1, y + 1, z),
          gridIndex(x, y, z + 1), gridIndex(x + 1, y, z + 1),
          gridIndex(x, y + 1, z + 1), gridIndex(x + 1, y + 1, z + 1),
        ];
        for (const tetrahedron of tetrahedra) {
          marchTetrahedron(
            tetrahedron.map((corner) => gridPoints[corners[corner]]) as [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3, Graph3DPoint3],
            tetrahedron.map((corner) => gridValues[corners[corner]]) as [number, number, number, number],
            positions,
            triangles,
          );
        }
      }
    }
  }
  return { positions, triangles, lineSegments: [] };
}

function marchTetrahedron(
  points: [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3, Graph3DPoint3],
  values: [number, number, number, number],
  positions: Graph3DPoint3[],
  triangles: Array<[number, number, number]>,
): void {
  const inside = [0, 1, 2, 3].filter((index) => values[index] <= 0);
  const outside = [0, 1, 2, 3].filter((index) => values[index] > 0);
  if (inside.length === 0 || inside.length === 4) return;
  if (inside.length === 1 || inside.length === 3) {
    const reverse = inside.length === 3;
    const lone = reverse ? outside[0] : inside[0];
    const others = reverse ? inside : outside;
    const triangle = others.map((other) => interpolateIso(points[lone], points[other], values[lone], values[other]));
    appendTriangle(positions, triangles, reverse ? [triangle[0], triangle[2], triangle[1]] : triangle as [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3]);
    return;
  }
  const [a, b] = inside;
  const [c, d] = outside;
  const quad = [
    interpolateIso(points[a], points[c], values[a], values[c]),
    interpolateIso(points[b], points[c], values[b], values[c]),
    interpolateIso(points[b], points[d], values[b], values[d]),
    interpolateIso(points[a], points[d], values[a], values[d]),
  ];
  appendTriangle(positions, triangles, [quad[0], quad[1], quad[2]]);
  appendTriangle(positions, triangles, [quad[0], quad[2], quad[3]]);
}

function interpolateIso(a: Graph3DPoint3, b: Graph3DPoint3, aValue: number, bValue: number): Graph3DPoint3 {
  const amount = Math.abs(aValue - bValue) <= GEOMETRY_EPSILON ? 0.5 : aValue / (aValue - bValue);
  return add(a, scale(subtract(b, a), amount));
}

function appendTriangle(
  positions: Graph3DPoint3[],
  triangles: Array<[number, number, number]>,
  points: [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3],
): void {
  const start = positions.length;
  positions.push(...points);
  triangles.push([start, start + 1, start + 2]);
}

function intersectTriangleWithPlane(
  triangle: [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3],
  distances: [number, number, number],
): [Graph3DPoint3, Graph3DPoint3] | null {
  if (distances.every((distance) => Math.abs(distance) <= GEOMETRY_EPSILON)) return null;
  const intersections: Graph3DPoint3[] = [];
  for (let edge = 0; edge < 3; edge += 1) {
    const next = (edge + 1) % 3;
    const a = triangle[edge];
    const b = triangle[next];
    const da = distances[edge];
    const db = distances[next];
    if (Math.abs(da) <= GEOMETRY_EPSILON) intersections.push(a);
    if ((da < -GEOMETRY_EPSILON && db > GEOMETRY_EPSILON) || (da > GEOMETRY_EPSILON && db < -GEOMETRY_EPSILON)) {
      const amount = da / (da - db);
      intersections.push(add(a, scale(subtract(b, a), amount)));
    }
  }
  const unique = deduplicatePoints(intersections);
  if (unique.length < 2) return null;
  if (unique.length === 2) return [unique[0], unique[1]];
  let furthest: [Graph3DPoint3, Graph3DPoint3] = [unique[0], unique[1]];
  let furthestDistance = distanceSquared(unique[0], unique[1]);
  for (let a = 0; a < unique.length; a += 1) {
    for (let b = a + 1; b < unique.length; b += 1) {
      const candidateDistance = distanceSquared(unique[a], unique[b]);
      if (candidateDistance > furthestDistance) {
        furthest = [unique[a], unique[b]];
        furthestDistance = candidateDistance;
      }
    }
  }
  return furthest;
}

function deduplicateSegments(
  segments: Array<[Graph3DPoint3, Graph3DPoint3]>,
): Array<[Graph3DPoint3, Graph3DPoint3]> {
  const seen = new Set<string>();
  return segments.filter(([a, b]) => {
    const keys = [pointKey(a), pointKey(b)].sort();
    const key = `${keys[0]}|${keys[1]}`;
    if (keys[0] === keys[1] || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assembleClosedLoops(
  segments: Array<[Graph3DPoint3, Graph3DPoint3]>,
): Graph3DPoint3[][] {
  const points = new Map<string, Graph3DPoint3>();
  const edges = segments.map(([a, b], index) => {
    const from = pointKey(a);
    const to = pointKey(b);
    points.set(from, a);
    points.set(to, b);
    return { index, from, to };
  });
  const adjacency = new Map<string, number[]>();
  const addAdjacency = (key: string, index: number) => {
    const existing = adjacency.get(key);
    if (existing) existing.push(index);
    else adjacency.set(key, [index]);
  };
  for (const edge of edges) {
    addAdjacency(edge.from, edge.index);
    addAdjacency(edge.to, edge.index);
  }

  const unused = new Set(edges.map((edge) => edge.index));
  const loops: Graph3DPoint3[][] = [];
  while (unused.size > 0) {
    const firstIndex = unused.values().next().value as number;
    const first = edges[firstIndex];
    unused.delete(firstIndex);
    const path = [first.from, first.to];
    let previous = first.from;
    let current = first.to;
    let guard = edges.length + 1;
    while (current !== path[0] && guard > 0) {
      guard -= 1;
      const nextEdgeIndex = (adjacency.get(current) ?? []).find((index) => {
        if (!unused.has(index)) return false;
        const edge = edges[index];
        const other = edge.from === current ? edge.to : edge.from;
        return other !== previous || (adjacency.get(current)?.length ?? 0) === 1;
      });
      if (nextEdgeIndex === undefined) break;
      unused.delete(nextEdgeIndex);
      const edge = edges[nextEdgeIndex];
      const next = edge.from === current ? edge.to : edge.from;
      path.push(next);
      previous = current;
      current = next;
    }
    if (path.length >= 4 && path[path.length - 1] === path[0]) {
      loops.push(path.slice(0, -1).map((key) => points.get(key) as Graph3DPoint3));
    }
  }
  return loops;
}

function simplifyCollinearLoop(points: Graph3DPoint3[]): Graph3DPoint3[] {
  let simplified = points.slice();
  let changed = true;
  while (changed && simplified.length > 3) {
    changed = false;
    simplified = simplified.filter((point, index, current) => {
      const previous = current[(index - 1 + current.length) % current.length];
      const next = current[(index + 1) % current.length];
      const a = subtract(point, previous);
      const b = subtract(next, point);
      const scaleFactor = Math.max(1, length(a) * length(b));
      const collinear = length(cross(a, b)) <= GEOMETRY_EPSILON * scaleFactor && dot(a, b) >= 0;
      if (collinear) changed = true;
      return !collinear;
    });
  }
  return simplified;
}

function gridLineSegments(rows: number[][], wrapColumns = false): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length - 1; column += 1) {
      segments.push([rows[row][column], rows[row][column + 1]]);
    }
    if (wrapColumns && rows[row].length > 2) segments.push([rows[row][rows[row].length - 1], rows[row][0]]);
  }
  for (let row = 0; row < rows.length - 1; row += 1) {
    for (let column = 0; column < Math.min(rows[row].length, rows[row + 1].length); column += 1) {
      segments.push([rows[row][column], rows[row + 1][column]]);
    }
  }
  return segments;
}

function addRevolutionCap(
  positions: Graph3DPoint3[],
  triangles: Array<[number, number, number]>,
  ring: number[],
  center: Graph3DPoint3,
  reverse: boolean,
): void {
  const centerIndex = positions.length;
  positions.push(center);
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    triangles.push(reverse
      ? [centerIndex, ring[next], ring[index]]
      : [centerIndex, ring[index], ring[next]]);
  }
}

interface ResolvedGraph3DRevolutionAxis {
  point: Graph3DPoint3;
  direction: Graph3DPoint3;
  radialU: Graph3DPoint3;
  radialV: Graph3DPoint3;
  parameter: string;
}

function resolveRevolutionAxis(
  axis: Extract<Graph3DObject, { kind: "solidOfRevolution" }>["axis"],
  variables: MathExpressionVariables,
): ResolvedGraph3DRevolutionAxis {
  if (typeof axis === "string") {
    const direction = {
      x: axis === "x" ? 1 : 0,
      y: axis === "y" ? 1 : 0,
      z: axis === "z" ? 1 : 0,
    };
    return createResolvedRevolutionAxis({ x: 0, y: 0, z: 0 }, direction, axis);
  }

  const first = resolveGraph3DPlane({ kind: "equation", expression: axis.equations[0] }, variables);
  const second = resolveGraph3DPlane({ kind: "equation", expression: axis.equations[1] }, variables);
  const direction = cross(first.normal, second.normal);
  const denominator = dot(direction, direction);
  if (denominator <= GEOMETRY_EPSILON) {
    throw new Graph3DModelError("revolutionAxisPlanesParallel");
  }
  // Closest point to the origin on the intersection of n1·p=c1 and n2·p=c2.
  const point = scale(add(
    scale(cross(second.normal, direction), first.constant),
    scale(cross(direction, first.normal), second.constant),
  ), 1 / denominator);
  const parameter = axis.parameter?.trim().toLowerCase() || "t";
  if (!/^[a-z][a-z0-9_]*$/u.test(parameter)) {
    throw new Graph3DModelError("revolutionAxisParameterInvalid");
  }
  return createResolvedRevolutionAxis(point, direction, parameter);
}

function createResolvedRevolutionAxis(
  point: Graph3DPoint3,
  directionValue: Graph3DPoint3,
  parameter: string,
): ResolvedGraph3DRevolutionAxis {
  const direction = normalize(directionValue);
  const reference = Math.abs(direction.z) < 0.9
    ? { x: 0, y: 0, z: 1 }
    : { x: 0, y: 1, z: 0 };
  const radialU = normalize(cross(direction, reference));
  const radialV = normalize(cross(direction, radialU));
  return { point, direction, radialU, radialV, parameter };
}

function pointOnRevolutionAxis(
  axis: ResolvedGraph3DRevolutionAxis,
  axisValue: number,
): Graph3DPoint3 {
  return add(axis.point, scale(axis.direction, axisValue));
}

function revolutionPoint(
  axis: ResolvedGraph3DRevolutionAxis,
  axisValue: number,
  radius: number,
  angle: number,
): Graph3DPoint3 {
  return add(
    pointOnRevolutionAxis(axis, axisValue),
    add(
      scale(axis.radialU, radius * Math.cos(angle)),
      scale(axis.radialV, radius * Math.sin(angle)),
    ),
  );
}

function evaluateRange(range: Graph3DExpressionRange, variables: MathExpressionVariables): {
  min: number;
  max: number;
  samples: number;
} {
  const min = evaluateMathExpression(range.min, variables);
  const max = evaluateMathExpression(range.max, variables);
  if (!(max > min)) throw new Graph3DModelError("rangeMaxNotGreaterThanMin");
  return {
    min,
    max,
    samples: Math.min(MAX_SURFACE_SAMPLES, Math.max(2, Math.round(range.samples ?? DEFAULT_SURFACE_SAMPLES))),
  };
}

/**
 * A mutable copy of the parameter scope, for sampling loops that only change one or two
 * coordinates per step. Evaluation never retains the object, so mutating it is safe.
 */
function createScope(variables: MathExpressionVariables): Record<string, number> {
  return { ...variables };
}

function evaluateVector(
  vector: { x: string; y: string; z: string },
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  const point = {
    x: evaluateMathExpression(vector.x, variables),
    y: evaluateMathExpression(vector.y, variables),
    z: evaluateMathExpression(vector.z, variables),
  };
  assertFinitePoint(point);
  return point;
}

function assertFinitePoint(point: Graph3DPoint3): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    throw new Graph3DModelError("coordinateNotFinite");
  }
}

function deduplicatePoints(points: Graph3DPoint3[]): Graph3DPoint3[] {
  const unique = new Map<string, Graph3DPoint3>();
  for (const point of points) unique.set(pointKey(point), point);
  return [...unique.values()];
}

function pointKey(point: Graph3DPoint3): string {
  const scaleFactor = 1 / GEOMETRY_EPSILON;
  return `${Math.round(point.x * scaleFactor)},${Math.round(point.y * scaleFactor)},${Math.round(point.z * scaleFactor)}`;
}

function pointInTriangle(
  point: Graph3DPoint2,
  a: Graph3DPoint2,
  b: Graph3DPoint2,
  c: Graph3DPoint2,
): boolean {
  const ab = cross2(a, b, point);
  const bc = cross2(b, c, point);
  const ca = cross2(c, a, point);
  return ab >= -GEOMETRY_EPSILON && bc >= -GEOMETRY_EPSILON && ca >= -GEOMETRY_EPSILON;
}

function cross2(a: Graph3DPoint2, b: Graph3DPoint2, c: Graph3DPoint2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function interpolate(min: number, max: number, amount: number): number {
  return min + (max - min) * amount;
}

function normalize(vector: Graph3DPoint3): Graph3DPoint3 {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude <= GEOMETRY_EPSILON) throw new Graph3DModelError("directionVectorZero");
  return scale(vector, 1 / magnitude);
}

function distanceSquared(a: Graph3DPoint3, b: Graph3DPoint3): number {
  const delta = subtract(a, b);
  return dot(delta, delta);
}
