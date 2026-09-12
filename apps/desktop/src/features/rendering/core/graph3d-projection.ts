import type { Graph3DCamera } from "@/features/document";

/**
 * The authored viewpoint as a plain function from a mathematical point to a pixel.
 *
 * The live 3D view draws through three.js, but the printed page, the exported SVG and the
 * headless preview have no WebGL context. Both worlds have to agree on where a point lands or
 * a TeX label drifts off the vertex it names, so the camera arithmetic lives here — outside the
 * three adapter — and `createThreeGraph3DCamera` mirrors it with the same numbers.
 */
export interface Graph3DProjectedPoint {
  x: number;
  y: number;
  /**
   * Distance along the view direction. Larger is further away, which is what a painter's
   * algorithm sorts on; it is not a normalized depth-buffer value.
   */
  depth: number;
}

export interface Graph3DProjector {
  /** `null` for a point at or behind the near plane, which has no place on the picture. */
  project(point: { x: number; y: number; z: number }): Graph3DProjectedPoint | null;
}

/** Points closer than this are behind or on the lens and cannot be drawn. */
export const GRAPH3D_NEAR_PLANE = 0.01;

/**
 * Half the height of the view box, in scene units.
 *
 * Both projections keep the same 6-unit vertical box, so switching between them changes only the
 * perspective divide — never the framing the author set up (`createThreeGraph3DCamera`).
 */
export const GRAPH3D_VIEW_HALF_HEIGHT = 3;

/** Vertical field of view when the figure does not state one. */
export const GRAPH3D_DEFAULT_FOV_DEGREES = 45;

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

const NOTHING_PROJECTS: Graph3DProjector = { project: () => null };

export function createGraph3DProjector(
  camera: Graph3DCamera,
  width: number,
  height: number,
): Graph3DProjector {
  const straightForward = normalize3(subtract3(camera.target, camera.position));
  if (!straightForward) return NOTHING_PROJECTS;
  const basis = resolveViewBasis(straightForward, camera.up);
  if (!basis) return NOTHING_PROJECTS;
  const { forward, right, screenUp } = basis;

  const aspect = Math.max(1e-6, width / Math.max(1, height));
  const orthographicHalfHeight = GRAPH3D_VIEW_HALF_HEIGHT / Math.max(1e-6, camera.zoom ?? 1);
  const perspectiveSlope = Math.tan(((camera.fov ?? GRAPH3D_DEFAULT_FOV_DEGREES) * Math.PI) / 360);

  return {
    project(point) {
      const relative = subtract3(point, camera.position);
      const depth = dot3(relative, forward);
      if (!(depth > GRAPH3D_NEAR_PLANE)) return null;
      const halfHeight = camera.projection === "orthographic"
        ? orthographicHalfHeight
        : perspectiveSlope * depth;
      const ndcX = dot3(relative, right) / (halfHeight * aspect);
      const ndcY = dot3(relative, screenUp) / halfHeight;
      if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;
      return {
        x: (ndcX * 0.5 + 0.5) * width,
        y: (-ndcY * 0.5 + 0.5) * height,
        depth,
      };
    },
  };
}

/**
 * The screen axes for a viewpoint, nudged the way `Matrix4.lookAt` nudges a degenerate one.
 *
 * Looking straight along the up axis — a plain top view (position `(0,0,10)`, up `+z`) — leaves
 * the two vectors parallel and their cross product zero. three.js perturbs the view direction by
 * a ten-thousandth and carries on drawing, so refusing here would make only the headless side
 * hand back an empty picture, which then gets stamped as the figure's current preview.
 */
function resolveViewBasis(
  forward: Vector3,
  up: Vector3,
): { forward: Vector3; right: Vector3; screenUp: Vector3 } | null {
  const direct = buildViewBasis(forward, up);
  if (direct) return direct;

  const normalizedUp = normalize3(up);
  if (!normalizedUp) return null;
  const nudged = normalize3(Math.abs(normalizedUp.z) > 1 - 1e-9
    ? { ...forward, x: forward.x + 1e-4 }
    : { ...forward, z: forward.z + 1e-4 });
  return nudged ? buildViewBasis(nudged, up) : null;
}

function buildViewBasis(
  forward: Vector3,
  up: Vector3,
): { forward: Vector3; right: Vector3; screenUp: Vector3 } | null {
  const right = normalize3(cross3(forward, up));
  if (!right) return null;
  const screenUp = normalize3(cross3(right, forward));
  return screenUp ? { forward, right, screenUp } : null;
}

function subtract3(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot3(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross3(a: Vector3, b: Vector3): Vector3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize3(vector: Vector3): Vector3 | null {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  return magnitude > 1e-9
    ? { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude }
    : null;
}
