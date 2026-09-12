/**
 * The part several 3D objects have in common.
 *
 * A cut asks "where does this plane meet the solid"; this module asks the different question
 * "which points belong to all of these objects at once". Every solid therefore has to answer
 * `inside?` for an arbitrary point, which is what `Graph3DSolidField` is. Bodies that are exactly
 * an intersection of half-spaces also publish those half-spaces, so the common part of, say, a
 * cube and a tetrahedron is meshed exactly instead of being sampled on a grid.
 */
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
import type { Graph3DObject } from "@/features/document";
import { Graph3DModelError } from "./graph3d-errors";

import {
  buildGraph3DHalfspacePolytope,
  buildGraph3DObjectGeometry,
  buildGraph3DObjectLocalGeometry,
  compileGraph3DInequalityField,
  createBoundedSolidHalfspaces,
  expandGraph3DInequalities,
  graph3DMeshIsClosed,
  intersectGraph3DMeshWithPlane,
  marchGraph3DScalarField,
  traceGraph3DMeshLevelSet,
  triangulateGraph3DPolygon,
  trimGraph3DMeshByLevelSet,
  tryParseGraph3DAffineInequality,
  type Graph3DHalfspace,
  type Graph3DMeshGeometry,
  type Graph3DMeshSection,
} from "./graph3d-geometry";
import {
  clipGraph3DLineByField,
  clipGraph3DLineToBox,
  clipGraph3DSegmentsByField,
  deduplicateGraph3DPoints,
  findGraph3DSegmentCrossings,
  pointOnLine,
  solveGraph3DPlaneSystem,
} from "./graph3d-common-part";
import {
  createGraph3DPlaneBasis,
  createGraph3DPlaneBasisFromPlane,
  flattenGraph3DPoint,
  resolveGraph3DPlane,
  unflattenGraph3DPoint,
  type ResolvedGraph3DPlane,
} from "./graph3d-plane";
import {
  evaluateGraph3DObjectRotation,
  evaluateGraph3DObjectScale,
  evaluateGraph3DObjectTranslation,
  graph3DObjectRotationOrigin,
  isZeroGraph3DRotation,
  rotateGraph3DEuler,
  unrotateGraph3DEuler,
} from "./graph3d-transform";
import {
  compileMathEquation,
  compileMathExpression,
  evaluateMathExpression,
  type MathExpressionVariables,
} from "./math-expression";

const EPSILON = 1e-9;
const DEFAULT_INTERSECTION_RESOLUTION = 22;

export interface Graph3DBoundingBox {
  min: Graph3DPoint3;
  max: Graph3DPoint3;
}

export interface Graph3DSolidField {
  /** Negative inside the body, positive outside; zero on its surface. */
  value: (point: Graph3DPoint3) => number;
  bounds: Graph3DBoundingBox;
  /** Set when the body is exactly the intersection of these half-spaces. */
  halfspaces?: Graph3DHalfspace[];
}

/**
 * What the members share, at whatever dimension is left once they constrain one another.
 *
 * Two solids share a body; a plane and a solid share a flat area; a curved surface and a solid
 * share a piece of that surface; two planes share a line; three share a single point. Nothing is
 * cut away in any of these — a common part only ever describes what is already there.
 */
export type Graph3DIntersectionGeometry =
  | { kind: "empty" }
  | {
      kind: "solid";
      geometry: Graph3DMeshGeometry;
      /**
       * The lines where the shared surface stops following one member and starts following the
       * next — the six curved edges of three crossed cylinders, the circle where a ball meets a
       * face. Present only when the body had to be sampled; an exactly meshed polytope carries its
       * edges in the mesh itself.
       */
      seams?: Array<[Graph3DPoint3, Graph3DPoint3]>;
    }
  | { kind: "section"; plane: ResolvedGraph3DPlane; section: Graph3DMeshSection }
  /** A piece of one curved surface, with the outline where it stops. */
  | { kind: "surface"; geometry: Graph3DMeshGeometry; contour: Array<[Graph3DPoint3, Graph3DPoint3]> }
  /** A shared line or curve, drawn as an outline because it has no area. */
  | { kind: "curve"; segments: Array<[Graph3DPoint3, Graph3DPoint3]> }
  /** Isolated shared points — three planes meeting, a line touching a surface. */
  | { kind: "points"; points: Graph3DPoint3[] };

/**
 * One member of a common part, sorted by what it can contribute.
 *
 * A body can answer "is this point inside me"; a boundary cannot, because it has no inside — it
 * contributes the surface the answer has to lie on, and (when it has one) a signed "which side of
 * me" reading that turns another member's surface into a contour.
 */
type Graph3DCommonPartMember =
  | { role: "body"; object: Graph3DObject; field: Graph3DSolidField }
  | {
      role: "boundary";
      object: Graph3DObject;
      mesh: Graph3DMeshGeometry;
      /** Set for flat boundaries, which are solved exactly instead of being sampled. */
      plane: ResolvedGraph3DPlane | null;
      side: ((point: Graph3DPoint3) => number) | null;
    };

/**
 * The body an object occupies, or null when the object is a curve, a surface or a point and
 * therefore encloses nothing.
 */
