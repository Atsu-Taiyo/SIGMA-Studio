import type { GraphParameter, GraphParameterAnimation } from "./graph-parameter";
/**
 * Engine-neutral mathematical 3D model persisted in SigmaDoc.
 *
 * Expressions are deliberately stored as authored strings. Syntax and numeric
 * evaluation errors are editor diagnostics, not persistence errors, so an
 * unfinished expression is never dropped while the user is typing.
 */
export type Graph3DExpression = string;
export type Graph3DPreset = "revolution" | "surface" | "tricylinder" | "sphereTetrahedron" | "blank";

export interface Graph3DExpressionVector3 {
  x: Graph3DExpression;
  y: Graph3DExpression;
  z: Graph3DExpression;
}

export interface Graph3DNumericVector3 {
  x: number;
  y: number;
  z: number;
}

export interface Graph3DExpressionRange {
  min: Graph3DExpression;
  max: Graph3DExpression;
  samples?: number;
}

export interface Graph3DBounds {
  x: Graph3DExpressionRange;
  y: Graph3DExpressionRange;
  z: Graph3DExpressionRange;
}

export type Graph3DParameter = GraphParameter;
export type Graph3DParameterAnimation = GraphParameterAnimation;

export type Graph3DFillStyle =
  | { mode: "none" }
  | {
      mode: "solid";
      color: string;
      opacity?: number;
    }
  | {
      mode: "pattern";
      color: string;
      opacity?: number;
      pattern: "diagonal" | "cross" | "dots";
    };

export interface Graph3DObjectStyle {
  color?: string;
  opacity?: number;
  wireframe?: boolean;
  wireframeColor?: string;
  fill?: Graph3DFillStyle;
}

interface Graph3DObjectBase {
  id: string;
  name?: string;
  visible?: boolean;
  style?: Graph3DObjectStyle;
  /**
   * Local Euler rotation in radians, applied x→y→z around the object's own centre.
   * Every solid can be turned from its on-figure axes; omitted means no extra turn.
   */
  rotation?: Graph3DExpressionVector3;
  /** Translation in world coordinates, applied after local scale and rotation. */
  translation?: Graph3DExpressionVector3;
  /** Positive scale along the object's local x/y/z axes. */
  scale?: Graph3DExpressionVector3;
}

export interface Graph3DImplicitSurfaceObject extends Graph3DObjectBase {
  kind: "implicitSurface";
  /**
   * The surface's equation, for example `x^2 + y^2 + z^2 = 1`.
   * A form without `=` is read as its zero-level set, so `x^2 + y^2 + z^2 - 1` is the same surface.
   */
  expression: Graph3DExpression;
  bounds: Graph3DBounds;
  resolution?: number;
}

export interface Graph3DParametricCurveObject extends Graph3DObjectBase {
  kind: "parametricCurve";
  x: Graph3DExpression;
  y: Graph3DExpression;
  z: Graph3DExpression;
  parameter: string;
  range: Graph3DExpressionRange;
}

export interface Graph3DParametricSurfaceObject extends Graph3DObjectBase {
  kind: "parametricSurface";
  x: Graph3DExpression;
  y: Graph3DExpression;
  z: Graph3DExpression;
  u: Graph3DExpressionRange;
  v: Graph3DExpressionRange;
}

export interface Graph3DPrimitiveObject extends Graph3DObjectBase {
  kind: "primitive";
  primitive: "sphere" | "cylinder" | "cone" | "box";
  center: Graph3DExpressionVector3;
  /** Local x/y/z extents. Primitive presets translate these to engine geometry. */
  size: Graph3DExpressionVector3;
  /**
   * Segments around a curved primitive. Omitted — the normal case — means the count follows the
   * radius, so a sphere stays as smooth when it is made bigger. A box ignores it.
   */
  resolution?: number;
}

/**
 * A custom rotation axis defined as the intersection of two affine planes.
 * For example, `x = y` and `z = 0` intersect in the line `(t, t, 0)`.
 */
export interface Graph3DPlaneIntersectionAxis {
  kind: "planeIntersection";
  equations: [Graph3DExpression, Graph3DExpression];
  /** Parameter used by the radius expression and the authored axis range. */
  parameter?: string;
}

export type Graph3DRevolutionAxis = "x" | "y" | "z" | Graph3DPlaneIntersectionAxis;

