import type { Graph3DAxisLineStyle } from "@/features/document";

import type { ArrowheadMarkerSpec } from "./arrowhead-spec";

/**
 * The drawing conventions of a 3D figure, stated once for every renderer that draws one.
 *
 * Two renderers now put the same figure on paper: the three.js view (which is also what the
 * editor captures) and the headless SVG path used when there is no WebGL context. Constants
 * duplicated on both sides drift the moment one is tuned — a default colour changed in the live
 * view but not in the exported picture is invisible until a teacher prints. They live here, in
 * the framework-neutral core, because both adapters may read the core and neither may read the
 * other.
 */

/** Half-length of the drawn coordinate axes, in scene units. */
export const GRAPH3D_AXIS_LENGTH = 3;

/** Flat arrow-head size, relative to the axis half-length. */
export const GRAPH3D_AXIS_ARROW_LENGTH_RATIO = 0.11;

export const GRAPH3D_DEFAULT_OBJECT_COLOR = "#52677a";
export const GRAPH3D_DEFAULT_CONTOUR_COLOR = "#d97706";
/** A solid is drawn see-through by default: a textbook figure has to show what is inside it. */
export const GRAPH3D_DEFAULT_OBJECT_OPACITY = 0.72;
export const GRAPH3D_DEFAULT_WIREFRAME_COLOR = "#1f2933";
export const GRAPH3D_DEFAULT_INTERSECTION_OPACITY = 0.45;
/**
 * Radius of a shared-point dot. Scene units, not pixels: the dot keeps its size in the figure
 * however the camera moves.
 */
export const GRAPH3D_INTERSECTION_POINT_RADIUS = 0.07;
export const GRAPH3D_DEFAULT_BACKGROUND_COLOR = "#ffffff";
export const GRAPH3D_DEFAULT_DIMENSION_COLOR = "#1f2937";

/** The ground grid: `size` units across, `divisions` cells, drawn on the `z = 0` plane. */
export const GRAPH3D_GRID = {
  size: 10,
  divisions: 10,
  /** The two lines through the origin. */
  centerLineColor: "#8895a1",
  gridColor: "#d8dde2",
} as const;