export function createGraph3DSolidField(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DSolidField | null {
  const field = createUnrotatedSolidField(object, variables);
  if (!field) return null;
  return applySolidTransform(object, field, variables);
}

function createUnrotatedSolidField(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DSolidField | null {
  switch (object.kind) {
    case "boundedSolid":
      return createBoundedSolidField(object, variables);
    case "primitive":
      return createPrimitiveField(object, variables);
    case "polyhedron":
      return createPolyhedronField(object, variables);
    case "solidOfRevolution":
      return createRevolutionField(object, variables);
    case "implicitSurface":
      return createImplicitField(object, variables);
    case "parametricSurface":
      return createParametricSurfaceField(object, variables);
    default:
      return null;
  }
}

/**
 * Meshes what the given objects share.
 *
 * The members are sorted into bodies (things with an inside) and boundaries (planes and curved
 * surfaces), and the number of boundaries decides the dimension of the answer: none leaves a
 * volume, one leaves an area on that boundary, two leave the curve where they cross, three leave
 * the points. Planes are solved together as one linear system rather than a pair at a time, so
 * three of them answer with the single point they share instead of giving up.
 */
export function buildGraph3DIntersectionGeometry(
  objects: readonly Graph3DObject[],
  variables: MathExpressionVariables,
  options: { resolution?: number } = {},
): Graph3DIntersectionGeometry {
  if (objects.length < 2) throw new Graph3DModelError("commonPartNeedsTwoObjects");
  const members = objects.map((object) => classifyCommonPartMember(object, variables));
  const bodies = members.filter((member) => member.role === "body");
  const boundaries = members.filter((member) => member.role === "boundary");
  const resolution = options.resolution ?? DEFAULT_INTERSECTION_RESOLUTION;

  const bodyValue = (point: Graph3DPoint3): number => {
    let value = -Infinity;
    for (const body of bodies) {
      const candidate = body.field.value(point);
      if (candidate > value) value = candidate;
    }
    return value;
  };
  const bodyBounds = bodies.length > 0 ? intersectBounds(bodies.map((body) => body.field.bounds)) : null;
  if (bodies.length > 0 && !bodyBounds) {
    // No shared box at all. Bodies that meet exactly on a face still touch, and that contact is
    // the only thing left to draw; bodies that miss each other share nothing.
    if (boundaries.length > 0 || !bodiesTouch(bodies)) return { kind: "empty" };
    return buildContactContour(bodies, variables);
  }

  if (boundaries.length === 0) {
    return buildSharedVolume(bodies, bodyBounds as Graph3DBoundingBox, resolution, variables);
  }
  if (boundaries.length === 1) {
    return buildSharedBoundaryPart(boundaries[0], bodies, bodyValue, bodyBounds, resolution);
  }
  return buildSharedEdge(boundaries, bodies, bodyValue, bodyBounds, resolution);
}

/**
 * Which of the three things a member can be.
 *
 * A plane derives its equation from its own drawn quad rather than from the authored expression,
 * so an object rotation or translation moves the maths with the picture instead of leaving the
 * common part behind where the plane used to be.
 */
function classifyCommonPartMember(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): Graph3DCommonPartMember {
  if (object.kind === "plane") {
    const mesh = buildGraph3DObjectGeometry(object, variables);
    const plane = planeThroughQuad(mesh);
    return {
      role: "boundary",
      object,
      mesh,
      plane,
      side: (point) => dot(plane.normal, point) - plane.constant,
    };
  }
  const field = createGraph3DSolidField(object, variables);
  if (field) return { role: "body", object, field };
  if (object.kind === "parametricSurface") {
    const mesh = buildGraph3DObjectGeometry(object, variables);
    if (mesh.triangles.length > 0) {
      return { role: "boundary", object, mesh, plane: null, side: createHeightFieldSide(object, variables) };
    }
  }
  throw new Graph3DModelError("commonPartObjectHasNoSurfaceOrInterior", {
    name: object.name ?? "",
  });
}

/**
 * A surface's own "above or below me" reading, for the surfaces that have one.
 *
 * Only a graph splits space: `(u, v) ↦ (u, v, f(u, v))` has an above and a below, so it can
 * restrict another member's mesh the way a plane does, while a torus has neither. Which one this
 * is gets decided by sampling the map rather than by reading the authored strings, so `x = u` and
 * `x = u + 0*v` both count. Outside the authored patch the surface has no opinion and says so with
 * NaN, which drops the contour there instead of extending the surface past where it was drawn. A
 * rotated or moved surface has no such reading in world coordinates, so it carries a contour only.
 */
function createHeightFieldSide(
  object: Extract<Graph3DObject, { kind: "parametricSurface" }>,
  variables: MathExpressionVariables,
): ((point: Graph3DPoint3) => number) | null {
  if (hasGraph3DObjectTransform(object, variables)) return null;
  const uMin = evaluateMathExpression(object.u.min, variables);
  const uMax = evaluateMathExpression(object.u.max, variables);
  const vMin = evaluateMathExpression(object.v.min, variables);
  const vMax = evaluateMathExpression(object.v.max, variables);
  if (![uMin, uMax, vMin, vMax].every(Number.isFinite)) return null;

  const scope: Record<string, number> = { ...variables };
  const x = compileMathExpression(object.x);
  const y = compileMathExpression(object.y);
  const height = compileMathExpression(object.z);
  const span = Math.max(1, Math.abs(uMax - uMin), Math.abs(vMax - vMin));
  const tolerance = span * 1e-9;
  for (let uStep = 0; uStep <= 2; uStep += 1) {
    for (let vStep = 0; vStep <= 2; vStep += 1) {
      const u = uMin + ((uMax - uMin) * uStep) / 2;
      const v = vMin + ((vMax - vMin) * vStep) / 2;
      scope.u = u;
      scope.v = v;
      if (Math.abs(x(scope) - u) > tolerance || Math.abs(y(scope) - v) > tolerance) return null;
    }
  }

  const margin = 1e-6 * span;
  return (point) => {
    if (point.x < Math.min(uMin, uMax) - margin || point.x > Math.max(uMin, uMax) + margin) return NaN;
    if (point.y < Math.min(vMin, vMax) - margin || point.y > Math.max(vMin, vMax) + margin) return NaN;
    scope.u = point.x;
    scope.v = point.y;
    return point.z - height(scope);
  };
}

function hasGraph3DObjectTransform(
  object: Graph3DObject,
  variables: MathExpressionVariables,
): boolean {
  const rotation = evaluateGraph3DObjectRotation(object, variables);
  const translation = evaluateGraph3DObjectTranslation(object, variables);
  const scaleFactors = evaluateGraph3DObjectScale(object, variables);
  return !isZeroGraph3DRotation(rotation) ||
    !isZeroGraph3DRotation(translation) ||
    Math.abs(scaleFactors.x - 1) > EPSILON ||
    Math.abs(scaleFactors.y - 1) > EPSILON ||
    Math.abs(scaleFactors.z - 1) > EPSILON;
}

/** The plane a drawn quad lies in. Its first three corners are a right angle, never collinear. */
function planeThroughQuad(mesh: Graph3DMeshGeometry): ResolvedGraph3DPlane {
  const [first, second, third] = mesh.positions;
  if (!first || !second || !third) throw new Graph3DModelError("planePositionFailed");
  const basis = createGraph3DPlaneBasis(first, second, third);
  return { normal: basis.normal, constant: dot(basis.normal, first), point: first };
}

/**
 * Bodies only: the volume they all occupy.
 *
 * When that volume is empty the bodies may still be touching along their surfaces — a sphere
 * resting on a box shares no interior at all. The outline where the first body's surface meets the
 * others is the honest answer there, so it is drawn instead of reporting nothing.
 */
function buildSharedVolume(
  bodies: Array<Extract<Graph3DCommonPartMember, { role: "body" }>>,
  bounds: Graph3DBoundingBox,
  resolution: number,
  variables: MathExpressionVariables,
): Graph3DIntersectionGeometry {
  const fields = bodies.map((body) => body.field);
  const geometry = buildSharedSolidMesh(fields, bounds, resolution);
  if (!geometry) return buildContactContour(bodies, variables);
  const exact = fields.every((field) => field.halfspaces);
  if (exact) return { kind: "solid", geometry };
  return { kind: "solid", geometry, seams: findGraph3DSharedSurfaceSeams(geometry, fields) };
}

/**
 * Where a sampled shared surface hands over from one member to another.
 *
 * Every triangle of the surface sits on whichever member is tightest there, so the triangle's
 * owner is the field that is largest at its middle. Two neighbouring triangles with different
 * owners are separated by a real edge of the common part; two with the same owner are just the
 * grid, however sharply the sampling happened to bend between them. That distinction is why this
 * is asked of the fields and not of the mesh: marching leaves slivers whose normals swing wildly,
 * so a dihedral-angle test keeps a third of every edge in the body and draws a scribble.
 */
function findGraph3DSharedSurfaceSeams(
  geometry: Graph3DMeshGeometry,
  fields: readonly Graph3DSolidField[],
): Array<[Graph3DPoint3, Graph3DPoint3]> {
  if (fields.length < 2) return [];
  const owners = geometry.triangles.map((triangle) => {
    const points = triangle.map((corner) => geometry.positions[corner]);
    if (points.some((point) => point === undefined)) return null;
    const middle = {
      x: (points[0].x + points[1].x + points[2].x) / 3,
      y: (points[0].y + points[1].y + points[2].y) / 3,
      z: (points[0].z + points[1].z + points[2].z) / 3,
    };
    let owner = "";
    let best = -Infinity;
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const value = field.value(middle);
      if (value <= best) continue;
      best = value;
      // A body made of half-spaces is several flat faces wearing one field. Naming the face keeps
      // the edges between them — a tetrahedron's own edges, say — instead of merging them away.
      owner = `${index}`;
      if (!field.halfspaces) continue;
      let closest = -Infinity;
      for (let face = 0; face < field.halfspaces.length; face += 1) {
        const halfspace = field.halfspaces[face];
        const distance = dot(halfspace.normal, middle) + halfspace.offset;
        if (distance > closest) {
          closest = distance;
          owner = `${index}:${face}`;
        }
      }
    }
    return owner;
  });

  // Marching leaves every corner unshared, so neighbours are found by position, not by index.
  const key = (point: Graph3DPoint3) => `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)},${Math.round(point.z * 1e6)}`;
  const edges = new Map<string, { from: Graph3DPoint3; to: Graph3DPoint3; owners: Set<string> }>();
  geometry.triangles.forEach((triangle, index) => {
    const owner = owners[index];
    if (owner === null) return;
    for (let corner = 0; corner < 3; corner += 1) {
      const from = geometry.positions[triangle[corner]];
      const to = geometry.positions[triangle[(corner + 1) % 3]];
      if (!from || !to) continue;
      const fromKey = key(from);
      const toKey = key(to);
      if (fromKey === toKey) continue;
      const edgeKey = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
      const existing = edges.get(edgeKey);
      if (existing) existing.owners.add(owner);
      else edges.set(edgeKey, { from, to, owners: new Set([owner]) });
    }
  });

  const seams: Array<[Graph3DPoint3, Graph3DPoint3]> = [];
  for (const edge of edges.values()) {
    if (edge.owners.size > 1) seams.push([edge.from, edge.to]);
  }
  return smoothGraph3DSeams(seams, key);
}

/**
 * Straightens the sampling staircase out of a seam.
 *
 * A seam is assembled from triangle edges, so it can only ever run along the sampling grid and a
 * smooth curve comes back as a zigzag with one tooth per cell. Sliding each interior point halfway
 * towards its two neighbours takes the teeth out while leaving the curve where it is; a point that
 * ends a seam or where three faces meet is a real corner of the body and does not move.
 */
function smoothGraph3DSeams(
  seams: Array<[Graph3DPoint3, Graph3DPoint3]>,
  key: (point: Graph3DPoint3) => string,
  passes = 3,
): Array<[Graph3DPoint3, Graph3DPoint3]> {
  if (seams.length === 0) return seams;
  const points = new Map<string, Graph3DPoint3>();
  const neighbours = new Map<string, string[]>();
  for (const [from, to] of seams) {
    const fromKey = key(from);
    const toKey = key(to);
    points.set(fromKey, from);
    points.set(toKey, to);
    for (const [self, other] of [[fromKey, toKey], [toKey, fromKey]]) {
      const adjacent = neighbours.get(self);
      if (adjacent) adjacent.push(other);
      else neighbours.set(self, [other]);
    }
  }
  let moved = points;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Map(moved);
    for (const [pointKey, adjacent] of neighbours) {
      // Only a point with exactly two seam neighbours lies in the middle of a curve.
      if (adjacent.length !== 2) continue;
      const point = moved.get(pointKey);
      const before = moved.get(adjacent[0]);
      const after = moved.get(adjacent[1]);
      if (!point || !before || !after) continue;
      next.set(pointKey, {
        x: (point.x + (before.x + after.x) / 2) / 2,
        y: (point.y + (before.y + after.y) / 2) / 2,
        z: (point.z + (before.z + after.z) / 2) / 2,
      });
    }
    moved = next;
  }
  return seams.map(([from, to]) => [
    moved.get(key(from)) ?? from,
    moved.get(key(to)) ?? to,
  ]);
}