export interface Graph3DSolidOfRevolutionObject extends Graph3DObjectBase {
  kind: "solidOfRevolution";
  axis: Graph3DRevolutionAxis;
  radius: Graph3DExpression;
  axisRange: Graph3DExpressionRange;
  angleRange?: Graph3DExpressionRange;
  capped?: boolean;
}

export interface Graph3DPolyhedronObject extends Graph3DObjectBase {
  kind: "polyhedron";
  vertices: Graph3DExpressionVector3[];
  /** Each face stores zero-based indices into `vertices`. */
  faces: number[][];
}

export interface Graph3DBoundedSolidObject extends Graph3DObjectBase {
  kind: "boundedSolid";
  /** Inequalities such as `x >= 0` and `x + y + z <= 1`. */
  inequalities: Graph3DExpression[];
  bounds: Graph3DBounds;
  resolution?: number;
}

export interface Graph3DPointObject extends Graph3DObjectBase {
  kind: "point";
  position: Graph3DExpressionVector3;
  radius?: number;
}

export interface Graph3DSegmentObject extends Graph3DObjectBase {
  kind: "segment";
  from: Graph3DExpressionVector3;
  to: Graph3DExpressionVector3;
}

export interface Graph3DPlaneObject extends Graph3DObjectBase {
  kind: "plane";
  plane: Graph3DPlaneDefinition;
  size?: Graph3DExpressionVector3;
}

export type Graph3DObject =
  | Graph3DImplicitSurfaceObject
  | Graph3DParametricCurveObject
  | Graph3DParametricSurfaceObject
  | Graph3DPrimitiveObject
  | Graph3DSolidOfRevolutionObject
  | Graph3DPolyhedronObject
  | Graph3DBoundedSolidObject
  | Graph3DPointObject
  | Graph3DSegmentObject
  | Graph3DPlaneObject;

export type Graph3DPlaneDefinition =
  | {
      kind: "equation";
      /** Affine equation such as `x + y = 1` or `z = s`. */
      expression: Graph3DExpression;
    }
  | {
      kind: "threePoints";
      points: [Graph3DExpressionVector3, Graph3DExpressionVector3, Graph3DExpressionVector3];
    }
  | {
      kind: "pointNormal";
      point: Graph3DExpressionVector3;
      normal: Graph3DExpressionVector3;
    };

export type Graph3DSectionOverlapMode = "add" | "subtract";

export interface Graph3DSectionDisplay {
  showInScene?: boolean;
  showFlattened2D?: boolean;
  fill?: Graph3DFillStyle;
  lineColor?: string;
  lineWidth?: number;
  /** How later target-object sections combine with the first section in flattened views. */
  overlapMode?: Graph3DSectionOverlapMode;
}

export interface Graph3DSectionTrail {
  parameterId: string;
  samples: number;
  color?: string;
  opacity?: number;
}

export interface Graph3DCut {
  id: string;
  label?: string;
  /** An empty list means all visible objects. */
  targetObjectIds: string[];
  plane: Graph3DPlaneDefinition;
  visible?: boolean;
  showPlane?: boolean;
  showContour?: boolean;
  section?: Graph3DSectionDisplay;
  trail?: Graph3DSectionTrail;
}

/**
 * The part two or more objects have in common, drawn in its own colour.
 *
 * This is not a cut: nothing is sliced away. The shared part is whatever dimension the members
 * leave — a volume between solids, a flat area once one member is a plane, a piece of a shell that
 * has no inside of its own, a line where two planes meet, a single point where three do. An empty
 * common part is a legitimate answer and simply draws nothing.
 */
export interface Graph3DObjectIntersectionRegion {
  id: string;
  kind: "objectIntersection";
  label?: string;
  /** Two or more object ids. Fewer than two has nothing in common to draw. */
  objectIds: string[];
  fill: Graph3DFillStyle;
  visible?: boolean;
  /** Grid density used when the shared volume has to be sampled. */
  resolution?: number;
  showEdges?: boolean;
  edgeColor?: string;
}

export type Graph3DRegion =
  | {
      id: string;
      kind: "section";
      cutId: string;
      fill: Graph3DFillStyle;
    }
  | {
      id: string;
      kind: "inequality";
      inequalities: Graph3DExpression[];
      bounds: Graph3DBounds;
      fill: Graph3DFillStyle;
    }
  | Graph3DObjectIntersectionRegion;

