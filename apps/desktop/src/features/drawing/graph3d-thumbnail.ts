/**
 * The small "what is this object" picture shown on each 3D settings card.
 *
 * It is drawn from the same evaluated mesh the scene uses, but as a shaded, depth-sorted solid
 * seen from the default camera. Drawing every mesh line instead produced an unreadable scribble:
 * a dense parametric surface has thousands of grid segments, and dropping some of them to keep
 * the picture small only turned the scribble into dashes.
 */
import {
  subtract,
  scale,
  dot,
  cross,
  length,
  type Graph3DPoint2,
  type Graph3DPoint3,
} from "./graph3d-vector";
import type { Graph3DObject } from "@/features/document";

import {
  MIN_PRIMITIVE_RING_SAMPLES,
  graph3DBoundedSolidResolution,
  type Graph3DMeshGeometry,
} from "./graph3d-geometry";

/** Matches the default camera, so a card and the live view show the same side of the object. */
const VIEW_DIRECTION: Graph3DPoint3 = { x: -5.5, y: 6.5, z: -4.5 };
const LIGHT_DIRECTION: Graph3DPoint3 = { x: 0.35, y: -0.62, z: 0.7 };
const FLOOR_LINES = 5;

export interface Graph3DThumbnailFace {
  points: Graph3DPoint2[];
  /** 0 (deep shadow) to 1 (full light). */
  shade: number;
}

export interface Graph3DThumbnailDrawing {
  faces: Graph3DThumbnailFace[];
  polylines: Graph3DPoint2[][];
  points: Graph3DPoint2[];
  /** Faint ground grid under the object; it is what makes the picture read as 3D. */
  floor: Array<[Graph3DPoint2, Graph3DPoint2]>;
}

/**
 * A copy of the object sampled coarsely enough for a thumbnail.
 *
 * The card is ~130px wide, so the authored plot counts buy nothing there and cost a full mesh
 * rebuild on every parameter tick.
 */
export function createGraph3DThumbnailObject(object: Graph3DObject): Graph3DObject {
  switch (object.kind) {
    case "parametricSurface":
      return { ...object, u: cap(object.u, 20), v: cap(object.v, 14) };
    case "parametricCurve":
      return { ...object, range: cap(object.range, 120) };
    case "solidOfRevolution":
      return {
        ...object,
        axisRange: cap(object.axisRange, 12),
        ...(object.angleRange ? { angleRange: cap(object.angleRange, 20) } : {}),
      };
    case "implicitSurface":
      return { ...object, resolution: Math.min(object.resolution ?? 20, 12) };
    case "boundedSolid":
      return { ...object, resolution: Math.min(graph3DBoundedSolidResolution(object), 14) };
    case "primitive":
      // A card is ~130px wide: the segments a big sphere needs on the page are invisible here.
      return { ...object, resolution: MIN_PRIMITIVE_RING_SAMPLES };
    default:
      return object;
  }
}