/** The outline where the first body's surface meets the others: what "touching" looks like. */
function buildContactContour(
  bodies: Array<Extract<Graph3DCommonPartMember, { role: "body" }>>,
  variables: MathExpressionVariables,
): Graph3DIntersectionGeometry {
  if (bodies.length < 2) return { kind: "empty" };
  const carrier = buildGraph3DObjectGeometry(bodies[0].object, variables);
  const others = bodies.slice(1);
  const values = carrier.positions.map((point) => {
    let value = -Infinity;
    for (const body of others) value = Math.max(value, body.field.value(point));
    return value;
  });
  const segments = traceGraph3DMeshLevelSet(carrier, values);
  return segments.length > 0 ? { kind: "curve", segments } : { kind: "empty" };
}

/** True when the bodies' boxes at least meet, even if the shared box has no thickness. */
function bodiesTouch(bodies: Array<Extract<Graph3DCommonPartMember, { role: "body" }>>): boolean {
  const boxes = bodies.map((body) => body.field.bounds);
  return (["x", "y", "z"] as const).every((axis) => {
    const min = Math.max(...boxes.map((box) => box.min[axis]));
    const max = Math.min(...boxes.map((box) => box.max[axis]));
    const span = Math.max(...boxes.map((box) => box.max[axis] - box.min[axis]));
    return Number.isFinite(min) && Number.isFinite(max) && max >= min - Math.max(1e-9, span * 1e-6);
  });
}