export interface Graph3DDirectionalLight {
  readonly color: string;
  readonly intensity: number;
  readonly direction: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * The lights every 3D surface is lit with, so a still, an animation and a video match.
 *
 * `direction` is where the light sits, in scene units; a directional light in three shines from
 * its position toward the origin, and the SVG renderer only needs the direction that implies.
 */
export const GRAPH3D_LIGHTS = {
  ambient: { color: "#ffffff", intensity: 1.45 },
  key: { color: "#ffffff", intensity: 2.2, direction: { x: 4, y: -5, z: 8 } },
  fill: { color: "#dbeafe", intensity: 0.9, direction: { x: -5, y: 3, z: 2 } },
} as const;

const GRAPH3D_TOTAL_LIGHT_INTENSITY =
  GRAPH3D_LIGHTS.ambient.intensity + GRAPH3D_LIGHTS.key.intensity + GRAPH3D_LIGHTS.fill.intensity;

/**
 * How brightly a face with this normal is lit, from `0` (unlit) to `1` (facing every light).
 *
 * **Both facings are lit the same way.** Authored meshes are not consistently wound — a marched
 * solid has no outside to agree on — and a one-sided rule leaves random black patches across an
 * otherwise smooth surface (`graph3d-thumbnail.ts` learned this first).
 *
 * This is a Lambert sum over the same light table three shades with, not a port of its PBR
 * response: the headless picture is a stand-in for a WebGL capture, and matching the light
 * directions and their relative strengths is what keeps the two from reading as different figures.
 */
export function graph3DLambertShade(normal: { x: number; y: number; z: number }): number {
  const unit = normalizeLightVector(normal);
  if (!unit) return GRAPH3D_LIGHTS.ambient.intensity / GRAPH3D_TOTAL_LIGHT_INTENSITY;
  const diffuse = [GRAPH3D_LIGHTS.key, GRAPH3D_LIGHTS.fill].reduce((total, light) => {
    const direction = normalizeLightVector(light.direction);
    return direction ? total + light.intensity * Math.abs(dotLightVector(unit, direction)) : total;
  }, 0);
  const lit = (GRAPH3D_LIGHTS.ambient.intensity + diffuse) / GRAPH3D_TOTAL_LIGHT_INTENSITY;
  return Math.min(1, Math.max(0, lit));
}

/**
 * Dash and gap for a coordinate axis, in scene units, or `null` for a solid axis.
 *
 * `length` is the whole drawn axis (both halves): the pattern grows with the figure so a longer
 * axis is not drawn as one long dash.
 */
export function graph3DAxisDashPattern(
  style: Graph3DAxisLineStyle,
  length: number,
): { dashSize: number; gapSize: number } | null {
  if (style === "solid") return null;
  return style === "dotted"
    ? { dashSize: Math.max(0.025, length * 0.006), gapSize: Math.max(0.11, length * 0.028) }
    : { dashSize: Math.max(0.12, length * 0.045), gapSize: Math.max(0.08, length * 0.025) };
}

function dotLightVector(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalizeLightVector(
  vector: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  return magnitude > 1e-9
    ? { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude }
    : null;
}

/**
 * How big an axis end is drawn, in marker units per scene unit.
 *
 * The head is sized off the axis, not off its own marker box, so two shapes with different boxes
 * read as the same size on the figure. `sizeRatio` is what puts the small variants back at their
 * own size: without it, normalising the box would draw every size identically.
 */
export function graph3DAxisEndScale(spec: ArrowheadMarkerSpec, headLength: number): number {
  return (headLength * spec.sizeRatio) / Math.max(spec.markerWidth, spec.markerHeight);
}

/**
 * How much of the axis the head replaces, in marker units.
 *
 * `lineStopX` is where a **stroked** line has to stop so its square end is hidden under the head's
 * own ink. This head has no pen: an open one is drawn as a bare outline and the axis is a hairline,
 * so stopping the axis where a wide line would end leaves a gap in front of it. An open head is
 * closed by the axis running into its vertex, which is where the outline itself meets the axis; a
 * filled one covers whatever runs under it.
 */
export function graph3DAxisEndShaftTrim(spec: ArrowheadMarkerSpec): number {
  const outline = spec.geometry;
  const stopX = outline.kind === "polyline" && !outline.filled
    ? Math.max(...outline.points.map((point) => point.x))
    : spec.lineStopX;
  return Math.max(0, spec.tipX - stopX);
}

/**
 * World-space half-thickness of a dimension line, from its authored `lineWidth`.
 *
 * WebGL ignores `linewidth` on almost every platform, so the three side draws a dimension as a
 * thin cylinder of this radius and the SVG side has to derive its stroke from the same number, or
 * the same figure comes out with differently weighted leader lines in the two renderers.
 */
export function graph3DDimensionRadius(lineWidth: number | undefined): number {
  const width = lineWidth === undefined || !Number.isFinite(lineWidth)
    ? 1.5
    : Math.min(32, Math.max(0.5, lineWidth));
  return Math.max(0.004, width * 0.012);
}

/** Length of a dimension line's end, in world units, for a line of this radius and span. */
export function graph3DDimensionHeadLength(radius: number, total: number): number {
  return Math.min(total * 0.4, radius * 9);
}

/**
 * Dash and gap for a dimension line, in world units, or `null` for a solid one.
 *
 * Mostly fixed rather than proportional to the stroke: tying the dash length to the width made a
 * thick dashed line read as three long bars instead of a dash pattern.
 */
export function graph3DDimensionDashPattern(
  lineStyle: Graph3DAxisLineStyle,
  radius: number,
): { dashSize: number; gapSize: number } | null {
  if (lineStyle === "solid") return null;
  return lineStyle === "dotted"
    ? { dashSize: radius * 1.6, gapSize: 0.06 + radius * 2 }
    : { dashSize: 0.12 + radius * 2, gapSize: 0.08 + radius * 1.5 };
}