export function createGraph3DThumbnailDrawing(
  geometry: Graph3DMeshGeometry | null,
  width: number,
  height: number,
  padding = 8,
): Graph3DThumbnailDrawing {
  const empty: Graph3DThumbnailDrawing = { faces: [], polylines: [], points: [], floor: [] };
  if (!geometry || geometry.positions.length === 0) return empty;
  const finite = geometry.positions.filter(isFinitePoint);
  if (finite.length === 0) return empty;

  const forward = normalize(VIEW_DIRECTION);
  const right = normalize(cross(forward, { x: 0, y: 0, z: 1 }));
  const up = cross(right, forward);
  const light = normalize(LIGHT_DIRECTION);
  const flatten = (point: Graph3DPoint3): Graph3DPoint2 => ({
    x: dot(point, right),
    y: -dot(point, up),
  });

  const floorSegments = createFloorSegments(finite);
  const flattened = geometry.positions.map(flatten);
  const flatFloor = floorSegments.map((segment) => segment.map(flatten) as [Graph3DPoint2, Graph3DPoint2]);
  const view = fitView(
    [...flattened.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), ...flatFloor.flat()],
    width,
    height,
    padding,
  );
  const project = (index: number) => view(flattened[index]);

  const faces = geometry.triangles.flatMap((triangle) => {
    const [a, b, c] = triangle.map((index) => geometry.positions[index]);
    if (!isFinitePoint(a) || !isFinitePoint(b) || !isFinitePoint(c)) return [];
    const normal = cross(subtract(b, a), subtract(c, a));
    const magnitude = length(normal);
    if (magnitude <= 1e-9) return [];
    // Both facings are lit the same way: authored meshes are not consistently wound, and a
    // one-sided rule would leave random black patches on an otherwise smooth surface.
    const shade = 0.34 + 0.66 * Math.abs(dot(scale(normal, 1 / magnitude), light));
    return [{
      shade,
      depth: dot(centroid(a, b, c), forward),
      points: triangle.map(project),
    }];
  });
  // Painter's algorithm: the far side is drawn first and covered by what is in front of it.
  faces.sort((left, righthand) => righthand.depth - left.depth);

  return {
    floor: flatFloor.map((segment) => [view(segment[0]), view(segment[1])]),
    faces: faces.map(({ points, shade }) => ({ points, shade })),
    polylines: faces.length > 0 ? [] : chainSegments(geometry, project),
    points: faces.length === 0 && geometry.lineSegments.length === 0
      ? geometry.positions.map((_, index) => project(index))
      : [],
  };
}

/** Connected runs, so a curve is drawn as one stroke instead of a field of separate dashes. */
function chainSegments(
  geometry: Graph3DMeshGeometry,
  project: (index: number) => Graph3DPoint2,
): Graph3DPoint2[][] {
  const runs: Graph3DPoint2[][] = [];
  let current: number[] = [];
  for (const [from, to] of geometry.lineSegments) {
    if (current.length > 0 && current[current.length - 1] === from) {
      current.push(to);
      continue;
    }
    if (current.length > 1) runs.push(current.map(project));
    current = [from, to];
  }
  if (current.length > 1) runs.push(current.map(project));
  return runs;
}

/** A grid on the object's own footprint; it sits at the lowest z the object reaches. */
function createFloorSegments(points: Graph3DPoint3[]): Array<[Graph3DPoint3, Graph3DPoint3]> {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const point of points) {
    for (const axis of ["x", "y", "z"] as const) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  const spanX = max.x - min.x;
  const spanY = max.y - min.y;
  if (!(spanX > 1e-6) || !(spanY > 1e-6)) return [];
  const segments: Array<[Graph3DPoint3, Graph3DPoint3]> = [];
  for (let index = 0; index <= FLOOR_LINES; index += 1) {
    const amount = index / FLOOR_LINES;
    const x = min.x + spanX * amount;
    const y = min.y + spanY * amount;
    segments.push([{ x, y: min.y, z: min.z }, { x, y: max.y, z: min.z }]);
    segments.push([{ x: min.x, y, z: min.z }, { x: max.x, y, z: min.z }]);
  }
  return segments;
}

function fitView(
  points: Graph3DPoint2[],
  width: number,
  height: number,
  padding: number,
): (point: Graph3DPoint2) => Graph3DPoint2 {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scaleFactor = Math.min(
    (width - padding * 2) / Math.max(1e-6, maxX - minX),
    (height - padding * 2) / Math.max(1e-6, maxY - minY),
  );
  return (point) => ({
    x: width / 2 + (point.x - (minX + maxX) / 2) * scaleFactor,
    y: height / 2 + (point.y - (minY + maxY) / 2) * scaleFactor,
  });
}

function cap<Range extends { samples?: number }>(range: Range, limit: number): Range {
  return { ...range, samples: Math.min(range.samples ?? limit, limit) };
}

function isFinitePoint(point: Graph3DPoint3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function centroid(a: Graph3DPoint3, b: Graph3DPoint3, c: Graph3DPoint3): Graph3DPoint3 {
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
}

function normalize(vector: Graph3DPoint3): Graph3DPoint3 {
  const magnitude = length(vector);
  return magnitude <= 1e-9 ? { x: 0, y: 0, z: 1 } : scale(vector, 1 / magnitude);
}