function buildSharedSolidMesh(
  fields: Graph3DSolidField[],
  bounds: Graph3DBoundingBox,
  resolution: number,
): Graph3DMeshGeometry | null {
  return fields.every((field) => field.halfspaces)
    ? buildExactIntersection(fields)
    : buildSampledIntersection(fields, bounds, resolution);
}

/**
 * One boundary: the part of it the bodies contain.
 *
 * A plane gives closed loops, which is the flat section a textbook shades. A curved surface gives
 * the trimmed patch plus the outline where it leaves the bodies — the "shell only" case, where
 * there is no shared volume to fill because the member has no inside of its own.
 */
function buildSharedBoundaryPart(
  boundary: Extract<Graph3DCommonPartMember, { role: "boundary" }>,
  bodies: Array<Extract<Graph3DCommonPartMember, { role: "body" }>>,
  bodyValue: (point: Graph3DPoint3) => number,
  bodyBounds: Graph3DBoundingBox | null,
  resolution: number,
): Graph3DIntersectionGeometry {
  if (bodies.length === 0 || !bodyBounds) return { kind: "empty" };
  if (boundary.plane) {
    const solid = buildSharedSolidMesh(bodies.map((body) => body.field), bodyBounds, resolution);
    if (!solid) return { kind: "empty" };
    const section = intersectGraph3DMeshWithPlane(solid, boundary.plane);
    if (section.loops.length > 0) return { kind: "section", plane: boundary.plane, section };
    // The plane only grazes the body: an edge, not an area.
    return section.segments.length > 0 ? { kind: "curve", segments: section.segments } : { kind: "empty" };
  }
  const values = boundary.mesh.positions.map(bodyValue);
  const contour = traceGraph3DMeshLevelSet(boundary.mesh, values);
  const patch = trimGraph3DMeshByLevelSet(boundary.mesh, values);
  if (patch.triangles.length > 0) return { kind: "surface", geometry: patch, contour };
  return contour.length > 0 ? { kind: "curve", segments: contour } : { kind: "empty" };
}

/**
 * Two or more boundaries: what is left where they all meet.
 *
 * Planes are solved together, exactly, because that is the case this is really for — two planes
 * meet along a line and three at a point, and a sampled answer would turn both into nothing. A
 * curved boundary has no such closed form, so its contour is traced on the mesh of another member.
 */
function buildSharedEdge(
  boundaries: Array<Extract<Graph3DCommonPartMember, { role: "boundary" }>>,
  bodies: Array<Extract<Graph3DCommonPartMember, { role: "body" }>>,
  bodyValue: (point: Graph3DPoint3) => number,
  bodyBounds: Graph3DBoundingBox | null,
  resolution: number,
): Graph3DIntersectionGeometry {
  const planes = boundaries.filter((boundary) => boundary.plane !== null);
  const tolerance = commonPartTolerance(boundaries, bodyBounds);

  if (planes.length === boundaries.length) {
    const solution = solveGraph3DPlaneSystem(planes.map((boundary) => boundary.plane as ResolvedGraph3DPlane));
    if (solution.kind === "empty") return { kind: "empty" };
    if (solution.kind === "plane") {
      return bodies.length > 0
        ? buildSharedBoundaryPart(boundaries[0], bodies, bodyValue, bodyBounds, resolution)
        : buildCoplanarOverlap(boundaries, solution.plane);
    }
    if (solution.kind === "point") {
      return bodies.length === 0 || bodyValue(solution.point) <= tolerance
        ? { kind: "points", points: [solution.point] }
        : { kind: "empty" };
    }
    const box = bodies.length > 0 && bodyBounds
      ? bodyBounds
      : meshesBounds(boundaries.map((boundary) => boundary.mesh));
    const range = clipGraph3DLineToBox(solution.point, solution.direction, box);
    if (!range) return { kind: "empty" };
    const intervals = bodies.length > 0
      ? clipGraph3DLineByField(solution.point, solution.direction, range, bodyValue)
      : [range];
    const segments = intervals.map((interval): [Graph3DPoint3, Graph3DPoint3] => [
      pointOnLine(solution.point, solution.direction, interval.min),
      pointOnLine(solution.point, solution.direction, interval.max),
    ]);
    return segments.length > 0 ? { kind: "curve", segments } : { kind: "empty" };
  }

  // A curved boundary is involved: trace its contour on the mesh that carries it.
  const carrier = boundaries.find((boundary) => boundary.plane === null) ?? boundaries[0];
  const others = boundaries.filter((boundary) => boundary !== carrier);
  const restrictor = others.find((boundary) => boundary.side !== null);
  if (!restrictor || !restrictor.side) {
    throw new Graph3DModelError("commonPartSurfacesUnsupported");
  }
  const restrict = restrictor.side;
  const values = carrier.mesh.positions.map((point) => restrict(point));
  let segments = traceGraph3DMeshLevelSet(carrier.mesh, values);
  if (bodies.length > 0) segments = clipGraph3DSegmentsByField(segments, bodyValue);
  const remaining = others.filter((boundary) => boundary !== restrictor);
  if (remaining.length === 0) {
    return segments.length > 0 ? { kind: "curve", segments } : { kind: "empty" };
  }

  const [next, ...rest] = remaining;
  if (!next.side) throw new Graph3DModelError("commonPartSurfacesUnsupported");
  let points = findGraph3DSegmentCrossings(segments, next.side);
  for (const extra of rest) {
    const side = extra.side;
    if (!side) throw new Graph3DModelError("commonPartSurfacesUnsupported");
    points = points.filter((point) => Math.abs(side(point)) <= tolerance);
  }
  points = deduplicateGraph3DPoints(points);
  return points.length > 0 ? { kind: "points", points } : { kind: "empty" };
}

/**
 * Planes that turned out to be the same plane, with nothing to trim them: the shared part is where
 * their drawn rectangles overlap.
 */