/** Stroke pattern shared by dimension lines. */
export type Graph3DLineStyle = "solid" | "dashed" | "dotted";

/**
 * Ends of a dimension line. Same table as coordinate axes, so the picker and the drawing
 * share one set of heads. `"tick"` is the older name for `"bar"` and is still read from saved documents.
 */
export type Graph3DDimensionEndStyle = Graph3DAxisEndStyle | "tick";

export function resolveGraph3DDimensionEndStyle(
  endStyle: Graph3DDimensionEndStyle | undefined,
): Graph3DAxisEndStyle {
  if (endStyle === "tick") return "bar";
  return endStyle ?? "arrow";
}

export type Graph3DAnnotation =
  | {
      id: string;
      kind: "label";
      position: Graph3DExpressionVector3;
      labelTex: string;
      color?: string;
    }
  | {
      id: string;
      kind: "dimension";
      from: Graph3DExpressionVector3;
      to: Graph3DExpressionVector3;
      labelTex: string;
      color?: string;
      /** Omitted means `solid`. */
      lineStyle?: Graph3DLineStyle;
      /** Drawn thickness on the same scale as a section contour. Omitted means 1.5. */
      lineWidth?: number;
      /** Omitted means `arrow`. */
      endStyle?: Graph3DDimensionEndStyle;
    };

export interface Graph3DCamera {
  projection: "perspective" | "orthographic";
  position: Graph3DNumericVector3;
  target: Graph3DNumericVector3;
  up: Graph3DNumericVector3;
  fov?: number;
  zoom?: number;
}

/** Per-axis drawing colour. Axis labels take the same colour as their axis. */
export interface Graph3DAxisColors {
  x: string;
  y: string;
  z: string;
}

/** Stroke pattern used by all three coordinate axes. */
export type Graph3DAxisLineStyle = "solid" | "dashed" | "dotted";

/**
 * Positive-end decoration used by all three coordinate axes.
 *
 * The names are the overlay endpoint heads: an axis end and a line end are drawn from one table of
 * outlines (`ARROWHEAD_MARKER_SPECS`), so the two lists have to hold the same names.
 */
export const GRAPH3D_AXIS_END_STYLES = [
  "none",
  "arrow",
  "triangle",
  "openArrow",
  "thinArrow",
  "diamond",
  "dot",
  "bar",
  "arrowSmall",
  "triangleSmall",
  "openArrowSmall",
  "thinArrowSmall",
  "diamondSmall",
  "dotSmall",
  "barSmall",
] as const;
export type Graph3DAxisEndStyle = (typeof GRAPH3D_AXIS_END_STYLES)[number];

export interface Graph3DViewSettings {
  /** Mathematical coordinates are canonical and z-up; renderers adapt as needed. */
  coordinateSystem: "zUp";
  showAxes: boolean;
  showGrid: boolean;
  backgroundColor: string;
  showAxisLabels?: boolean;
  /** Omitted means `DEFAULT_GRAPH3D_AXIS_COLORS`. */
  axisColors?: Graph3DAxisColors;
  /** Omitted means `solid`. */
  axisLineStyle?: Graph3DAxisLineStyle;
  /** Omitted means `arrow`. */
  axisEndStyle?: Graph3DAxisEndStyle;
  shadows?: boolean;
}

/** Textbook convention: x warm, y green, z blue. */
export const DEFAULT_GRAPH3D_AXIS_COLORS: Graph3DAxisColors = {
  x: "#d14343",
  y: "#2f855a",
  z: "#2563eb",
};

export function getGraph3DAxisColors(view: Graph3DViewSettings): Graph3DAxisColors {
  const colors = view.axisColors;
  if (!colors) return DEFAULT_GRAPH3D_AXIS_COLORS;
  return {
    x: colors.x || DEFAULT_GRAPH3D_AXIS_COLORS.x,
    y: colors.y || DEFAULT_GRAPH3D_AXIS_COLORS.y,
    z: colors.z || DEFAULT_GRAPH3D_AXIS_COLORS.z,
  };
}

export interface Graph3DSpec {
  version: 1;
  parameters: Graph3DParameter[];
  objects: Graph3DObject[];
  cuts: Graph3DCut[];
  regions: Graph3DRegion[];
  annotations: Graph3DAnnotation[];
  camera: Graph3DCamera;
  view: Graph3DViewSettings;
}
