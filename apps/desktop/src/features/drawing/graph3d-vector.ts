/** Plain mathematical coordinates, independent of plane definitions and mesh generation. */
export interface Graph3DPoint3 {
  x: number;
  y: number;
  z: number;
}

export interface Graph3DPoint2 {
  x: number;
  y: number;
}

// Arithmetic always returns fresh points. Degenerate-direction tolerances and recovery
// belong to the geometry operation using the vector, so normalization stays at callers.
export function add(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(vector: Graph3DPoint3, factor: number): Graph3DPoint3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

export function dot(a: Graph3DPoint3, b: Graph3DPoint3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(vector: Graph3DPoint3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}