function buildCoplanarOverlap(
  boundaries: Array<Extract<Graph3DCommonPartMember, { role: "boundary" }>>,
  plane: ResolvedGraph3DPlane,
): Graph3DIntersectionGeometry {
  const basis = createGraph3DPlaneBasisFromPlane(plane);
  let polygon: Graph3DPoint2[] | null = null;
  for (const boundary of boundaries) {
    const quad = orderQuad(boundary.mesh.positions.map((point) => flattenGraph3DPoint(point, basis)));
    polygon = polygon === null ? quad : clipConvexPolygon2D(polygon, quad);
    if (polygon.length < 3) return { kind: "empty" };
  }
  if (!polygon || polygon.length < 3) return { kind: "empty" };
  const points3D = polygon.map((point) => unflattenGraph3DPoint(point, basis));
  const section: Graph3DMeshSection = {
    segments: points3D.map((point, index): [Graph3DPoint3, Graph3DPoint3] => [
      point,
      points3D[(index + 1) % points3D.length],
    ]),
    loops: [{ points3D, points2D: polygon, triangles: triangulateGraph3DPolygon(polygon) }],
  };
  return { kind: "section", plane, section };
}

/** Corners come from a mesh in triangle order; a clip needs them walked around the outline. */
function orderQuad(points: Graph3DPoint2[]): Graph3DPoint2[] {
  const centre = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  return [...points].sort((left, right) => (
    Math.atan2(left.y - centre.y, left.x - centre.x) - Math.atan2(right.y - centre.y, right.x - centre.x)
  ));
}

/** Sutherland-Hodgman. Both polygons are drawn rectangles, so both are convex. */
function clipConvexPolygon2D(subject: Graph3DPoint2[], clip: Graph3DPoint2[]): Graph3DPoint2[] {
  let output = subject;
  for (let index = 0; index < clip.length; index += 1) {
    const start = clip[index];
    const end = clip[(index + 1) % clip.length];
    const inside = (point: Graph3DPoint2) => (
      (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x) >= -1e-9
    );
    const input = output;
    output = [];
    for (let corner = 0; corner < input.length; corner += 1) {
      const current = input[corner];
      const previous = input[(corner + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(intersect2D(previous, current, start, end));
        output.push(current);
      } else if (inside(previous)) {
        output.push(intersect2D(previous, current, start, end));
      }
    }
    if (output.length === 0) return [];
  }
  return output;
}

function intersect2D(
  from: Graph3DPoint2,
  to: Graph3DPoint2,
  edgeStart: Graph3DPoint2,
  edgeEnd: Graph3DPoint2,
): Graph3DPoint2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ex = edgeEnd.x - edgeStart.x;
  const ey = edgeEnd.y - edgeStart.y;
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) <= 1e-12) return to;
  const amount = ((edgeStart.x - from.x) * ey - (edgeStart.y - from.y) * ex) / denominator;
  return { x: from.x + dx * amount, y: from.y + dy * amount };
}

/** How close to a boundary still counts as on it, scaled to how big the drawing actually is. */
function commonPartTolerance(
  boundaries: Array<Extract<Graph3DCommonPartMember, { role: "boundary" }>>,
  bodyBounds: Graph3DBoundingBox | null,
): number {
  const bounds = bodyBounds ?? meshesBounds(boundaries.map((boundary) => boundary.mesh));
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  return Math.max(1e-6, (Number.isFinite(span) ? span : 1) * 1e-4);
}

function meshesBounds(meshes: Graph3DMeshGeometry[]): Graph3DBoundingBox {
  const points = meshes.flatMap((mesh) => mesh.positions);
  return points.length > 0
    ? pointsBounds(points)
    : { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
}

/**
 * The one mesh a thumbnail or an export can draw for any common part.
 *
 * Flat areas arrive as plane loops, curves and points as bare geometry; every drawing surface
 * wants a single mesh, and reproducing this reduction per surface is how they drift apart.
 */
export function getGraph3DIntersectionMesh(
  geometry: Graph3DIntersectionGeometry,
): Graph3DMeshGeometry | null {
  if (geometry.kind === "empty") return null;
  if (geometry.kind === "solid") return geometry.geometry;
  if (geometry.kind === "surface") {
    return geometry.geometry.triangles.length > 0
      ? geometry.geometry
      : segmentsMesh(geometry.contour);
  }
  if (geometry.kind === "curve") return segmentsMesh(geometry.segments);
  if (geometry.kind === "points") {
    return { positions: geometry.points, triangles: [], lineSegments: [] };
  }
  const positions: Graph3DPoint3[] = [];
  const triangles: Array<[number, number, number]> = [];
  for (const loop of geometry.section.loops) {
    const offset = positions.length;
    positions.push(...loop.points3D);
    for (const [a, b, c] of loop.triangles) triangles.push([offset + a, offset + b, offset + c]);
  }
  return { positions, triangles, lineSegments: [] };
}

function segmentsMesh(
  segments: ReadonlyArray<readonly [Graph3DPoint3, Graph3DPoint3]>,
): Graph3DMeshGeometry {
  const positions: Graph3DPoint3[] = [];
  const lineSegments: Array<[number, number]> = [];
  for (const [from, to] of segments) {
    lineSegments.push([positions.length, positions.length + 1]);
    positions.push(from, to);
  }
  return { positions, triangles: [], lineSegments };
}

/**
 * The cached form of {@link buildGraph3DIntersectionGeometry}.
 *
 * A common part is the most expensive thing the scene samples, and the live window, the settings
 * card and the derived preview all ask for the same one. The key drops parameters the member
 * objects never mention, so dragging a slider does not rebuild a common part that cannot move.
 */
export function getGraph3DIntersectionGeometry(
  objects: readonly Graph3DObject[],
  variables: MathExpressionVariables,
  options: { resolution?: number } = {},
): Graph3DIntersectionGeometry {
  const source = JSON.stringify(objects, omitPresentationFields);
  const used = Object.keys(variables)
    .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(source))
    .sort()
    .map((name) => `${name}=${variables[name]}`)
    .join(",");
  const key = `${source}|${options.resolution ?? ""}|${used}`;
  const cached = intersectionCache.get(key);
  if (cached) return cached;
  const geometry = buildGraph3DIntersectionGeometry(objects, variables, options);
  if (intersectionCache.size >= MAX_INTERSECTION_CACHE_ENTRIES) {
    const oldest = intersectionCache.keys().next().value;
    if (oldest !== undefined) intersectionCache.delete(oldest);
  }
  intersectionCache.set(key, geometry);
  return geometry;
}

const intersectionCache = new Map<string, Graph3DIntersectionGeometry>();
const MAX_INTERSECTION_CACHE_ENTRIES = 32;

/** Colour, name and visibility never change the shape, so they stay out of the cache key. */
function omitPresentationFields(key: string, value: unknown): unknown {
  return key === "style" || key === "name" || key === "visible" ? undefined : value;
}

function buildExactIntersection(fields: Graph3DSolidField[]): Graph3DMeshGeometry | null {
  const halfspaces = fields.flatMap((field) => field.halfspaces ?? []);
  try {
    return buildGraph3DHalfspacePolytope(halfspaces);
  } catch {
    // Fewer than four vertices survive when the bodies only touch: nothing to fill.
    return null;
  }
}

function buildSampledIntersection(
  fields: Graph3DSolidField[],
  bounds: Graph3DBoundingBox,
  resolution: number,
): Graph3DMeshGeometry | null {
  // The sampled box is grown slightly past the shared bounds so the field is positive on every
  // border sample and the marched surface closes instead of ending in an open rim.
  const padded = padBounds(bounds, 0.06);
  const geometry = marchGraph3DScalarField(padded.min, padded.max, resolution, (point) => {
    let value = -Infinity;
    for (const field of fields) {
      const candidate = field.value(point);
      if (candidate > value) value = candidate;
    }
    return value;
  });
  return geometry.triangles.length > 0 ? geometry : null;
}

function createBoundedSolidField(
  object: Extract<Graph3DObject, { kind: "boundedSolid" }>,
  variables: MathExpressionVariables,
): Graph3DSolidField {
  const inequalities = expandGraph3DInequalities(object.inequalities);
  if (inequalities.length === 0) throw new Graph3DModelError("inequalityRequired");
  const affine = inequalities.map((inequality) => tryParseGraph3DAffineInequality(inequality, variables));
  if (affine.every((halfspace): halfspace is Graph3DHalfspace => halfspace !== null)) {
    return fromHalfspaces(createBoundedSolidHalfspaces({ ...object, inequalities }, variables));
  }
  const min = {
    x: evaluateMathExpression(object.bounds.x.min, variables),
    y: evaluateMathExpression(object.bounds.y.min, variables),
    z: evaluateMathExpression(object.bounds.z.min, variables),
  };
  const max = {
    x: evaluateMathExpression(object.bounds.x.max, variables),
    y: evaluateMathExpression(object.bounds.y.max, variables),
    z: evaluateMathExpression(object.bounds.z.max, variables),
  };
  const fields = inequalities.map((inequality) => compileGraph3DInequalityField(inequality, variables));
  const bounds = { min, max };
  return {
    bounds,
    value: (point) => {
      let value = boxDistance(point, bounds);
      for (const field of fields) {
        value = Math.max(value, field(point));
      }
      return value;
    },
  };
}

function createParametricSurfaceField(
  object: Extract<Graph3DObject, { kind: "parametricSurface" }>,
  variables: MathExpressionVariables,
): Graph3DSolidField | null {
  const geometry = buildGraph3DObjectLocalGeometry(object, variables);
  if (!graph3DMeshIsClosed(geometry)) return null;
  const triangles = geometry.triangles.map(([a, b, c]) => (
    [geometry.positions[a], geometry.positions[b], geometry.positions[c]] as [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3]
  ));
  const bounds = pointsBounds(geometry.positions);
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  return {
    bounds,
    value: (point) => (isInsideBox(point, bounds) && isInsideMesh(point, triangles) ? -span * 0.05 : span * 0.05),
  };
}

function applySolidTransform(
  object: Graph3DObject,
  field: Graph3DSolidField,
  variables: MathExpressionVariables,
): Graph3DSolidField {
  const rotation = evaluateGraph3DObjectRotation(object, variables);
  const scaleFactors = evaluateGraph3DObjectScale(object, variables);
  const translation = evaluateGraph3DObjectTranslation(object, variables);
  const identityScale = Math.abs(scaleFactors.x - 1) <= EPSILON &&
    Math.abs(scaleFactors.y - 1) <= EPSILON &&
    Math.abs(scaleFactors.z - 1) <= EPSILON;
  if (isZeroGraph3DRotation(rotation) && identityScale && isZeroGraph3DRotation(translation)) return field;
  const origin = graph3DObjectRotationOrigin(
    object,
    [field.bounds.min, field.bounds.max],
    variables,
  );
  const toWorld = (point: Graph3DPoint3): Graph3DPoint3 => {
    const local = subtract(point, origin);
    const scaled = {
      x: local.x * scaleFactors.x,
      y: local.y * scaleFactors.y,
      z: local.z * scaleFactors.z,
    };
    return add(add(rotateGraph3DEuler(scaled, rotation), origin), translation);
  };
  const toLocal = (point: Graph3DPoint3): Graph3DPoint3 => {
    const unrotated = unrotateGraph3DEuler(subtract(subtract(point, translation), origin), rotation);
    return add({
      x: unrotated.x / scaleFactors.x,
      y: unrotated.y / scaleFactors.y,
      z: unrotated.z / scaleFactors.z,
    }, origin);
  };
  const corners = [
    field.bounds.min,
    { x: field.bounds.max.x, y: field.bounds.min.y, z: field.bounds.min.z },
    { x: field.bounds.min.x, y: field.bounds.max.y, z: field.bounds.min.z },
    { x: field.bounds.min.x, y: field.bounds.min.y, z: field.bounds.max.z },
    { x: field.bounds.max.x, y: field.bounds.max.y, z: field.bounds.min.z },
    { x: field.bounds.max.x, y: field.bounds.min.y, z: field.bounds.max.z },
    { x: field.bounds.min.x, y: field.bounds.max.y, z: field.bounds.max.z },
    field.bounds.max,
  ].map(toWorld);
  return {
    bounds: pointsBounds(corners),
    value: (point) => field.value(toLocal(point)),
    ...(field.halfspaces
      ? {
          halfspaces: field.halfspaces.map((halfspace) => {
            const normal = rotateGraph3DEuler({
              x: halfspace.normal.x / scaleFactors.x,
              y: halfspace.normal.y / scaleFactors.y,
              z: halfspace.normal.z / scaleFactors.z,
            }, rotation);
            return {
              normal,
              offset: halfspace.offset + dot(halfspace.normal, origin) - dot(normal, add(origin, translation)),
            };
          }),
        }
      : {}),
  };
}

function fromHalfspaces(halfspaces: Graph3DHalfspace[]): Graph3DSolidField {
  return {
    halfspaces,
    bounds: halfspaceBounds(halfspaces),
    value: (point) => {
      let value = -Infinity;
      for (const halfspace of halfspaces) {
        const distance = (dot(halfspace.normal, point) + halfspace.offset) / Math.max(EPSILON, length(halfspace.normal));
        if (distance > value) value = distance;
      }
      return value;
    },
  };
}

function createPrimitiveField(
  object: Extract<Graph3DObject, { kind: "primitive" }>,
  variables: MathExpressionVariables,
): Graph3DSolidField {
  const center = evaluateVector(object.center, variables);
  const size = evaluateVector(object.size, variables);
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) throw new Graph3DModelError("solidSizeNotPositive");
  const half = scale(size, 0.5);
  const toLocal = (point: Graph3DPoint3): Graph3DPoint3 => subtract(point, center);
  const bounds = { min: subtract(center, half), max: add(center, half) };

  if (object.primitive === "box") {
    // A box — rotated or not — is exactly six half-spaces, so it can join an exact intersection.
    const halfspaces: Graph3DHalfspace[] = [];
    const identity = {
      x: { x: 1, y: 0, z: 0 },
      y: { x: 0, y: 1, z: 0 },
      z: { x: 0, y: 0, z: 1 },
    };
    for (const axis of ["x", "y", "z"] as const) {
      const normal = identity[axis];
      const extent = half[axis];
      halfspaces.push({ normal, offset: -(dot(normal, center) + extent) });
      halfspaces.push({ normal: scale(normal, -1), offset: dot(normal, center) - extent });
    }
    return { ...fromHalfspaces(halfspaces), bounds };
  }

  const radialScale = Math.min(half.x, half.y);
  if (object.primitive === "sphere") {
    return {
      bounds,
      value: (point) => {
        const local = toLocal(point);
        const normalized = Math.hypot(local.x / half.x, local.y / half.y, local.z / half.z);
        return (normalized - 1) * Math.min(half.x, half.y, half.z);
      },
    };
  }
  if (object.primitive === "cylinder") {
    return {
      bounds,
      value: (point) => {
        const local = toLocal(point);
        const radial = (Math.hypot(local.x / half.x, local.y / half.y) - 1) * radialScale;
        return Math.max(radial, Math.abs(local.z) - half.z);
      },
    };
  }
  return {
    bounds,
    value: (point) => {
      const local = toLocal(point);
      // The cone tapers from the full radius at its base to the apex, matching the drawn mesh.
      const taper = Math.max(0, (half.z - local.z) / (2 * half.z));
      const radial = (Math.hypot(local.x / half.x, local.y / half.y) - taper) * radialScale;
      return Math.max(radial, Math.abs(local.z) - half.z);
    },
  };
}

function createPolyhedronField(
  object: Extract<Graph3DObject, { kind: "polyhedron" }>,
  variables: MathExpressionVariables,
): Graph3DSolidField {
  const vertices = object.vertices.map((vertex) => evaluateVector(vertex, variables));
  const bounds = pointsBounds(vertices);
  const centroid = scale(
    vertices.reduce((sum, point) => add(sum, point), { x: 0, y: 0, z: 0 }),
    1 / Math.max(1, vertices.length),
  );
  const halfspaces: Graph3DHalfspace[] = [];
  for (const face of object.faces) {
    const [a, b, c] = [vertices[face[0]], vertices[face[1]], vertices[face[2]]];
    if (!a || !b || !c) continue;
    const raw = cross(subtract(b, a), subtract(c, a));
    const magnitude = length(raw);
    if (magnitude <= EPSILON) continue;
    // Outward normals: flip whichever way leaves the body's centre inside.
    const normal = dot(raw, subtract(centroid, a)) > 0 ? scale(raw, -1 / magnitude) : scale(raw, 1 / magnitude);
    halfspaces.push({ normal, offset: -dot(normal, a) });
  }
  const convex = halfspaces.length > 0 && vertices.every((vertex) => (
    halfspaces.every((halfspace) => dot(halfspace.normal, vertex) + halfspace.offset <= 1e-6)
  ));
  if (convex) return { ...fromHalfspaces(halfspaces), bounds };

  // A dented polyhedron is not the intersection of its faces, so fall back to a containment test.
  const triangles = object.faces.flatMap((face) => (
    Array.from({ length: Math.max(0, face.length - 2) }, (_, index) => [
      vertices[face[0]],
      vertices[face[index + 1]],
      vertices[face[index + 2]],
    ] as [Graph3DPoint3, Graph3DPoint3, Graph3DPoint3])
  ));
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  return {
    bounds,
    value: (point) => (isInsideBox(point, bounds) && isInsideMesh(point, triangles) ? -span * 0.05 : span * 0.05),
  };
}

function createRevolutionField(
  object: Extract<Graph3DObject, { kind: "solidOfRevolution" }>,
  variables: MathExpressionVariables,
): Graph3DSolidField {
  const axis = resolveRevolutionAxis(object, variables);
  const axisMin = evaluateMathExpression(object.axisRange.min, variables);
  const axisMax = evaluateMathExpression(object.axisRange.max, variables);
  if (!(axisMax > axisMin)) throw new Graph3DModelError("rangeMaxNotGreaterThanMin");
  const scope: Record<string, number> = { ...variables };
  const radiusAt = compileMathExpression(object.radius);
  const sampleRadius = (axisValue: number) => {
    scope[axis.parameter] = axisValue;
    const radius = radiusAt(scope);
    return Number.isFinite(radius) && radius > 0 ? radius : 0;
  };
  let maxRadius = 0;
  for (let index = 0; index <= 48; index += 1) {
    maxRadius = Math.max(maxRadius, sampleRadius(axisMin + (axisMax - axisMin) * index / 48));
  }
  const ends = [
    add(axis.point, scale(axis.direction, axisMin)),
    add(axis.point, scale(axis.direction, axisMax)),
  ];
  const bounds = padBounds(pointsBounds(ends), 0, maxRadius);

  return {
    bounds,
    value: (point) => {
      const relative = subtract(point, axis.point);
      const axisValue = dot(relative, axis.direction);
      const radial = length(subtract(relative, scale(axis.direction, axisValue)));
      const clamped = Math.min(axisMax, Math.max(axisMin, axisValue));
      return Math.max(
        radial - sampleRadius(clamped),
        axisMin - axisValue,
        axisValue - axisMax,
      );
    },
  };
}

function createImplicitField(
  object: Extract<Graph3DObject, { kind: "implicitSurface" }>,
  variables: MathExpressionVariables,
): Graph3DSolidField {
  const min = {
    x: evaluateMathExpression(object.bounds.x.min, variables),
    y: evaluateMathExpression(object.bounds.y.min, variables),
    z: evaluateMathExpression(object.bounds.z.min, variables),
  };
  const max = {
    x: evaluateMathExpression(object.bounds.x.max, variables),
    y: evaluateMathExpression(object.bounds.y.max, variables),
    z: evaluateMathExpression(object.bounds.z.max, variables),
  };
  const scope: Record<string, number> = { ...variables };
  const level = compileMathEquation(object.expression);
  const bounds = { min, max };
  return {
    bounds,
    value: (point) => {
      scope.x = point.x;
      scope.y = point.y;
      scope.z = point.z;
      const inside = level(scope);
      // Outside the authored search box the level expression says nothing useful, so the box
      // itself bounds the body.
      return Math.max(Number.isFinite(inside) ? inside : 1, boxDistance(point, bounds));
    },
  };
}

interface ResolvedRevolutionAxis {
  point: Graph3DPoint3;
  direction: Graph3DPoint3;
  parameter: string;
}

function resolveRevolutionAxis(
  object: Extract<Graph3DObject, { kind: "solidOfRevolution" }>,
  variables: MathExpressionVariables,
): ResolvedRevolutionAxis {
  const axis = object.axis;
  if (typeof axis === "string") {
    return {
      point: { x: 0, y: 0, z: 0 },
      direction: { x: axis === "x" ? 1 : 0, y: axis === "y" ? 1 : 0, z: axis === "z" ? 1 : 0 },
      parameter: axis,
    };
  }
  const first = resolveGraph3DPlane({ kind: "equation", expression: axis.equations[0] }, variables);
  const second = resolveGraph3DPlane({ kind: "equation", expression: axis.equations[1] }, variables);
  const direction = cross(first.normal, second.normal);
  const denominator = dot(direction, direction);
  if (denominator <= EPSILON) throw new Graph3DModelError("revolutionAxisPlanesParallel");
  const point = scale(add(
    scale(cross(second.normal, direction), first.constant),
    scale(cross(direction, first.normal), second.constant),
  ), 1 / denominator);
  return {
    point,
    direction: normalize(direction),
    parameter: axis.parameter?.trim().toLowerCase() || "t",
  };
}

function intersectBounds(boxes: Graph3DBoundingBox[]): Graph3DBoundingBox | null {
  const min = { x: -Infinity, y: -Infinity, z: -Infinity };
  const max = { x: Infinity, y: Infinity, z: Infinity };
  for (const box of boxes) {
    for (const axis of ["x", "y", "z"] as const) {
      min[axis] = Math.max(min[axis], box.min[axis]);
      max[axis] = Math.min(max[axis], box.max[axis]);
    }
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(min[axis]) || !Number.isFinite(max[axis]) || max[axis] - min[axis] <= EPSILON) {
      return null;
    }
  }
  return { min, max };
}

function halfspaceBounds(halfspaces: Graph3DHalfspace[]): Graph3DBoundingBox {
  const min = { x: -Infinity, y: -Infinity, z: -Infinity };
  const max = { x: Infinity, y: Infinity, z: Infinity };
  for (const halfspace of halfspaces) {
    for (const axis of ["x", "y", "z"] as const) {
      const others = (["x", "y", "z"] as const).filter((candidate) => candidate !== axis);
      if (others.some((candidate) => Math.abs(halfspace.normal[candidate]) > 1e-9)) continue;
      const coefficient = halfspace.normal[axis];
      if (Math.abs(coefficient) <= 1e-9) continue;
      const limit = -halfspace.offset / coefficient;
      if (coefficient > 0) max[axis] = Math.min(max[axis], limit);
      else min[axis] = Math.max(min[axis], limit);
    }
  }
  return { min, max };
}

function pointsBounds(points: Graph3DPoint3[]): Graph3DBoundingBox {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const point of points) {
    for (const axis of ["x", "y", "z"] as const) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max };
}

function padBounds(bounds: Graph3DBoundingBox, ratio: number, absolute = 0): Graph3DBoundingBox {
  const min = { ...bounds.min };
  const max = { ...bounds.max };
  for (const axis of ["x", "y", "z"] as const) {
    const pad = (max[axis] - min[axis]) * ratio + absolute;
    min[axis] -= pad;
    max[axis] += pad;
  }
  return { min, max };
}

function boxDistance(point: Graph3DPoint3, bounds: Graph3DBoundingBox): number {
  return Math.max(
    bounds.min.x - point.x, point.x - bounds.max.x,
    bounds.min.y - point.y, point.y - bounds.max.y,
    bounds.min.z - point.z, point.z - bounds.max.z,
  );
}

function isInsideBox(point: Graph3DPoint3, bounds: Graph3DBoundingBox): boolean {
  return boxDistance(point, bounds) <= 0;
}

/** Ray parity against every face; used only for polyhedra that are not convex. */
function isInsideMesh(
  point: Graph3DPoint3,
  triangles: Array<[Graph3DPoint3, Graph3DPoint3, Graph3DPoint3]>,
): boolean {
  const direction = { x: 0.5773502691896258, y: 0.5773502691896258, z: 0.5773502691896258 };
  let crossings = 0;
  for (const [a, b, c] of triangles) {
    const edge1 = subtract(b, a);
    const edge2 = subtract(c, a);
    const pvec = cross(direction, edge2);
    const determinant = dot(edge1, pvec);
    if (Math.abs(determinant) <= EPSILON) continue;
    const inverse = 1 / determinant;
    const tvec = subtract(point, a);
    const u = dot(tvec, pvec) * inverse;
    if (u < 0 || u > 1) continue;
    const qvec = cross(tvec, edge1);
    const v = dot(direction, qvec) * inverse;
    if (v < 0 || u + v > 1) continue;
    if (dot(edge2, qvec) * inverse > EPSILON) crossings += 1;
  }
  return crossings % 2 === 1;
}

/** Negative inside the polygon; the magnitude is the distance to its boundary. */
function evaluateVector(
  vector: { x: string; y: string; z: string },
  variables: MathExpressionVariables,
): Graph3DPoint3 {
  const point = {
    x: evaluateMathExpression(vector.x, variables),
    y: evaluateMathExpression(vector.y, variables),
    z: evaluateMathExpression(vector.z, variables),
  };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    throw new Graph3DModelError("coordinateNotFinite");
  }
  return point;
}

function normalize(vector: Graph3DPoint3): Graph3DPoint3 {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) {
    throw new Graph3DModelError("directionVectorLengthZero");
  }
  return scale(vector, 1 / magnitude);
}
